/**
 * ProviderRuntimeReconcilerLive - Repairs live runtime/projection divergence.
 *
 * This is the same-process counterpart to startupTurnReconciliation. It uses
 * Adapter sessions as live evidence and always settles ambiguous missing-event
 * cases as interrupted rather than inventing successful completion.
 *
 * @module ProviderRuntimeReconcilerLive
 */
import {
  CommandId,
  EventId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../../orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildStalePendingRequestSettlementCommand,
  pendingInteractionRequestKind,
} from "../../orchestration/stalePendingInteractions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import {
  bindingActiveTurnId,
  DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS,
  planProviderRuntimeReconciliation,
  type ProviderRuntimeReconciliationPlan,
} from "../providerRuntimeReconciliation.ts";
import {
  ProviderRuntimeReconciler,
  type ProviderRuntimeReconcilerShape,
} from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILIATION_CANDIDATE_LIMIT = 256;

export interface ProviderRuntimeReconcilerLiveOptions {
  readonly intervalMs?: number;
  readonly staleAfterMs?: number;
  readonly candidateLimit?: number;
}

function reconciliationKey(plan: ProviderRuntimeReconciliationPlan): string {
  // A stale turn can move through multiple settlement plans while the session
  // and turn projections converge. Those are retries/refinements of one
  // recovery, not separate user-visible recoveries. Runtime realignment stays
  // distinct because each live runtime turn is independent evidence.
  const operation = plan.action === "align-running-turn" ? plan.action : "settle-running-turn";
  return `provider-runtime-reconcile:${JSON.stringify([
    plan.provider,
    operation,
    plan.threadId,
    plan.projectedTurnId,
    plan.runtimeTurnId,
  ])}`;
}

const make = (options?: ProviderRuntimeReconcilerLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const orchestrationReactor = yield* OrchestrationReactor;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEvents = yield* ProviderRuntimeEventRepository;
    const pendingInteractions = yield* ProjectionPendingInteractionRepository;
    const intervalMs = Math.max(
      250,
      Math.floor(options?.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS),
    );
    const staleAfterMs = Math.max(
      1,
      Math.floor(options?.staleAfterMs ?? DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS),
    );
    const candidateLimit = Math.max(
      1,
      Math.min(
        1_000,
        Math.floor(options?.candidateLimit ?? DEFAULT_RECONCILIATION_CANDIDATE_LIMIT),
      ),
    );

    /** Compares everything that constitutes a repair; `updatedAt` always moves. */
    const isSameProjectedSession = (
      current: OrchestrationSession | null,
      next: OrchestrationSession,
    ): boolean =>
      current !== null &&
      current.status === next.status &&
      current.providerName === next.providerName &&
      current.runtimeMode === next.runtimeMode &&
      current.activeTurnId === next.activeTurnId &&
      current.lastError === next.lastError;

    /**
     * Settles the human requests a settled turn can no longer answer.
     *
     * The provider callback behind an approval or question lives in the
     * runtime. Once this reconciler settles the turn, the runtime's own
     * terminal events are missing by definition, so nothing else would close
     * the durable row: the question card stayed up and every answer failed as
     * stale. Only act on evidence that the callback is gone. A live session
     * that is still running or connecting may yet deliver an answer; a settled
     * (`ready`/`closed`/`error`) session no longer owns the settled turn; and
     * a missing session owns no callback at all, whatever turn it came from.
     */
    const settleUnanswerablePendingInteractions = Effect.fnUntraced(function* (input: {
      readonly plan: ProviderRuntimeReconciliationPlan;
      readonly key: string;
      readonly liveSession: ProviderSession | undefined;
      readonly now: string;
    }) {
      const { plan, liveSession } = input;
      if (plan.action === "align-running-turn") return;
      if (liveSession?.status === "running" || liveSession?.status === "connecting") return;
      const rows = yield* pendingInteractions.listUnsettled({ threadId: plan.threadId });
      for (const row of rows) {
        if (
          liveSession !== undefined &&
          (plan.projectedTurnId === null || row.turnId !== plan.projectedTurnId)
        ) {
          continue;
        }
        const requestKind = pendingInteractionRequestKind(row.interactionKind);
        yield* orchestrationEngine.dispatch(
          buildStalePendingRequestSettlementCommand({
            threadId: plan.threadId,
            // Stable per repair and request, so a retried tick deduplicates.
            commandId: CommandId.makeUnsafe(
              `${input.key}:stale-pending-${requestKind}:${row.requestId}`,
            ),
            requestKind,
            requestId: row.requestId,
            lifecycleGeneration: row.lifecycleGeneration,
            now: input.now,
          }),
        );
      }
    });

    const applyPlan = Effect.fnUntraced(function* (input: {
      readonly plan: ProviderRuntimeReconciliationPlan;
      readonly thread: OrchestrationThreadShell;
      readonly binding: ProviderRuntimeBinding | undefined;
      readonly liveSession: ProviderSession | undefined;
      readonly now: string;
    }) {
      const { plan, thread, now } = input;
      const runtimeMode = thread.session?.runtimeMode ?? thread.runtimeMode;
      const session: OrchestrationSession = {
        threadId: plan.threadId,
        status:
          plan.action === "align-running-turn"
            ? "running"
            : plan.action === "settle-error"
              ? "error"
              : plan.action === "settle-terminal-projection"
                ? plan.terminalSession.status
                : "interrupted",
        providerName:
          plan.action === "settle-terminal-projection"
            ? plan.terminalSession.providerName
            : plan.provider,
        runtimeMode:
          plan.action === "settle-terminal-projection"
            ? plan.terminalSession.runtimeMode
            : runtimeMode,
        activeTurnId:
          plan.action === "align-running-turn"
            ? plan.runtimeTurnId
            : plan.action === "settle-error"
              ? plan.projectedTurnId
              : plan.action === "settle-terminal-projection" &&
                  plan.terminalSession.status === "error"
                ? plan.terminalSession.activeTurnId
                : null,
        lastError:
          plan.action === "settle-error"
            ? plan.errorMessage
            : plan.action === "settle-terminal-projection"
              ? plan.terminalSession.lastError
              : null,
        // Always `now`. Replaying a terminal session's original timestamp keeps
        // the staleness clock frozen, so the same repair is replanned forever.
        updatedAt: now,
      };

      // Nothing left to repair: the projected session already matches the plan
      // and no turn is left running. Dispatching anyway writes two fresh events
      // on every tick for as long as the thread stays a candidate.
      if (
        thread.latestTurn?.state !== "running" &&
        isSameProjectedSession(thread.session, session)
      ) {
        return;
      }

      const key = reconciliationKey(plan);
      // Command ids identify attempts because timestamps can legitimately
      // change between retries. The activity id identifies the semantic repair,
      // allowing projectors to suppress a repeated visible recovery while a
      // failed or lagging session update remains safe to retry.
      const attemptKey = `${key}:${crypto.randomUUID()}`;
      // Session first: it is the repair. If only one of the two lands, it must
      // be the one that unsticks the thread, not the note explaining it.
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`${attemptKey}:session`),
        threadId: plan.threadId,
        session,
        createdAt: now,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`${attemptKey}:activity`),
        threadId: plan.threadId,
        activity: {
          id: EventId.makeUnsafe(`${key}:activity`),
          tone: "info",
          kind: "provider.runtime.reconciled",
          summary:
            plan.action === "align-running-turn"
              ? "Metis realigned the active provider turn"
              : "Metis recovered a stale running state",
          payload: {
            provider: plan.provider,
            action: plan.action,
            reason: plan.reason,
            projectedTurnId: plan.projectedTurnId,
            runtimeTurnId: plan.runtimeTurnId,
          },
          turnId: plan.projectedTurnId,
          createdAt: now,
        },
        createdAt: now,
      });

      yield* settleUnanswerablePendingInteractions({
        plan,
        key,
        liveSession: input.liveSession,
        now,
      });

      // The durable binding still advertises the turn that was just settled,
      // which keeps the thread a reconciliation candidate forever. Only merge
      // into an existing row: an upsert would otherwise resurrect a binding for
      // a thread that no longer has one.
      if (
        input.binding !== undefined &&
        session.activeTurnId === null &&
        bindingActiveTurnId(input.binding) !== null
      ) {
        yield* directory.upsert({
          threadId: plan.threadId,
          provider: input.binding.provider,
          runtimePayload: { activeTurnId: null },
        });
      }
    });

    const reconcileNow = Effect.gen(function* () {
      const nowMs = Date.now();
      const staleThreadIds = yield* projectionSnapshotQuery.listStaleInFlightThreadIds({
        updatedBefore: new Date(nowMs - staleAfterMs).toISOString(),
        limit: candidateLimit,
      });
      const blockedRecovery = new Set(
        yield* providerService.listPersistentRecoveryBlockedThreadIds?.() ?? Effect.succeed([]),
      );
      const candidateThreadIds = staleThreadIds.filter(
        (threadId) => !blockedRecovery.has(threadId),
      );
      if (candidateThreadIds.length === 0) return;
      const [bindings, liveSessions, pumpHealth, runtimeJournalLagging] = yield* Effect.all(
        [
          directory.listBindings(),
          providerService.listSessions(),
          providerService.getRuntimeEventPumpHealth?.() ?? Effect.succeed([]),
          runtimeEvents.hasPendingEventsForThreads({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            threadIds: candidateThreadIds,
          }),
        ],
        { concurrency: 4 },
      );
      // One batched read instead of up to `candidateLimit` point reads
      // contending on the single SQLite handle every reconciliation tick.
      const threads = yield* projectionSnapshotQuery.getThreadShellsByIds(candidateThreadIds);
      const threadById = new Map(threads.map((thread) => [thread.id, thread]));
      const bindingByThreadId = new Map(bindings.map((binding) => [binding.threadId, binding]));
      const liveSessionByThreadId = new Map(
        liveSessions.map((session) => [session.threadId, session]),
      );
      const plans = planProviderRuntimeReconciliation({
        threads,
        bindings,
        liveSessions,
        pumpHealth,
        runtimeJournalLagging,
        nowMs,
        staleAfterMs,
      });
      if (plans.length === 0) return;

      const now = new Date().toISOString();
      yield* Effect.logWarning("provider.runtime_reconciliation.started", {
        planCount: plans.length,
        threadIds: plans.map((plan) => plan.threadId),
      });
      yield* Effect.forEach(
        plans,
        (plan) => {
          const thread = threadById.get(plan.threadId);
          if (!thread) return Effect.void;
          return applyPlan({
            plan,
            thread,
            binding: bindingByThreadId.get(plan.threadId),
            liveSession: liveSessionByThreadId.get(plan.threadId),
            now,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.runtime_reconciliation.plan_failed", {
                threadId: plan.threadId,
                provider: plan.provider,
                action: plan.action,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: 1, discard: true },
      );
      yield* orchestrationReactor.reconcileSettledOpenTurns;
    });

    const reconcileSafely = reconcileNow.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider.runtime_reconciliation.failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

    const start = () =>
      Effect.forkScoped(
        reconcileSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
      ).pipe(Effect.asVoid);

    return { reconcileNow, start } satisfies ProviderRuntimeReconcilerShape;
  });

export const makeProviderRuntimeReconcilerLive = (options?: ProviderRuntimeReconcilerLiveOptions) =>
  Layer.effect(ProviderRuntimeReconciler, make(options));

export const ProviderRuntimeReconcilerLive = makeProviderRuntimeReconcilerLive();
