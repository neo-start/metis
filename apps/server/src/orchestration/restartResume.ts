/**
 * restartResume - continue chats that were still running when the previous
 * server process stopped without the desktop quit dialog recording them.
 *
 * The quit dialog path (`quitResume.ts`) only covers quits the renderer
 * mediates. Crashes, `kill -9`, OS logout/reboot, backend restarts, the desktop
 * update install (`autoUpdater.quitAndInstall` stops the backend directly) and
 * `app.relaunch` paths, and dev-server restarts all leave in-flight chats
 * behind with nobody to continue them. Two sources find those chats:
 *
 *  - Boot orphans: turns still "running" in durable state after an unclean exit.
 *    `reconcileRestartStuckTurns` captures them *before* it terminalizes them.
 *  - Shutdown snapshot: a graceful shutdown (SIGTERM from the desktop, Ctrl-C)
 *    stops provider sessions, whose terminal events settle the turns durably,
 *    so the next boot would see nothing. The server therefore writes the chats
 *    in flight at the start of shutdown to `restart-resume.json`, which the next
 *    boot claims (atomic rename, like the quit-resume record).
 *    Verified independent hosts and fenced host recovery are excluded: a
 *    backend restart does not authorize a second prompt into those sessions.
 *
 * At boot, with the server setting `resumeChatsAfterRestart` on, each candidate
 * gets one continuation turn built by the same planner as quit-resume
 * (`planResumeTurn`: live thread/project, not archived, nothing in flight, no
 * turn completed on its own since the capture; the decider re-checks the
 * precondition atomically). Candidates are skipped when:
 *
 *  - the claimed quit-resume record already covers the thread (no double turn);
 *  - the turn was waiting on an approval or user-input answer - only the human
 *    can answer, and reconciliation fails those requests, so a blind "continue"
 *    would at best re-ask and at worst act without the answer;
 *  - the newest turn intent on the thread is an interrupt request (the user, or
 *    a quit without resume, asked it to stop before the process went away);
 *  - the thread is an automation run (its reactor recovers runs itself) or a
 *    provider-native subagent child (its parent's continuation drives it);
 *  - the crash-loop guard trips (below), or the per-boot cap is reached.
 *
 * Crash-loop guard: `restart-resume-ledger.json` counts automatic continuations
 * per thread. A continuation made within `RESTART_RESUME_STREAK_WINDOW_MS` of the
 * previous one for the same thread extends its streak; after
 * `RESTART_RESUME_MAX_CONSECUTIVE` continuations in a row were themselves cut off
 * by a restart, the thread is left interrupted for the user. The ledger is
 * written before any dispatch (a failed write dispatches nothing), and entries
 * are dropped once a thread is found settled at boot or the window has passed.
 *
 * @module restartResume
 */
import type {
  OrchestrationEvent,
  OrchestrationThread,
  ThreadId as ThreadIdType,
} from "@synara/contracts";
import { persistentSessionThreadIds } from "../provider/persistentSessionRecovery.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  QUIT_RESUME_MAX_THREADS,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@synara/contracts";
import { Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { writeFileStringAtomically } from "../atomicWrite";
import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { threadHasInFlightTurn } from "./commandInvariants.ts";
import {
  claimStateFile,
  liveResumeProjectIds,
  planResumeTurn,
  type QuitResumeProject,
  type QuitResumeRecordRead,
  type QuitResumeSkipReason,
  type QuitResumeThread,
  type ThreadTurnStartCommand,
} from "./quitResume.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

/** Consecutive automatic continuations per thread before the crash-loop guard stops. */
export const RESTART_RESUME_MAX_CONSECUTIVE = 3;
/** A continuation within this long of the previous one for the same thread extends its streak. */
export const RESTART_RESUME_STREAK_WINDOW_MS = 30 * 60_000;

export const RESTART_RESUME_CONTINUATION_PROMPT =
  "The app restarted while this chat was still running. Continue where you left off.";

export const RestartResumeCandidate = Schema.Struct({
  threadId: ThreadId,
  /** The turn in flight at capture; null while the provider was still connecting. */
  turnId: Schema.NullOr(TurnId),
  /** An approval or user-input request was open on the thread at capture. */
  hadPendingRequest: Schema.Boolean,
});
export type RestartResumeCandidate = typeof RestartResumeCandidate.Type;

/** Chats in flight at one capture point (a boot, or the start of a graceful shutdown). */
export const RestartResumeCapture = Schema.Struct({
  version: Schema.Literal(1),
  /** Unique per capture; continuation command ids derive from it. */
  recordId: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  threads: Schema.Array(RestartResumeCandidate).check(Schema.isMaxLength(QUIT_RESUME_MAX_THREADS)),
});
export type RestartResumeCapture = typeof RestartResumeCapture.Type;

export const RestartResumeLedger = Schema.Struct({
  version: Schema.Literal(1),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** Automatic continuations in a row, each within the streak window of the previous. */
      streak: NonNegativeInt,
      lastResumedAt: IsoDateTime,
    }),
  ),
});
export type RestartResumeLedger = typeof RestartResumeLedger.Type;

export const EMPTY_RESTART_RESUME_LEDGER: RestartResumeLedger = { version: 1, threads: [] };

const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(RestartResumeCapture));
const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(RestartResumeLedger));

/** Read-model fields the capture inspects (a superset is fine). */
export type RestartResumeCapturableThread = Pick<
  OrchestrationThread,
  "id" | "deletedAt" | "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/** Read-model fields the boot planner inspects (a superset is fine). */
export type RestartResumeThread = QuitResumeThread & Pick<OrchestrationThread, "creationSource">;

export type RestartResumeSkipReason =
  | QuitResumeSkipReason
  | "covered-by-quit-resume"
  | "pending-request"
  | "interrupt-requested"
  | "automation-run"
  | "subagent-thread"
  | "crash-loop-guard"
  | "over-limit";

export interface RestartResumePlan {
  readonly commands: ReadonlyArray<ThreadTurnStartCommand>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: ThreadIdType;
    readonly reason: RestartResumeSkipReason;
  }>;
  /** Ledger to persist before dispatching `commands`. */
  readonly ledger: RestartResumeLedger;
}

/**
 * Pure: the threads whose turn is genuinely in flight (a settled session that
 * only kept a dangling active-turn pointer is not), in read-model order, capped.
 */
export function captureRestartResumeCandidates(input: {
  readonly threads: ReadonlyArray<RestartResumeCapturableThread>;
  /** Threads with unsettled durable approval/user-input rows. */
  readonly threadIdsWithUnsettledRequests?: ReadonlySet<string>;
}): ReadonlyArray<RestartResumeCandidate> {
  const candidates: RestartResumeCandidate[] = [];
  for (const thread of input.threads) {
    if (candidates.length >= QUIT_RESUME_MAX_THREADS) {
      break;
    }
    if (thread.deletedAt != null || !threadHasInFlightTurn(thread)) {
      continue;
    }
    candidates.push({
      threadId: thread.id,
      turnId:
        thread.session?.activeTurnId ??
        (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null),
      hadPendingRequest:
        thread.hasPendingApprovals === true ||
        thread.hasPendingUserInput === true ||
        input.threadIdsWithUnsettledRequests?.has(thread.id) === true,
    });
  }
  return candidates;
}

/** Event types that express what someone last asked a thread's turn to do. */
export const RESTART_RESUME_TURN_INTENT_EVENT_TYPES = [
  "thread.turn-start-requested",
  "thread.turn-queued",
  "thread.turn-interrupt-requested",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

/**
 * Pure: given a thread's newest turn-intent events (newest first), true when the
 * last thing anyone asked for was to stop the turn. A steer emits its queued
 * message and an interrupt under one command id; that is a redirect, not a stop.
 */
export function newestTurnIntentIsStop(
  newestFirst: ReadonlyArray<Pick<OrchestrationEvent, "type" | "commandId">>,
): boolean {
  const newest = newestFirst[0];
  if (!newest || newest.type !== "thread.turn-interrupt-requested") {
    return false;
  }
  return !newestFirst.some(
    (event) =>
      event.type === "thread.turn-queued" &&
      event.commandId !== null &&
      event.commandId === newest.commandId,
  );
}

/** Reads the thread's newest turn intents from the durable event log. */
export const readNewestTurnIntentIsStop = (
  threadId: ThreadIdType,
): Effect.Effect<boolean, unknown, OrchestrationEventStore> =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const events = yield* eventStore.readThreadEvents({
      threadId,
      throughSequenceInclusive: Number.MAX_SAFE_INTEGER,
      limit: 4,
      eventTypes: RESTART_RESUME_TURN_INTENT_EVENT_TYPES,
    });
    return newestTurnIntentIsStop(events);
  });

/**
 * Pure boot planner. `captures` are processed in order and the first capture of
 * a thread wins (pass the shutdown snapshot before the boot orphans: its
 * earlier timestamp makes the "completed since" check stricter); pending-request
 * flags are unioned. `stoppedThreadIds` are threads whose newest turn intent was
 * an interrupt request.
 */
export function planRestartResumeTurns(input: {
  readonly captures: ReadonlyArray<RestartResumeCapture>;
  readonly quitResumeThreadIds: ReadonlySet<string>;
  readonly stoppedThreadIds: ReadonlySet<string>;
  readonly ledger: RestartResumeLedger;
  readonly threads: ReadonlyArray<RestartResumeThread>;
  readonly projects: ReadonlyArray<QuitResumeProject>;
  readonly now: string;
  readonly maxThreads?: number;
}): RestartResumePlan {
  const merged = new Map<
    string,
    { recordId: string; recordedAt: string; candidate: RestartResumeCandidate }
  >();
  for (const capture of input.captures) {
    for (const candidate of capture.threads) {
      const existing = merged.get(candidate.threadId);
      if (existing) {
        if (candidate.hadPendingRequest && !existing.candidate.hadPendingRequest) {
          existing.candidate = { ...existing.candidate, hadPendingRequest: true };
        }
        continue;
      }
      merged.set(candidate.threadId, {
        recordId: capture.recordId,
        recordedAt: capture.recordedAt,
        candidate,
      });
    }
  }

  const nowMs = Date.parse(input.now);
  const withinStreakWindow = (lastResumedAt: string) =>
    nowMs - Date.parse(lastResumedAt) < RESTART_RESUME_STREAK_WINDOW_MS;
  // A thread absent from this boot's candidates settled after its continuation
  // (completed, errored, or stopped); a stale entry says nothing about a loop.
  const ledgerByThread = new Map(
    input.ledger.threads
      .filter((entry) => merged.has(entry.threadId) && withinStreakWindow(entry.lastResumedAt))
      .map((entry) => [entry.threadId as string, entry] as const),
  );

  const threadsById = new Map(
    input.threads.map((thread) => [thread.id as string, thread] as const),
  );
  const liveProjectIds = liveResumeProjectIds(input.projects);
  const maxThreads = input.maxThreads ?? QUIT_RESUME_MAX_THREADS;
  const commands: ThreadTurnStartCommand[] = [];
  const skipped: Array<{ threadId: ThreadIdType; reason: RestartResumeSkipReason }> = [];

  for (const { recordId, recordedAt, candidate } of merged.values()) {
    const skip = (reason: RestartResumeSkipReason) => {
      skipped.push({ threadId: candidate.threadId, reason });
    };
    if (input.quitResumeThreadIds.has(candidate.threadId)) {
      skip("covered-by-quit-resume");
      continue;
    }
    if (candidate.hadPendingRequest) {
      skip("pending-request");
      continue;
    }
    if (input.stoppedThreadIds.has(candidate.threadId)) {
      skip("interrupt-requested");
      continue;
    }
    const thread = threadsById.get(candidate.threadId);
    if (thread?.creationSource === "automation_run") {
      skip("automation-run");
      continue;
    }
    if (thread?.creationSource === "provider_native") {
      skip("subagent-thread");
      continue;
    }
    const planned = planResumeTurn({
      commandKey: `restart-resume:${recordId}:${candidate.threadId}`,
      threadId: candidate.threadId,
      thread,
      liveProjectIds,
      resumePrecondition: { recordedTurnId: candidate.turnId, recordedAt },
      continuationPrompt: RESTART_RESUME_CONTINUATION_PROMPT,
      now: input.now,
    });
    if (planned.kind === "skip") {
      skip(planned.reason);
      continue;
    }
    const streak = ledgerByThread.get(candidate.threadId)?.streak ?? 0;
    if (streak >= RESTART_RESUME_MAX_CONSECUTIVE) {
      skip("crash-loop-guard");
      continue;
    }
    if (commands.length >= maxThreads) {
      skip("over-limit");
      continue;
    }
    commands.push(planned.command);
    ledgerByThread.set(candidate.threadId, {
      threadId: candidate.threadId,
      streak: streak + 1,
      lastResumedAt: input.now,
    });
  }

  return {
    commands,
    skipped,
    ledger: { version: 1, threads: [...ledgerByThread.values()] },
  };
}

export type RestartResumeCaptureRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "capture"; readonly capture: RestartResumeCapture };

const decodeCaptureContents = (raw: string): Effect.Effect<RestartResumeCaptureRead> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.succeed({ kind: "invalid" } as const);
  }
  return decodeCapture(trimmed).pipe(
    Effect.map((capture) => ({ kind: "capture", capture }) as const),
    Effect.orElseSucceed(() => ({ kind: "invalid" }) as const),
  );
};

/** Consume the shutdown snapshot at `path` (atomic rename; see `claimStateFile`). */
export const claimRestartResumeSnapshot = (
  path: string,
): Effect.Effect<RestartResumeCaptureRead, never, FileSystem.FileSystem> =>
  claimStateFile(path, "restart-resume snapshot").pipe(
    Effect.flatMap((claimed) =>
      claimed.kind === "absent"
        ? Effect.succeed({ kind: "absent" } as const)
        : decodeCaptureContents(claimed.contents),
    ),
  );

export const readRestartResumeLedger = (
  path: string,
): Effect.Effect<RestartResumeLedger, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return EMPTY_RESTART_RESUME_LEDGER;
    }
    const raw = (yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))).trim();
    if (raw.length === 0) {
      return EMPTY_RESTART_RESUME_LEDGER;
    }
    return yield* decodeLedger(raw).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("ignoring an unreadable restart-resume ledger", { path, cause }).pipe(
          Effect.as(EMPTY_RESTART_RESUME_LEDGER),
        ),
      ),
    );
  });

export const persistRestartResumeLedger = (input: {
  readonly path: string;
  readonly ledger: RestartResumeLedger;
}) =>
  input.ledger.threads.length === 0
    ? Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(input.path, { force: true });
      })
    : writeFileStringAtomically({
        filePath: input.path,
        contents: `${JSON.stringify(input.ledger)}\n`,
      });

/**
 * Shutdown finalizer: remember the chats in flight right now, before provider
 * teardown settles their turns. Never fails; bounded so shutdown is not held up.
 */
export const recordRestartResumeSnapshotAtShutdown: Effect.Effect<
  void,
  never,
  ServerConfig | FileSystem.FileSystem | OrchestrationEngineService
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const readModel = yield* engine.getReadModel();
  const persistentThreadIds = yield* persistentSessionThreadIds;
  const threads = captureRestartResumeCandidates({
    threads: readModel.threads.filter((thread) => !persistentThreadIds.has(thread.id)),
  });
  if (threads.length === 0) {
    return;
  }
  const capture: RestartResumeCapture = {
    version: 1,
    recordId: randomUUID(),
    recordedAt: new Date().toISOString(),
    threads,
  };
  yield* writeFileStringAtomically({
    filePath: config.restartResumeStatePath,
    contents: `${JSON.stringify(capture)}\n`,
  });
  yield* Effect.logInfo("recorded running chats for resume after restart", {
    recordId: capture.recordId,
    threadIds: threads.map((entry) => entry.threadId),
  });
}).pipe(
  Effect.timeout("3 seconds"),
  Effect.catchCause((cause) =>
    Effect.logWarning("recording running chats at shutdown failed", { cause }),
  ),
);

/**
 * Boot-time claim of the shutdown snapshot. Must run before commands are
 * admitted, like the quit-resume claim. Never fails.
 */
export const claimRestartResumeSnapshotAtStartup: Effect.Effect<
  RestartResumeCaptureRead,
  never,
  ServerConfig | FileSystem.FileSystem
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const claimed = yield* claimRestartResumeSnapshot(config.restartResumeStatePath);
  if (claimed.kind === "invalid") {
    yield* Effect.logWarning("dropped an unreadable restart-resume snapshot", {
      path: config.restartResumeStatePath,
    });
  }
  return claimed;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("claiming the restart-resume snapshot failed", { cause }).pipe(
      Effect.as({ kind: "absent" } as const),
    ),
  ),
);

/**
 * Boot-time consumer. Runs once, after restart reconciliation settled the
 * orphans and after the quit-resume continuation. Every failure is contained
 * and logged - resuming must never affect server startup.
 */
export const resumeRestartInterruptedChats = (input: {
  /** Chats found in flight at boot, captured before reconciliation settled them. */
  readonly bootOrphans: RestartResumeCapture | null;
  readonly snapshot: RestartResumeCaptureRead;
  readonly quitResume: QuitResumeRecordRead;
  /** True when the newest turn intent on the thread is an interrupt request. */
  readonly newestTurnIntentIsStop: (threadId: ThreadIdType) => Effect.Effect<boolean, unknown>;
}): Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ServerConfig | ServerSettingsService | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const captures: RestartResumeCapture[] = [];
    const persistentThreadIds = yield* persistentSessionThreadIds;
    if (input.snapshot.kind === "capture") {
      captures.push({
        ...input.snapshot.capture,
        threads: input.snapshot.capture.threads.filter(
          (thread) => !persistentThreadIds.has(thread.threadId),
        ),
      });
    }
    if (input.bootOrphans && input.bootOrphans.threads.length > 0) {
      captures.push({
        ...input.bootOrphans,
        threads: input.bootOrphans.threads.filter(
          (thread) => !persistentThreadIds.has(thread.threadId),
        ),
      });
    }
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    if (captures.length === 0) {
      // Nothing was cut off: any ledger entry belongs to a chat that settled.
      const hasLedger = yield* fs
        .exists(config.restartResumeLedgerPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (hasLedger) {
        yield* persistRestartResumeLedger({
          path: config.restartResumeLedgerPath,
          ledger: EMPTY_RESTART_RESUME_LEDGER,
        });
      }
      return;
    }

    const candidateThreadIds = [
      ...new Set(captures.flatMap((capture) => capture.threads.map((entry) => entry.threadId))),
    ];
    const serverSettings = yield* ServerSettingsService;
    const enabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.resumeChatsAfterRestart),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read the resume-after-restart setting; using default", {
          cause,
        }).pipe(Effect.as(true)),
      ),
    );
    if (!enabled) {
      yield* Effect.logInfo("resume after restart is off; leaving interrupted chats as they are", {
        threadIds: candidateThreadIds,
      });
      return;
    }

    const quitResumeThreadIds = new Set<string>(
      input.quitResume.kind === "record"
        ? input.quitResume.record.threads.map((entry) => entry.threadId)
        : [],
    );
    const stopFlags = yield* Effect.forEach(
      candidateThreadIds.filter((threadId) => !quitResumeThreadIds.has(threadId)),
      (threadId) =>
        input.newestTurnIntentIsStop(threadId).pipe(
          Effect.map((stopped) => [threadId, stopped] as const),
          Effect.catchCause((cause) =>
            // Unknown intent: stay on the side of not sending an unwanted message.
            Effect.logWarning("could not read turn intents; not resuming this chat", {
              threadId,
              cause,
            }).pipe(Effect.as([threadId, true] as const)),
          ),
        ),
      { concurrency: 4 },
    );
    const stoppedThreadIds = new Set<string>(
      stopFlags.filter(([, stopped]) => stopped).map(([threadId]) => threadId),
    );

    const engine = yield* OrchestrationEngineService;
    const readModel = yield* engine.getReadModel();
    const ledger = yield* readRestartResumeLedger(config.restartResumeLedgerPath);
    const plan = planRestartResumeTurns({
      captures,
      quitResumeThreadIds,
      stoppedThreadIds,
      ledger,
      threads: readModel.threads,
      projects: readModel.projects,
      now: new Date().toISOString(),
    });

    if (plan.skipped.length > 0) {
      yield* Effect.logInfo("not resuming some chats interrupted by the restart", {
        skipped: plan.skipped,
      });
    }

    // The guard only holds if it is durable before the turn can take the process
    // down again: no ledger, no continuation.
    const ledgerWritten = yield* persistRestartResumeLedger({
      path: config.restartResumeLedgerPath,
      ledger: plan.ledger,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not write the restart-resume ledger; not resuming chats", {
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!ledgerWritten || plan.commands.length === 0) {
      return;
    }

    yield* Effect.logInfo("resuming chats interrupted by the restart", {
      threadIds: plan.commands.map((command) => command.threadId),
    });
    yield* Effect.forEach(
      plan.commands,
      (command) =>
        engine.dispatch(command).pipe(
          Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
            Effect.logInfo("restart-resume turn was not accepted", {
              threadId: command.threadId,
              detail: error.detail,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("restart-resume turn failed to dispatch", {
              threadId: command.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("resuming chats after restart failed", { cause }),
    ),
  );
