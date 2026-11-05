import {
  type OrchestrationThread,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { CompletionRepository } from "./completionRepository.ts";
import { summarizeWaitThreadText } from "./threadSummary.ts";

import { routerResultFallback, type RouterResult } from "../router/RouterPresentation.ts";

interface CompletionDeliveryDependencies {
  readonly presentRouterResult?: (
    source: OrchestrationThread,
    request: string,
    result: RouterResult,
  ) => Effect.Effect<string, Error>;
  readonly repository: CompletionRepository;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
}

/** Re-read durable state on every pass; no in-memory terminal-event ownership. */
export const deliverGatewayCompletions = (dependencies: CompletionDeliveryDependencies) =>
  Effect.gen(function* () {
    const { repository, snapshotQuery, projectionTurns, orchestrationEngine } = dependencies;
    yield* Effect.forEach(
      yield* repository.pending(),
      (row) =>
        Effect.gen(function* () {
          const childThreadId = ThreadId.makeUnsafe(row.childThreadId);
          // Session settlement precedes buffered assistant finalization. Wait for
          // ingestion's durable acknowledgement before reading the final response.
          if (row.resultJson === null && !(yield* repository.isOutputSettled(row.childThreadId)))
            return;
          const child = Option.getOrUndefined(
            yield* snapshotQuery.getThreadShellById(childThreadId),
          );
          let resultJson = row.resultJson;
          if (resultJson === null) {
            const turns = yield* projectionTurns.listByThreadId({ threadId: childThreadId });
            // The initial message owns the run, never whichever turn is latest at poll time.
            const turn = turns.find(
              (entry) => entry.pendingMessageId === row.initialMessageId && entry.turnId !== null,
            );
            const failure = turn
              ? null
              : yield* repository.initialFailure(row.childThreadId, row.initialMessageId);
            const failedBeforeStart = failure !== null;
            if (
              child &&
              !failedBeforeStart &&
              (!turn || !["completed", "error", "interrupted"].includes(turn.state))
            )
              return;
            if (
              turn?.state === "completed" &&
              turn.turnId &&
              !(yield* repository.hasCompletedRun(row.childThreadId, turn.turnId))
            )
              return;
            const goalUnsupported = yield* repository.hasGoalHistory(
              row.childThreadId,
              turn?.completedAt ?? failure?.completedAt ?? new Date().toISOString(),
            );
            const detail = child
              ? Option.getOrUndefined(yield* snapshotQuery.getThreadDetailById(childThreadId))
              : undefined;
            const finalText = detail?.messages.findLast(
              (message) =>
                message.role === "assistant" &&
                turn?.turnId != null &&
                message.turnId === turn.turnId,
            )?.text;
            const summary = summarizeWaitThreadText(finalText);
            const error = goalUnsupported
              ? "Completion delivery does not support goals. This is not a goal-completion notification; read the child for its current progress."
              : !child
                ? "Child task was deleted."
                : turn?.state === "error" || failedBeforeStart
                  ? (failure?.error ??
                    (child.latestTurn?.turnId === turn?.turnId ? child.session?.lastError : null) ??
                    (failure && failure.status !== "error"
                      ? "Initial run interrupted before provider start."
                      : "Initial run failed."))
                  : null;
            const result = {
              childThreadId: row.childThreadId,
              initialMessageId: row.initialMessageId,
              completedAt: turn?.completedAt ?? failure?.completedAt ?? new Date().toISOString(),
              runId: turn?.turnId ?? null,
              status: goalUnsupported
                ? "error"
                : child
                  ? (turn?.state ??
                    (failure && failure.status !== "error" ? "interrupted" : "error"))
                  : "interrupted",
              provider: child?.modelSelection.provider ?? null,
              model: child?.modelSelection.model ?? null,
              summary: summary.summary,
              summaryTruncated: summary.truncated,
              error: error?.slice(0, 2000) ?? null,
              errorTruncated: (error?.length ?? 0) > 2000,
              readThread: {
                tool: "synara_read_thread",
                arguments: { threadId: row.childThreadId },
              },
            };
            let userReply: string | undefined;
            if (child?.creationSource === "router") {
              const source = Option.getOrUndefined(
                yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(row.creatorThreadId)),
              );
              const evidence = { ...result, summary: finalText ?? null, summaryTruncated: false };
              const request =
                detail?.messages.find((message) => message.id === row.initialMessageId)?.text ??
                child.title;
              userReply =
                source &&
                !source.deletedAt &&
                !source.archivedAt &&
                dependencies.presentRouterResult
                  ? yield* dependencies.presentRouterResult(source, request, evidence)
                  : routerResultFallback(evidence);
            }
            // Freeze presentation together with evidence before any message or activity dispatch.
            resultJson = JSON.stringify({
              ...result,
              ...(userReply !== undefined ? { userReply } : {}),
            });
            yield* repository.saveResult(row.childThreadId, resultJson);
          }
          const result = JSON.parse(resultJson) as {
            status: string;
            userReply?: string;
            completedAt?: string;
            summary: string | null;
            error: string | null;
          };
          const payload = {
            ...JSON.parse(resultJson),
            detail: `Child: ${row.childThreadId}\n${result.error ?? result.summary ?? "No final response."}\nFull result: synara_read_thread(${row.childThreadId})`,
          };
          const parentId = ThreadId.makeUnsafe(row.creatorThreadId);
          const parent = Option.getOrUndefined(yield* snapshotQuery.getThreadShellById(parentId));
          const available = parent !== undefined && parent.archivedAt == null;
          // Command receipts fingerprint the entire intent, including timestamps.
          // Replays must use the frozen result's timestamp, never the current clock.
          const createdAt = result.completedAt ?? row.createdAt;
          if (available) {
            // The decider checks archive state inside the command queue too.
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`gateway-completion:${row.childThreadId}`),
              threadId: parentId,
              requireUnarchived: true,
              activity: {
                id: EventId.makeUnsafe(`gateway-completion:${row.childThreadId}`),
                kind: "synara.task.completed",
                tone: result.status === "error" ? "error" : "info",
                summary: `Delegated task ${result.status}`,
                payload,
                turnId: null,
                createdAt,
              },
              createdAt,
            });
          }
          if (available && child?.creationSource === "router") {
            yield* orchestrationEngine.dispatch({
              type: "thread.messages.import",
              commandId: CommandId.makeUnsafe(`router-completion:${row.childThreadId}`),
              threadId: parentId,
              createdAt,
              messages: [
                {
                  messageId: MessageId.makeUnsafe(`router-completion:${row.childThreadId}`),
                  role: "assistant",
                  text:
                    result.userReply ??
                    `任务 [${row.childThreadId}](/tasks?thread=${encodeURIComponent(row.childThreadId)}) ${result.status}。\n${result.error ?? result.summary ?? "执行器没有提供最终回复。"}`,
                  createdAt,
                  updatedAt: createdAt,
                },
              ],
            });
          }
          if (!available && child) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(
                `gateway-completion-unavailable:${row.childThreadId}`,
              ),
              threadId: childThreadId,
              activity: {
                id: EventId.makeUnsafe(`gateway-completion-unavailable:${row.childThreadId}`),
                kind: "synara.task.delivery-unavailable",
                tone: "info",
                summary: "Completion delivery unavailable: creator was archived or deleted",
                payload,
                turnId: null,
                createdAt,
              },
              createdAt,
            });
          }
          yield* repository.delivered(row.childThreadId, available);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("gateway completion delivery will retry", {
              childThreadId: row.childThreadId,
              error,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
