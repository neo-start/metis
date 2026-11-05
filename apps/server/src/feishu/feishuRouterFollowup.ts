import { ThreadId, type OrchestrationCommand, type OrchestrationThread } from "@synara/contracts";
import { routerResultFallback, type RouterResult } from "../router/RouterPresentation.ts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";

/** Resolve this correction's durable turn, never the worker's latest unrelated reply. */
export async function readFeishuFollowup(
  workerId: string,
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  host: {
    readThread(id: ThreadId): Promise<OrchestrationThread | undefined>;
    turns(id: ThreadId): Promise<ReadonlyArray<ProjectionTurn>>;
    isOutputSettled(id: string): Promise<boolean>;
    hasCompletedRun(id: string, turnId: string): Promise<boolean>;
  },
): Promise<string | undefined> {
  const id = ThreadId.makeUnsafe(workerId);
  const worker = await host.readThread(id);
  if (
    !worker ||
    worker.deletedAt ||
    worker.archivedAt ||
    worker.creationSource !== "router" ||
    worker.sourceThreadId !== command.threadId
  )
    return;
  const input = worker.messages.find((message) => message.id === command.message.messageId);
  if (!input || input.role !== "user") return;
  const turns = await host.turns(id);
  const turn =
    turns.find((entry) => entry.pendingMessageId === input.id) ??
    turns.find((entry) => input.turnId !== null && entry.turnId === input.turnId);
  if (!turn || !turn.turnId || !["completed", "error", "interrupted"].includes(turn.state)) return;
  if (!(await host.isOutputSettled(id))) return;
  if (turn.state === "completed" && !(await host.hasCompletedRun(id, turn.turnId))) return;
  // Re-read after the ingestion barrier: buffered final text may just have settled.
  const detail = await host.readThread(id);
  if (!detail || detail.deletedAt || detail.archivedAt) return;
  const answer = detail.messages.findLast(
    (message) =>
      message.role === "assistant" && message.turnId === turn.turnId && !message.streaming,
  );
  const result: RouterResult = {
    status: turn.state,
    summary: answer?.text ?? null,
    error:
      turn.state === "error" && detail.latestTurn?.turnId === turn.turnId
        ? (detail.session?.lastError ?? null)
        : null,
  };
  return routerResultFallback(result);
}
