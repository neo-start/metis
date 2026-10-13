import {
  ApprovalRequestId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type ProviderSession,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../../orchestration/Services/OrchestrationReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteraction,
  type ProjectionPendingInteractionRepositoryShape,
} from "../../persistence/Services/ProjectionPendingInteractions.ts";
import {
  ProviderRuntimeEventRepository,
  type ProviderRuntimeEventRepositoryShape,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeReconciler } from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderRuntimeReconcilerLive } from "./ProviderRuntimeReconciler.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-reconciler");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-reconciler");

function staleShellSnapshot(): OrchestrationShellSnapshot {
  const updatedAt = "2026-07-23T19:00:00.000Z";
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-runtime-reconciler"),
        runtimeMode: "full-access",
        updatedAt,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: updatedAt,
          startedAt: updatedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt,
        },
      },
    ],
    updatedAt,
  } as unknown as OrchestrationShellSnapshot;
}

function readyProviderSession(): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
  };
}

function noPendingInteractions(): ProjectionPendingInteractionRepositoryShape {
  return {
    listUnsettled: () => Effect.succeed([]),
  } as unknown as ProjectionPendingInteractionRepositoryShape;
}

function unsettledInteraction(
  overrides: Partial<ProjectionPendingInteraction> &
    Pick<ProjectionPendingInteraction, "interactionKind" | "requestId">,
): ProjectionPendingInteraction {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    lifecycleGeneration: "generation-1",
    status: "pending",
    decision: null,
    responseCommandId: null,
    responseRequestedAt: null,
    createdAt: "2026-07-23T19:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

/** Runs one reconciliation of the stale shell against the given runtime evidence. */
async function reconcileStaleTurn(input: {
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly unsettled: ReadonlyArray<ProjectionPendingInteraction>;
  readonly hasPendingUserInput?: boolean;
}): Promise<OrchestrationCommand[]> {
  const commands: OrchestrationCommand[] = [];
  const thread = {
    ...staleShellSnapshot().threads[0]!,
    ...(input.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: input.hasPendingUserInput }
      : {}),
  };
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  const reactor = {
    start: Effect.void,
    reconcileSettledOpenTurns: Effect.void,
  } satisfies OrchestrationReactorShape;
  const snapshotQuery = {
    listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
    getThreadShellsByIds: () => Effect.succeed([thread]),
  } as unknown as ProjectionSnapshotQueryShape;
  const directory = {
    listBindings: () =>
      Effect.succeed([
        {
          threadId: THREAD_ID,
          provider: "codex" as const,
          status: "running" as const,
          runtimePayload: { activeTurnId: TURN_ID },
        },
      ]),
    upsert: () => Effect.void,
  } as unknown as ProviderSessionDirectoryShape;
  const provider = {
    listSessions: () => Effect.succeed(input.liveSessions),
    getRuntimeEventPumpHealth: () => Effect.succeed([]),
  } as unknown as ProviderServiceShape;
  const runtimeEvents = {
    hasPendingEventsForThreads: () => Effect.succeed(false),
  } as unknown as ProviderRuntimeEventRepositoryShape;
  const pendingInteractions = {
    listUnsettled: (request: { readonly threadId?: string }) =>
      Effect.sync(() => {
        expect(request.threadId).toBe(THREAD_ID);
        return input.unsettled;
      }),
  } as unknown as ProjectionPendingInteractionRepositoryShape;

  const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
    Layer.provide(Layer.succeed(ProviderService, provider)),
    Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    Layer.provide(Layer.succeed(ProjectionPendingInteractionRepository, pendingInteractions)),
  );
  await Effect.gen(function* () {
    const reconciler = yield* ProviderRuntimeReconciler;
    yield* reconciler.reconcileNow;
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return commands;
}

function staleSettlements(commands: ReadonlyArray<OrchestrationCommand>) {
  return commands.flatMap((command) =>
    command.type === "thread.activity.append" &&
    (command.activity.kind === "provider.user-input.respond.failed" ||
      command.activity.kind === "provider.approval.respond.failed")
      ? [command]
      : [],
  );
}

describe("ProviderRuntimeReconcilerLive pending interactions", () => {
  const questionOnSettledTurn = unsettledInteraction({
    interactionKind: "userInput",
    requestId: ApprovalRequestId.makeUnsafe("question-on-settled-turn"),
  });
  const approvalOnOtherTurn = unsettledInteraction({
    interactionKind: "approval",
    requestId: ApprovalRequestId.makeUnsafe("approval-on-other-turn"),
    turnId: TurnId.makeUnsafe("turn-other"),
  });

  it("expires the settled turn's questions once the live session has settled", async () => {
    const commands = await reconcileStaleTurn({
      liveSessions: [readyProviderSession()],
      unsettled: [questionOnSettledTurn, approvalOnOtherTurn],
    });

    const settlements = staleSettlements(commands);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.activity.kind).toBe("provider.user-input.respond.failed");
    expect(settlements[0]?.activity.payload).toMatchObject({
      requestId: "question-on-settled-turn",
      lifecycleGeneration: "generation-1",
      detail: expect.stringContaining("Stale pending user-input request: question-on-settled-turn"),
    });
    // The repair lands first; the settlement id is stable per repair and request.
    expect(commands.map((command) => command.type).slice(0, 2)).toEqual([
      "thread.session.set",
      "thread.activity.append",
    ]);
    expect(String(settlements[0]?.commandId)).toMatch(
      /^provider-runtime-reconcile:.*:stale-pending-user-input:question-on-settled-turn$/,
    );
  });

  it("expires every request when no live session owns a callback", async () => {
    const commands = await reconcileStaleTurn({
      liveSessions: [],
      unsettled: [questionOnSettledTurn, approvalOnOtherTurn],
    });

    expect(
      staleSettlements(commands).map(
        (command) => (command.activity.payload as { readonly requestId?: unknown }).requestId,
      ),
    ).toEqual(["question-on-settled-turn", "approval-on-other-turn"]);
  });

  it("leaves a running session that is waiting for the user alone", async () => {
    const commands = await reconcileStaleTurn({
      liveSessions: [
        {
          ...readyProviderSession(),
          status: "running",
          // Old enough to trip the abandoned-turn clock.
          updatedAt: "2026-07-23T19:00:00.000Z",
        },
      ],
      unsettled: [questionOnSettledTurn],
      hasPendingUserInput: true,
    });

    expect(commands).toEqual([]);
  });
});

describe("ProviderRuntimeReconcilerLive", () => {
  it("keeps one activity identity while a stale-turn repair is retried and refined", async () => {
    const commands: OrchestrationCommand[] = [];
    const reconcileSettledOpenTurns = vi.fn();
    let bindingStatus: "stopped" | "error" = "stopped";
    let providerSession = readyProviderSession();

    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.sync(reconcileSettledOpenTurns),
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellById: () => Effect.succeed(Option.some(staleShellSnapshot().threads[0]!)),
      getThreadShellsByIds: () => Effect.succeed([staleShellSnapshot().threads[0]!]),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            status: bindingStatus,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      listSessions: () => Effect.succeed([providerSession]),
      getRuntimeEventPumpHealth: () =>
        Effect.succeed([
          {
            provider: "codex" as const,
            status: "recovering" as const,
            consecutiveFailures: 1,
            updatedAt: "2026-07-23T20:00:00.000Z",
          },
        ]),
    } as unknown as ProviderServiceShape;

    const runtimeEvents = {
      hasPendingEventsForThreads: (input: { readonly threadIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          expect(input.threadIds).toEqual([THREAD_ID]);
          return false;
        }),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
      Layer.provide(Layer.succeed(ProjectionPendingInteractionRepository, noPendingInteractions())),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      yield* reconciler.reconcileNow;
      // The projection can remain stale for another observation cycle.
      yield* reconciler.reconcileNow;
      bindingStatus = "error";
      providerSession = {
        ...providerSession,
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      };
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    // Session repair dispatches first so a partial failure still unsticks the
    // thread, and `updatedAt` is the dispatch time rather than the terminal
    // session's original timestamp (which would freeze the staleness clock).
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
    ]);
    const activityCommand = commands[1];
    expect(activityCommand?.type).toBe("thread.activity.append");
    if (activityCommand?.type === "thread.activity.append") {
      expect(activityCommand.activity.kind).toBe("provider.runtime.reconciled");
      expect(activityCommand.activity.summary).toContain("recovered");
      expect(activityCommand.activity.payload).toMatchObject({
        action: "settle-terminal-projection",
      });
    }
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
      });
      expect(sessionCommand.session.updatedAt).not.toBe("2026-07-23T19:00:00.000Z");
    }
    const errorActivityCommand = commands[5];
    expect(errorActivityCommand?.type).toBe("thread.activity.append");
    if (errorActivityCommand?.type === "thread.activity.append") {
      expect(errorActivityCommand.activity.payload).toMatchObject({
        action: "settle-error",
      });
    }
    const errorSessionCommand = commands[4];
    expect(errorSessionCommand?.type).toBe("thread.session.set");
    if (errorSessionCommand?.type === "thread.session.set") {
      expect(errorSessionCommand.session).toMatchObject({
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      });
    }
    const activityCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
        command.type === "thread.activity.append",
    );
    const sessionCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.session.set" }> =>
        command.type === "thread.session.set",
    );
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[1]?.activity.id);
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[2]?.activity.id);
    expect(activityCommands[0]?.commandId).not.toBe(activityCommands[1]?.commandId);
    expect(activityCommands[1]?.commandId).not.toBe(activityCommands[2]?.commandId);
    expect(sessionCommands[0]?.commandId).not.toBe(sessionCommands[1]?.commandId);
    expect(sessionCommands[1]?.commandId).not.toBe(sessionCommands[2]?.commandId);
    expect(reconcileSettledOpenTurns).toHaveBeenCalledTimes(3);
  });
});
