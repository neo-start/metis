/**
 * handoffContinuation - keep working after a provider switch without being asked.
 *
 * A handoff copies the transcript into a new thread for another provider. When
 * the source chat was cut off mid-work (its newest turn ended "interrupted",
 * which is how the composer's provider switch stops it), the user expects the
 * new provider to just carry on. This module decides that and builds the one
 * continuation turn; the reactor dispatches it when the handoff thread is
 * created. A handoff from a settled chat (last turn completed, failed, or never
 * ran) gets nothing: there is nothing to continue and the user will type.
 *
 * The turn is an ordinary queued user turn on the new thread's own settings,
 * the same shape restart-resume uses, so the handoff bootstrap wraps it like any
 * first message and the transcript shows why the provider started on its own.
 *
 * @module orchestration/handoffContinuation
 */
import type {
  OrchestrationLatestTurn,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { CommandId, MessageId } from "@synara/contracts";

export const HANDOFF_CONTINUATION_PROMPT =
  "This chat was handed off to you while the previous provider was still working. Continue where it left off.";

/** Only a chat stopped mid-work has something to pick up. */
export function shouldContinueAfterHandoff(
  sourceThread: { readonly latestTurn: OrchestrationLatestTurn | null } | undefined,
): boolean {
  return sourceThread?.latestTurn?.state === "interrupted";
}

/** Deterministic per created-event so a replayed event collides with the engine's receipt dedup. */
export function buildHandoffContinuationCommand(input: {
  readonly threadId: ThreadId;
  readonly eventId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
}) {
  const key = `server:handoff-continue:${input.eventId}`;
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.makeUnsafe(key),
    threadId: input.threadId,
    message: {
      messageId: MessageId.makeUnsafe(key),
      role: "user" as const,
      text: HANDOFF_CONTINUATION_PROMPT,
      attachments: [],
    },
    dispatchMode: "queue" as const,
    dispatchOrigin: "automation" as const,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: input.createdAt,
  };
}
