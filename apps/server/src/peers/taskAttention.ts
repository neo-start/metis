import {
  UserInputQuestion,
  type OrchestrationThread,
  type PeerTaskAttention,
  type PeerTask,
} from "@synara/contracts";
import {
  createStalePendingInteractionMatcher,
  isPendingInteractionResponseClaimable,
} from "@synara/shared/pendingInteractions";
import { Schema } from "effect";

/** Reuse durable interaction settlement and stale-callback policy; never infer
 * authorization from assistant text or an aggregate waiting flag. */
export function taskAttention(thread: OrchestrationThread): PeerTaskAttention[] {
  const stale = createStalePendingInteractionMatcher(thread.activities);
  return (thread.pendingInteractions ?? []).flatMap((pending) => {
    if (
      pending.threadId !== thread.id ||
      stale(pending) ||
      // Match requireApprovalNotResponded admission, not the broader provider
      // claim/reclaim rule: uncertain and responding approvals need local recovery.
      (pending.interactionKind === "approval" &&
        pending.status !== "pending" &&
        pending.status !== "retryable") ||
      !isPendingInteractionResponseClaimable({
        ...pending,
        requestedAt: new Date().toISOString(),
      })
    )
      return [];
    const activity = thread.activities.findLast((entry) => {
      const payload = entry.payload as Record<string, unknown> | null;
      return (
        entry.kind ===
          (pending.interactionKind === "approval"
            ? "approval.requested"
            : "user-input.requested") &&
        payload?.requestId === pending.requestId &&
        (payload.lifecycleGeneration ?? null) === pending.lifecycleGeneration &&
        entry.createdAt === pending.createdAt
      );
    });
    if (!activity) return [];
    const payload = activity.payload as Record<string, unknown>;
    // Include the actual request context, never hide permission details behind a
    // generic approval button. Oversized/unsupported requests stay local-only.
    const detail = JSON.stringify(payload, null, 2);
    if (detail.length > 16000) return [];
    let questions: PeerTaskAttention["questions"] = [];
    if (pending.interactionKind === "userInput") {
      const decoded = Schema.decodeUnknownOption(Schema.Array(UserInputQuestion))(
        payload.questions,
      );
      if (decoded._tag === "None" || decoded.value.length === 0) return [];
      questions = decoded.value;
    }
    return [
      {
        kind: pending.interactionKind,
        requestId: pending.requestId,
        lifecycleGeneration: pending.lifecycleGeneration,
        responseAttemptId: pending.responseCommandId,
        createdAt: pending.createdAt,
        detail,
        questions,
      },
    ];
  });
}

/** Recovery is presentation only and is never serialized as actionable attention
 * (including for clients that predate the recovery field). */
export function taskLocalRecovery(
  thread: OrchestrationThread,
): NonNullable<PeerTask["localRecovery"]> {
  return (thread.pendingInteractions ?? []).flatMap((pending) =>
    pending.threadId === thread.id &&
    pending.interactionKind === "approval" &&
    pending.resolvedAt === null &&
    (pending.status === "responding" || pending.status === "uncertain")
      ? [{ requestId: pending.requestId, status: pending.status }]
      : [],
  );
}
