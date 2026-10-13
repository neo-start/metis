import {
  ApprovalRequestId,
  UserInputQuestion,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import {
  createStalePendingInteractionMatcher,
  formatUserInputAnswerPairs,
  isExpiredPendingInteraction,
  staleUserInputAnswerMessageId,
} from "@synara/shared/pendingInteractions";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { Schema } from "effect";
import type { PendingUserInput } from "./pendingInteractionDerivation";
import {
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";

export interface PendingUserInputRecoveryDraft {
  request: PendingUserInput;
  answers: Record<string, PendingUserInputDraftAnswer>;
}

const StoredDraft = Schema.Struct({
  request: Schema.Struct({
    requestId: ApprovalRequestId,
    lifecycleGeneration: Schema.optionalKey(Schema.String),
    createdAt: Schema.String,
    questions: Schema.Array(UserInputQuestion),
  }),
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({
      customAnswer: Schema.optionalKey(Schema.String),
      selectedOptionLabels: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});

export function normalizePendingUserInputDrafts(
  value: unknown,
): Record<string, PendingUserInputRecoveryDraft> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, draft]) => {
      if (
        !Schema.is(StoredDraft)(draft) ||
        key !==
          pendingRequestInstanceKey(draft.request.requestId, draft.request.lifecycleGeneration)
      ) {
        return [];
      }
      const stored: typeof StoredDraft.Type = draft;
      const answers = Object.fromEntries(
        Object.entries(stored.answers).map(([id, answer]) => [
          id,
          {
            ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
            ...(answer.selectedOptionLabels
              ? { selectedOptionLabels: [...answer.selectedOptionLabels] }
              : {}),
          },
        ]),
      );
      return [[key, { request: stored.request, answers }]];
    }),
  );
}

export function expiredUserInputDrafts(
  drafts: Record<string, PendingUserInputRecoveryDraft>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
): Array<[string, PendingUserInputRecoveryDraft]> {
  const isStale = createStalePendingInteractionMatcher(activities);
  // The stale-failure activity can fall outside the bounded thread-detail
  // window, so the durable settlement is authoritative on its own.
  const expiredKeys = new Set(
    (settlements ?? [])
      .filter(
        (settlement) =>
          settlement.interactionKind === "userInput" && isExpiredPendingInteraction(settlement),
      )
      .map((settlement) =>
        pendingRequestInstanceKey(
          settlement.requestId,
          settlement.lifecycleGeneration ?? undefined,
        ),
      ),
  );
  return Object.entries(drafts).filter(
    ([key, draft]) =>
      expiredKeys.has(key) || isStale({ ...draft.request, interactionKind: "userInput" }),
  );
}

export function restoreUserInputDraft(
  prompt: string,
  draft: PendingUserInputRecoveryDraft,
): string {
  const pairs = formatUserInputAnswerPairs(
    draft.request.questions,
    Object.fromEntries(
      draft.request.questions.map((question) => [
        question.id,
        resolvePendingUserInputAnswer(question, draft.answers[question.id]),
      ]),
    ),
  );
  return [prompt, pairs].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Request keys whose expired answer the server already forwarded as a
 * follow-up message. Their drafts were delivered, so offering to restore them
 * would only invite sending the same answer twice.
 */
export function forwardedUserInputDraftKeys(
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  messageIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    (settlements ?? [])
      .filter(
        (settlement) =>
          settlement.interactionKind === "userInput" &&
          isExpiredPendingInteraction(settlement) &&
          settlement.responseCommandId !== null &&
          messageIds.has(staleUserInputAnswerMessageId(settlement.responseCommandId)),
      )
      .map((settlement) =>
        pendingRequestInstanceKey(
          settlement.requestId,
          settlement.lifecycleGeneration ?? undefined,
        ),
      ),
  );
}
