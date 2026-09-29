import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import type { QuitResumeRecordRead } from "./quitResume.ts";
import {
  captureRestartResumeCandidates,
  claimRestartResumeSnapshot,
  EMPTY_RESTART_RESUME_LEDGER,
  newestTurnIntentIsStop,
  planRestartResumeTurns,
  readRestartResumeLedger,
  recordRestartResumeSnapshotAtShutdown,
  RESTART_RESUME_CONTINUATION_PROMPT,
  RESTART_RESUME_MAX_CONSECUTIVE,
  RESTART_RESUME_STREAK_WINDOW_MS,
  resumeRestartInterruptedChats,
  type RestartResumeCapture,
  type RestartResumeLedger,
  type RestartResumeThread,
} from "./restartResume.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const CAPTURED_AT = "2026-06-14T10:00:00.000Z";
const SETTLED_AT = "2026-06-14T10:00:00.500Z";
const NOW = "2026-06-14T10:00:05.000Z";
const PROJECT = ProjectId.makeUnsafe("project-1");
const threadId = (id: string) => ThreadId.makeUnsafe(id);
const turnId = (id: string) => TurnId.makeUnsafe(id);

/** A thread as restart reconciliation leaves it: its orphaned turn settled as interrupted. */
const makeSettledThread = (
  id: string,
  overrides: Partial<RestartResumeThread> = {},
): RestartResumeThread => ({
  id: threadId(id),
  projectId: PROJECT,
  deletedAt: null,
  archivedAt: null,
  latestTurn: {
    turnId: turnId(`${id}-turn`),
    state: "interrupted",
    requestedAt: "2026-06-14T09:00:00.000Z",
    startedAt: "2026-06-14T09:00:01.000Z",
    completedAt: SETTLED_AT,
    assistantMessageId: null,
  },
  session: {
    threadId: threadId(id),
    providerName: "codex",
    runtimeMode: "full-access",
    status: "interrupted",
    activeTurnId: null,
    lastError: null,
    updatedAt: SETTLED_AT,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  creationSource: null,
  ...overrides,
});

const makeCapture = (
  recordId: string,
  ids: ReadonlyArray<string | { id: string; hadPendingRequest: boolean }>,
  recordedAt = CAPTURED_AT,
): RestartResumeCapture => ({
  version: 1,
  recordId,
  recordedAt,
  threads: ids.map((entry) => {
    const id = typeof entry === "string" ? entry : entry.id;
    return {
      threadId: threadId(id),
      turnId: turnId(`${id}-turn`),
      hadPendingRequest: typeof entry === "string" ? false : entry.hadPendingRequest,
    };
  }),
});

const plan = (
  overrides: Partial<Parameters<typeof planRestartResumeTurns>[0]> & {
    readonly threads: ReadonlyArray<RestartResumeThread>;
  },
) =>
  planRestartResumeTurns({
    captures: [
      makeCapture(
        "boot-1",
        overrides.threads.map((thread) => thread.id),
      ),
    ],
    quitResumeThreadIds: new Set(),
    stoppedThreadIds: new Set(),
    ledger: EMPTY_RESTART_RESUME_LEDGER,
    projects: [{ id: PROJECT, deletedAt: null }],
    now: NOW,
    ...overrides,
  });

describe("captureRestartResumeCandidates", () => {
  it("keeps only genuinely in-flight threads and flags open human requests", () => {
    const running = makeSettledThread("running", {
      session: {
        ...makeSettledThread("running").session!,
        status: "running",
        activeTurnId: turnId("running-turn"),
      },
    });
    const approval = {
      ...makeSettledThread("approval", {
        latestTurn: {
          ...makeSettledThread("approval").latestTurn!,
          state: "running",
          completedAt: null,
        },
      }),
      hasPendingApprovals: true,
    };
    const unsettled = makeSettledThread("unsettled", {
      session: { ...makeSettledThread("unsettled").session!, status: "starting" },
      latestTurn: null,
    });
    const deleted = makeSettledThread("deleted", {
      deletedAt: CAPTURED_AT,
      session: { ...makeSettledThread("deleted").session!, status: "running" },
    });
    const idle = makeSettledThread("idle");

    expect(
      captureRestartResumeCandidates({
        threads: [running, approval, unsettled, deleted, idle],
        threadIdsWithUnsettledRequests: new Set(["unsettled"]),
      }),
    ).toEqual([
      { threadId: threadId("running"), turnId: turnId("running-turn"), hadPendingRequest: false },
      { threadId: threadId("approval"), turnId: turnId("approval-turn"), hadPendingRequest: true },
      { threadId: threadId("unsettled"), turnId: null, hadPendingRequest: true },
    ]);
  });
});

describe("planRestartResumeTurns", () => {
  it("continues an orphaned chat with a deterministic, precondition-guarded turn", () => {
    const result = plan({ threads: [makeSettledThread("a")] });

    expect(result.skipped).toEqual([]);
    expect(result.commands).toEqual([
      {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("restart-resume:boot-1:a"),
        threadId: threadId("a"),
        message: {
          messageId: "restart-resume:boot-1:a",
          role: "user",
          text: RESTART_RESUME_CONTINUATION_PROMPT,
          attachments: [],
        },
        dispatchMode: "queue",
        dispatchOrigin: "automation",
        runtimeMode: "full-access",
        interactionMode: "default",
        resumePrecondition: { recordedTurnId: turnId("a-turn"), recordedAt: CAPTURED_AT },
        createdAt: NOW,
      },
    ]);
    expect(result.ledger).toEqual({
      version: 1,
      threads: [{ threadId: threadId("a"), streak: 1, lastResumedAt: NOW }],
    });
  });

  it("never doubles a chat the claimed quit-resume record already continues", () => {
    const result = plan({
      threads: [makeSettledThread("quit"), makeSettledThread("crash")],
      quitResumeThreadIds: new Set(["quit"]),
    });
    expect(result.commands.map((command) => command.threadId)).toEqual([threadId("crash")]);
    expect(result.skipped).toEqual([
      { threadId: threadId("quit"), reason: "covered-by-quit-resume" },
    ]);
  });

  it("merges the shutdown snapshot and boot orphans once per thread, first capture winning", () => {
    const result = plan({
      threads: [makeSettledThread("a"), makeSettledThread("b")],
      captures: [
        makeCapture("shutdown-1", ["a"], "2026-06-14T09:59:00.000Z"),
        makeCapture("boot-1", [{ id: "a", hadPendingRequest: true }, "b"]),
      ],
    });
    // "a" inherits the boot capture's pending flag even though the snapshot wins.
    expect(result.commands.map((command) => command.commandId)).toEqual([
      CommandId.makeUnsafe("restart-resume:boot-1:b"),
    ]);
    expect(result.skipped).toEqual([{ threadId: threadId("a"), reason: "pending-request" }]);
  });

  it("leaves chats that were waiting on a human answer, stopped by request, or owned elsewhere", () => {
    const result = plan({
      threads: [
        makeSettledThread("approval"),
        makeSettledThread("stopped"),
        makeSettledThread("automation", { creationSource: "automation_run" }),
        makeSettledThread("child", { creationSource: "provider_native" }),
        makeSettledThread("archived", { archivedAt: SETTLED_AT }),
        makeSettledThread("finished", {
          latestTurn: { ...makeSettledThread("finished").latestTurn!, state: "completed" },
        }),
      ],
      captures: [
        makeCapture("boot-1", [
          { id: "approval", hadPendingRequest: true },
          "stopped",
          "automation",
          "child",
          "archived",
          "finished",
          "missing",
        ]),
      ],
      stoppedThreadIds: new Set(["stopped"]),
    });
    expect(result.commands).toEqual([]);
    expect(result.skipped).toEqual([
      { threadId: threadId("approval"), reason: "pending-request" },
      { threadId: threadId("stopped"), reason: "interrupt-requested" },
      { threadId: threadId("automation"), reason: "automation-run" },
      { threadId: threadId("child"), reason: "subagent-thread" },
      { threadId: threadId("archived"), reason: "thread-archived" },
      { threadId: threadId("finished"), reason: "turn-completed" },
      { threadId: threadId("missing"), reason: "thread-missing" },
    ]);
    expect(result.ledger.threads).toEqual([]);
  });

  it("stops after the consecutive cap inside the streak window and forgets old or settled streaks", () => {
    const recent = new Date(Date.parse(NOW) - 60_000).toISOString();
    const old = new Date(Date.parse(NOW) - RESTART_RESUME_STREAK_WINDOW_MS - 1).toISOString();
    const ledger: RestartResumeLedger = {
      version: 1,
      threads: [
        {
          threadId: threadId("looping"),
          streak: RESTART_RESUME_MAX_CONSECUTIVE,
          lastResumedAt: recent,
        },
        { threadId: threadId("again"), streak: 1, lastResumedAt: recent },
        { threadId: threadId("slow"), streak: RESTART_RESUME_MAX_CONSECUTIVE, lastResumedAt: old },
        { threadId: threadId("settled"), streak: 2, lastResumedAt: recent },
      ],
    };
    const result = plan({
      threads: [
        makeSettledThread("looping"),
        makeSettledThread("again"),
        makeSettledThread("slow"),
      ],
      ledger,
    });

    expect(result.commands.map((command) => command.threadId)).toEqual([
      threadId("again"),
      threadId("slow"),
    ]);
    expect(result.skipped).toEqual([{ threadId: threadId("looping"), reason: "crash-loop-guard" }]);
    expect(result.ledger.threads).toEqual([
      {
        threadId: threadId("looping"),
        streak: RESTART_RESUME_MAX_CONSECUTIVE,
        lastResumedAt: recent,
      },
      { threadId: threadId("again"), streak: 2, lastResumedAt: NOW },
      { threadId: threadId("slow"), streak: 1, lastResumedAt: NOW },
    ]);
  });

  it("caps the number of continuations per boot", () => {
    const result = plan({
      threads: [makeSettledThread("a"), makeSettledThread("b")],
      maxThreads: 1,
    });
    expect(result.commands.map((command) => command.threadId)).toEqual([threadId("a")]);
    expect(result.skipped).toEqual([{ threadId: threadId("b"), reason: "over-limit" }]);
  });
});

describe("newestTurnIntentIsStop", () => {
  const event = (type: OrchestrationEvent["type"], commandId: string) => ({
    type,
    commandId: CommandId.makeUnsafe(commandId),
  });

  it("is a stop only when the newest intent is a plain interrupt request", () => {
    expect(newestTurnIntentIsStop([])).toBe(false);
    expect(
      newestTurnIntentIsStop([
        event("thread.turn-interrupt-requested", "stop"),
        event("thread.turn-start-requested", "start"),
      ]),
    ).toBe(true);
    expect(
      newestTurnIntentIsStop([
        event("thread.turn-start-requested", "start-2"),
        event("thread.turn-interrupt-requested", "stop"),
      ]),
    ).toBe(false);
    // A steer queues its message and interrupts under one command id.
    expect(
      newestTurnIntentIsStop([
        event("thread.turn-interrupt-requested", "steer"),
        event("thread.turn-queued", "steer"),
      ]),
    ).toBe(false);
  });
});

describe("resumeRestartInterruptedChats", () => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-restart-resume-",
  }).pipe(Layer.provide(NodeServices.layer));
  const testLayer = Layer.merge(NodeServices.layer, serverConfigLayer);

  const runBoots = (input: {
    readonly boots: number;
    readonly enabled: boolean;
    readonly quitResume?: QuitResumeRecordRead;
  }) => {
    const dispatched: OrchestrationCommand[] = [];
    const thread = makeSettledThread("a");
    const engine = {
      getReadModel: () =>
        Effect.succeed({ threads: [thread], projects: [{ id: PROJECT, deletedAt: null }] }),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
        }),
    };
    const settings = {
      getSettings: Effect.succeed({ resumeChatsAfterRestart: input.enabled }),
    };
    return Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const ledgers: RestartResumeLedger[] = [];
        for (let boot = 0; boot < input.boots; boot += 1) {
          yield* resumeRestartInterruptedChats({
            bootOrphans: makeCapture(`boot-${boot}`, ["a"], new Date().toISOString()),
            snapshot: { kind: "absent" },
            quitResume: input.quitResume ?? { kind: "absent" },
            newestTurnIntentIsStop: () => Effect.succeed(false),
          });
          ledgers.push(yield* readRestartResumeLedger(config.restartResumeLedgerPath));
        }
        return { dispatched, ledgers };
      }).pipe(
        Effect.provideService(OrchestrationEngineService, engine as never),
        Effect.provideService(ServerSettingsService, settings as never),
        Effect.provide(testLayer),
      ),
    );
  };

  it("dispatches nothing and leaves no ledger when the setting is off", async () => {
    const result = await runBoots({ boots: 1, enabled: false });
    expect(result.dispatched).toEqual([]);
    expect(result.ledgers).toEqual([EMPTY_RESTART_RESUME_LEDGER]);
  });

  it("stops continuing a chat that keeps getting cut off by restarts", async () => {
    const result = await runBoots({ boots: RESTART_RESUME_MAX_CONSECUTIVE + 2, enabled: true });
    expect(result.dispatched.map((command) => command.commandId)).toEqual(
      Array.from({ length: RESTART_RESUME_MAX_CONSECUTIVE }, (_, boot) =>
        CommandId.makeUnsafe(`restart-resume:boot-${boot}:a`),
      ),
    );
    expect(result.ledgers.map((ledger) => ledger.threads[0]?.streak)).toEqual([
      1,
      2,
      3,
      RESTART_RESUME_MAX_CONSECUTIVE,
      RESTART_RESUME_MAX_CONSECUTIVE,
    ]);
  });

  it("leaves chats covered by the quit-resume record to it", async () => {
    const result = await runBoots({
      boots: 1,
      enabled: true,
      quitResume: {
        kind: "record",
        record: {
          version: 1,
          recordId: "quit-1",
          recordedAt: CAPTURED_AT,
          continuationPrompt: "Continue.",
          threads: [{ threadId: threadId("a"), turnId: turnId("a-turn") }],
        },
      },
    });
    expect(result.dispatched).toEqual([]);
  });

  it("snapshots the chats in flight at shutdown for the next boot", async () => {
    const running = makeSettledThread("running", {
      session: {
        ...makeSettledThread("running").session!,
        status: "running",
        activeTurnId: turnId("running-turn"),
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        yield* recordRestartResumeSnapshotAtShutdown;
        return yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
      }).pipe(
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ threads: [running, makeSettledThread("idle")] }),
        } as never),
        Effect.provide(testLayer),
      ),
    );
    expect(result.kind === "capture" ? result.capture.threads : result).toEqual([
      { threadId: threadId("running"), turnId: turnId("running-turn"), hadPendingRequest: false },
    ]);
  });

  it("claims the shutdown snapshot exactly once", async () => {
    const capture = makeCapture("shutdown-1", ["a"]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(config.restartResumeStatePath, JSON.stringify(capture));
        const first = yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
        const second = yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
        yield* fs.writeFileString(config.restartResumeStatePath, "{not json");
        const corrupt = yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
        const leftover = yield* fs.exists(config.restartResumeStatePath);
        return { first, second, corrupt, leftover };
      }).pipe(Effect.provide(testLayer)),
    );
    expect(result.first).toEqual({ kind: "capture", capture });
    expect(result.second).toEqual({ kind: "absent" });
    expect(result.corrupt).toEqual({ kind: "invalid" });
    expect(result.leftover).toBe(false);
  });
});
