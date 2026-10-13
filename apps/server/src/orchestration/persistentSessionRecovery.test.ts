import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../config";
import { ProjectionPendingInteractionRepository } from "../persistence/Services/ProjectionPendingInteractions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  prepareQuitResume,
  readQuitResumeRecord,
  resumeQuitInterruptedChats,
  type QuitResumeThread,
} from "./quitResume.ts";
import {
  claimRestartResumeSnapshot,
  readRestartResumeLedger,
  recordRestartResumeSnapshotAtShutdown,
  resumeRestartInterruptedChats,
  type RestartResumeCapture,
} from "./restartResume.ts";
import {
  planRestartTurnReconciliation,
  reconcileRestartStuckTurns,
} from "./startupTurnReconciliation.ts";

const NOW = "2026-10-12T10:00:00.000Z";
const PROJECT = ProjectId.makeUnsafe("persistent-recovery-project");
const LIVE = ThreadId.makeUnsafe("adopted");
const ORPHAN = ThreadId.makeUnsafe("orphan");
const projects = [{ id: PROJECT, deletedAt: null }];
const provider = {
  listPersistentSessionThreadIds: () => Effect.succeed([LIVE]),
};

const runningThread = (id: ThreadId): QuitResumeThread => ({
  id,
  projectId: PROJECT,
  deletedAt: null,
  archivedAt: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  session: {
    threadId: id,
    providerName: "codex",
    status: "running",
    runtimeMode: "approval-required",
    activeTurnId: TurnId.makeUnsafe(`${id}-turn`),
    lastError: null,
    updatedAt: NOW,
  },
  latestTurn: {
    turnId: TurnId.makeUnsafe(`${id}-turn`),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
  },
});

const settledThread = (id: ThreadId) => {
  const thread = runningThread(id);
  return {
    ...thread,
    creationSource: null,
    session: { ...thread.session!, status: "interrupted" as const, activeTurnId: null },
    latestTurn: {
      ...thread.latestTurn!,
      state: "interrupted" as const,
      completedAt: "2026-10-12T10:00:01.000Z",
    },
  };
};

const pendingRequests = (threadId: ThreadId) =>
  (["approval", "userInput"] as const).map((interactionKind) => ({
    threadId,
    interactionKind,
    requestId: ApprovalRequestId.makeUnsafe(`${threadId}-${interactionKind}`),
    lifecycleGeneration: `${threadId}-generation`,
    status: "pending" as const,
    createdAt: NOW,
  }));

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "metis-persistent-recovery-",
}).pipe(Layer.provide(NodeServices.layer));
const fileSystemLayer = Layer.merge(NodeServices.layer, serverConfigLayer);

describe("persistent host recovery boundaries", () => {
  it("preserves adopted active turns and human requests while settling ordinary orphans", () => {
    const threads = [LIVE, ORPHAN].map((id) =>
      Object.assign(runningThread(id), { pendingInteractions: pendingRequests(id) }),
    );
    const commands = planRestartTurnReconciliation({
      threads,
      pendingInteractions: threads.flatMap((thread) => thread.pendingInteractions),
      persistentThreadIds: new Set([LIVE]),
      now: NOW,
    });

    expect(commands.map((command) => command.threadId)).toEqual([ORPHAN, ORPHAN, ORPHAN]);
    expect(commands).toMatchObject([
      {
        type: "thread.activity.append",
        activity: {
          kind: "provider.approval.respond.failed",
          payload: { requestId: `${ORPHAN}-approval`, lifecycleGeneration: `${ORPHAN}-generation` },
        },
      },
      {
        type: "thread.activity.append",
        activity: {
          kind: "provider.user-input.respond.failed",
          payload: { requestId: `${ORPHAN}-userInput` },
        },
      },
      { type: "thread.session.set", session: { status: "interrupted", activeTurnId: null } },
    ]);
  });

  it("excludes live hosts from boot orphan capture and never hydrates their requests for cleanup", async () => {
    const threads = [LIVE, ORPHAN].map((id) =>
      Object.assign(runningThread(id), {
        pendingInteractions: pendingRequests(id),
        activities: [],
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    );
    const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.void);
    const getThreadDetailById = vi.fn((id: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === id))),
    );
    const capture = await Effect.runPromise(
      reconcileRestartStuckTurns.pipe(
        Effect.provideService(ProviderService, provider as never),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ threads }),
          dispatch,
        } as never),
        Effect.provideService(ProjectionSnapshotQuery, { getThreadDetailById } as never),
        Effect.provideService(ProjectionPendingInteractionRepository, {
          listUnsettled: () =>
            Effect.succeed(threads.flatMap((thread) => thread.pendingInteractions)),
        } as never),
      ),
    );

    expect(capture?.threads).toEqual([
      { threadId: ORPHAN, turnId: `${ORPHAN}-turn`, hadPendingRequest: true },
    ]);
    expect(getThreadDetailById).toHaveBeenCalledExactlyOnceWith(ORPHAN);
    expect(dispatch).toHaveBeenCalledTimes(3);
    for (const [command] of dispatch.mock.calls) {
      expect(command).toMatchObject({ threadId: ORPHAN });
    }
  });

  it.each(["absent", "legacy", "no-live-host"] as const)(
    "keeps ordinary boot cleanup when the provider service is %s",
    async (mode) => {
      const dispatch = vi.fn(() => Effect.void);
      const recovery = reconcileRestartStuckTurns.pipe(
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ threads: [runningThread(LIVE)] }),
          dispatch,
        } as never),
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadDetailById: () => Effect.succeed(Option.none()),
        } as never),
        Effect.provideService(ProjectionPendingInteractionRepository, {
          listUnsettled: () => Effect.succeed(pendingRequests(LIVE)),
        } as never),
      );
      const capture = await Effect.runPromise(
        mode === "absent"
          ? recovery
          : recovery.pipe(
              Effect.provideService(
                ProviderService,
                (mode === "legacy"
                  ? {}
                  : { listPersistentSessionThreadIds: () => Effect.succeed([]) }) as never,
              ),
            ),
      );

      expect(capture?.threads).toMatchObject([{ threadId: LIVE, hadPendingRequest: true }]);
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "thread.session.set",
          session: expect.objectContaining({ status: "interrupted", activeTurnId: null }),
        }),
      );
    },
  );

  it.each([true, false])(
    "records and interrupts only chats needing quit recovery (live host: %s)",
    async (hasLiveHost) => {
      const dispatched: OrchestrationCommand[] = [];
      const program = Effect.gen(function* () {
        const config = yield* ServerConfig;
        const prepared = yield* prepareQuitResume({
          request: {
            threadIds: [LIVE, ORPHAN],
            continuationPrompt: "Continue the interrupted task.",
          },
          recordPath: config.quitResumeStatePath,
          getReadModel: () =>
            Effect.succeed({ threads: [runningThread(LIVE), runningThread(ORPHAN)] }),
          dispatch: (command) => Effect.sync(() => dispatched.push(command)),
        });
        const persisted = yield* readQuitResumeRecord(config.quitResumeStatePath);
        return { prepared, persisted };
      });
      const result = await Effect.runPromise(
        (hasLiveHost
          ? program.pipe(Effect.provideService(ProviderService, provider as never))
          : program
        ).pipe(Effect.provide(fileSystemLayer)),
      );
      const expectedIds = hasLiveHost ? [ORPHAN] : [LIVE, ORPHAN];
      expect(result.prepared.recordedThreadIds).toEqual(expectedIds);
      expect(result.persisted).toMatchObject({
        kind: "record",
        record: {
          threads: expectedIds.map((threadId) => ({ threadId, turnId: `${threadId}-turn` })),
        },
      });
      await vi.waitFor(() => expect(dispatched).toHaveLength(expectedIds.length));
      expect(dispatched).toMatchObject(
        expectedIds.map((threadId) => ({ type: "thread.turn.interrupt", threadId })),
      );
    },
  );

  it("omits persistent sessions from the durable shutdown snapshot", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        yield* recordRestartResumeSnapshotAtShutdown;
        return yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
      }).pipe(
        Effect.provideService(ProviderService, provider as never),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.succeed({ threads: [runningThread(LIVE), runningThread(ORPHAN)] }),
        } as never),
        Effect.provide(fileSystemLayer),
      ),
    );

    expect(result).toMatchObject({
      kind: "capture",
      capture: {
        threads: [{ threadId: ORPHAN, turnId: `${ORPHAN}-turn`, hadPendingRequest: false }],
      },
    });
  });

  it.each(["quit", "restart"] as const)(
    "does not send an extra %s continuation to an adopted host even if projection state looks interrupted",
    async (kind) => {
      const capture: RestartResumeCapture = {
        version: 1,
        recordId: "previous-process",
        recordedAt: NOW,
        threads: [LIVE, ORPHAN].map((threadId) => ({
          threadId,
          turnId: TurnId.makeUnsafe(`${threadId}-turn`),
          hadPendingRequest: false,
        })),
      };
      const dispatched: OrchestrationCommand[] = [];
      const newestTurnIntentIsStop = vi.fn(() => Effect.succeed(false));
      const program = Effect.gen(function* () {
        if (kind === "quit") {
          yield* resumeQuitInterruptedChats({
            kind: "record",
            record: { ...capture, continuationPrompt: "Continue the interrupted task." },
          });
        } else {
          yield* resumeRestartInterruptedChats({
            bootOrphans: capture,
            snapshot: { kind: "capture", capture },
            quitResume: { kind: "absent" },
            newestTurnIntentIsStop,
          });
        }
        const config = yield* ServerConfig;
        return yield* readRestartResumeLedger(config.restartResumeLedgerPath);
      });
      const ledger = await Effect.runPromise(
        program.pipe(
          Effect.provideService(ProviderService, provider as never),
          Effect.provideService(OrchestrationEngineService, {
            getReadModel: () =>
              Effect.succeed({ threads: [settledThread(LIVE), settledThread(ORPHAN)], projects }),
            dispatch: (command: OrchestrationCommand) =>
              Effect.sync(() => dispatched.push(command)),
          } as never),
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.succeed({ resumeChatsAfterRestart: true }),
          } as never),
          Effect.provide(fileSystemLayer),
        ),
      );

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ type: "thread.turn.start", threadId: ORPHAN });
      if (kind === "restart") {
        expect(newestTurnIntentIsStop).toHaveBeenCalledExactlyOnceWith(ORPHAN);
        expect(ledger.threads.map((entry) => entry.threadId)).toEqual([ORPHAN]);
      }
    },
  );
});
