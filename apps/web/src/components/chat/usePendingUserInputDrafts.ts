import type { OrchestrationPendingInteraction, ThreadId } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInputRecoveryDraft } from "../../pendingUserInputRecovery";

type Answers = Record<string, Record<string, PendingUserInputDraftAnswer>>;
const EMPTY_DRAFTS: Record<string, PendingUserInputRecoveryDraft> = {};
const EMPTY_KEYS: ReadonlySet<string> = new Set();

function draftAnswers(drafts: Record<string, PendingUserInputRecoveryDraft>): Answers {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.answers]));
}

export function usePendingUserInputDrafts(
  threadId: ThreadId,
  requests: ReadonlyArray<PendingUserInput>,
  interactions: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  /** Expired requests whose answer the server forwarded as a follow-up message. */
  deliveredKeys: ReadonlySet<string> = EMPTY_KEYS,
) {
  const drafts = useComposerThreadDraft(threadId).pendingUserInputDrafts ?? EMPTY_DRAFTS;
  const answers = useMemo(() => draftAnswers(drafts), [drafts]);
  const answersRef = useRef<Answers>(answers);
  const requestsRef = useRef(requests);
  useLayoutEffect(() => {
    answersRef.current = answers;
    requestsRef.current = requests;
  }, [answers, requests, threadId]);

  const setAnswers = useCallback(
    (update: (existing: Answers) => Answers) => {
      const store = useComposerDraftStore.getState();
      const existing = store.draftsByThreadId[threadId]?.pendingUserInputDrafts ?? EMPTY_DRAFTS;
      const nextAnswers = update(draftAnswers(existing));
      const nextDrafts = { ...existing };
      for (const [key, requestAnswers] of Object.entries(nextAnswers)) {
        const request =
          existing[key]?.request ??
          requestsRef.current.find(
            (entry) =>
              pendingRequestInstanceKey(entry.requestId, entry.lifecycleGeneration) === key,
          );
        if (request) nextDrafts[key] = { request, answers: requestAnswers };
      }
      answersRef.current = nextAnswers;
      store.setPendingUserInputDrafts(threadId, nextDrafts);
    },
    [threadId],
  );

  const discard = useCallback(
    (key: string) => {
      const store = useComposerDraftStore.getState();
      const existing = store.draftsByThreadId[threadId]?.pendingUserInputDrafts ?? EMPTY_DRAFTS;
      if (!(key in existing)) return;
      const { [key]: _discarded, ...rest } = existing;
      answersRef.current = draftAnswers(rest);
      store.setPendingUserInputDrafts(threadId, rest);
    },
    [threadId],
  );

  // Command acceptance is not delivery. Keep the answer through transient
  // failures and only discard it after authoritative settlement: the provider
  // confirmed it, or the server forwarded it after the question expired.
  useEffect(() => {
    const delivered = new Set(deliveredKeys);
    for (const row of interactions ?? []) {
      if (row.interactionKind === "userInput" && row.status === "confirmed") {
        delivered.add(
          pendingRequestInstanceKey(row.requestId, row.lifecycleGeneration ?? undefined),
        );
      }
    }
    if (!Object.keys(drafts).some((key) => delivered.has(key))) return;
    useComposerDraftStore
      .getState()
      .setPendingUserInputDrafts(
        threadId,
        Object.fromEntries(Object.entries(drafts).filter(([key]) => !delivered.has(key))),
      );
  }, [deliveredKeys, drafts, interactions, threadId]);

  return { answers, answersRef, setAnswers, discard, drafts };
}
