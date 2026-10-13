// FILE: pendingInteractions.ts
// Purpose: Shared policy for claiming responses and recognizing invalidated approval/user-input callbacks.
// Layer: Cross-package orchestration utility
// Exports: stale-callback matcher, reclaim timing, response-status predicates, and expired-answer follow-up formatting.

import type {
  OrchestrationPendingInteraction,
  OrchestrationThreadActivity,
} from "@synara/contracts";
import { isStalePendingRequestFailureDetail, pendingRequestInstanceKey } from "./threadSummary";

/** Index explicit callback invalidations without mixing runtime and orchestration sequences. */
export function createStalePendingInteractionMatcher(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">>,
): (
  interaction: Pick<
    OrchestrationPendingInteraction,
    "interactionKind" | "requestId" | "createdAt"
  > & {
    readonly lifecycleGeneration?: string | null;
  },
) => boolean {
  const staleAtByInstance = new Map<string, string>();
  const keyOf = (kind: string, requestId: string, generation?: string | null) =>
    `${kind}\u0000${pendingRequestInstanceKey(requestId, generation ?? undefined)}`;
  for (const activity of activities) {
    const kind =
      activity.kind === "provider.approval.respond.failed"
        ? "approval"
        : activity.kind === "provider.user-input.respond.failed"
          ? "userInput"
          : null;
    if (kind === null || activity.payload === null || typeof activity.payload !== "object") {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    if (
      typeof payload.requestId !== "string" ||
      !isStalePendingRequestFailureDetail(
        typeof payload.detail === "string" ? payload.detail : undefined,
      )
    ) {
      continue;
    }
    const generation =
      typeof payload.lifecycleGeneration === "string" && payload.lifecycleGeneration.length > 0
        ? payload.lifecycleGeneration
        : undefined;
    const key = keyOf(kind, payload.requestId, generation);
    const previous = staleAtByInstance.get(key);
    if (previous === undefined || activity.createdAt > previous) {
      staleAtByInstance.set(key, activity.createdAt);
    }
  }
  return (interaction) => {
    if (
      interaction.lifecycleGeneration != null &&
      staleAtByInstance.has(
        keyOf(interaction.interactionKind, interaction.requestId, interaction.lifecycleGeneration),
      )
    ) {
      return true;
    }
    const legacyStaleAt = staleAtByInstance.get(
      keyOf(interaction.interactionKind, interaction.requestId),
    );
    // A legacy marker cannot identify a generation, so it only closes requests
    // that existed when the callback was invalidated, not later request-ID reuse.
    return legacyStaleAt !== undefined && legacyStaleAt >= interaction.createdAt;
  };
}

export const RESPONDING_INTERACTION_RECLAIM_GRACE_MS = 30_000;

export function respondingInteractionReclaimCutoff(requestedAt: string): string {
  const requestedAtMs = Date.parse(requestedAt);
  return Number.isNaN(requestedAtMs)
    ? requestedAt
    : new Date(requestedAtMs - RESPONDING_INTERACTION_RECLAIM_GRACE_MS).toISOString();
}

export function respondingInteractionReclaimAt(responseRequestedAt: string): string {
  const responseRequestedAtMs = Date.parse(responseRequestedAt);
  return Number.isNaN(responseRequestedAtMs)
    ? responseRequestedAt
    : new Date(responseRequestedAtMs + RESPONDING_INTERACTION_RECLAIM_GRACE_MS).toISOString();
}

/**
 * True when a settlement records that the provider callback is gone.
 *
 * `uncertain` alone is ambiguous: an answer whose delivery could not be
 * confirmed stays retryable against a live callback. A stale-callback
 * settlement also stamps `resolvedAt`, which makes the row terminal: no answer
 * can reach the provider any more, so the question must leave the composer.
 */
export function isExpiredPendingInteraction(
  interaction: Pick<OrchestrationPendingInteraction, "status" | "resolvedAt">,
): boolean {
  return interaction.status === "uncertain" && interaction.resolvedAt !== null;
}

export function isPendingInteractionResponseClaimable(input: {
  readonly status: OrchestrationPendingInteraction["status"];
  readonly responseRequestedAt: string | null;
  readonly requestedAt: string;
  readonly resolvedAt?: string | null;
}): boolean {
  if (input.status === "uncertain") {
    return input.resolvedAt == null;
  }
  if (input.status === "pending" || input.status === "retryable") {
    return true;
  }
  if (input.status !== "responding") {
    return false;
  }
  return (
    input.responseRequestedAt === null ||
    input.responseRequestedAt <= respondingInteractionReclaimCutoff(input.requestedAt)
  );
}

type UserInputAnswerValue = string | ReadonlyArray<string> | null | undefined;

interface UserInputQuestionPrompt {
  readonly id: string;
  readonly question: string;
}

/** Reads the `{ id, question }` pairs of a `user-input.requested` payload. */
export function userInputQuestionPrompts(payload: unknown): UserInputQuestionPrompt[] {
  if (payload === null || typeof payload !== "object") return [];
  const questions = (payload as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.question === "string"
      ? [{ id: record.id, question: record.question }]
      : [];
  });
}

function formatUserInputAnswerValue(answer: UserInputAnswerValue): string | null {
  const text =
    typeof answer === "string"
      ? answer.trim()
      : Array.isArray(answer)
        ? answer
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .join(", ")
        : "";
  return text.length > 0 ? text : null;
}

/**
 * Formats answered questions as "question\nanswer" blocks, in question order.
 * Answers keyed by an id the question list does not know (the request payload
 * was unavailable) fall back to the id, so an answer is never dropped.
 */
export function formatUserInputAnswerPairs(
  questions: ReadonlyArray<UserInputQuestionPrompt>,
  answers: Readonly<Record<string, UserInputAnswerValue>>,
): string {
  const knownIds = new Set(questions.map((question) => question.id));
  const prompts = [
    ...questions,
    ...Object.keys(answers)
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, question: id })),
  ];
  return prompts
    .flatMap((prompt) => {
      const answer = formatUserInputAnswerValue(answers[prompt.id]);
      return answer === null ? [] : [`${prompt.question}\n${answer}`];
    })
    .join("\n\n");
}

/**
 * Message id of the follow-up turn that carries an answer whose question
 * expired while it was being delivered. Derived from the response command that
 * held the claim, which the expired settlement keeps as `responseCommandId`,
 * so clients can tell a forwarded answer from one that still needs restoring.
 */
export function staleUserInputAnswerMessageId(responseCommandId: string): string {
  return `user-input-answer:${responseCommandId}`;
}

/**
 * Text of the follow-up message that resumes a thread with an answer its
 * expired question could no longer accept. Null when nothing was answered
 * (a cancel), which must not start a turn.
 */
export function buildStaleUserInputAnswerFollowUp(
  questions: ReadonlyArray<UserInputQuestionPrompt>,
  answers: Readonly<Record<string, UserInputAnswerValue>>,
): string | null {
  const pairs = formatUserInputAnswerPairs(questions, answers);
  return pairs.length === 0
    ? null
    : `My answer to your earlier question, which expired before it could be delivered:\n\n${pairs}`;
}
