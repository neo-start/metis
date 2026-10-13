import { ApprovalRequestId, CommandId, EventId, ThreadId } from "@synara/contracts";
import {
  buildStalePendingRequestFailureDetail,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";
import { afterEach, expect, it } from "vitest";
import {
  expiredUserInputDrafts,
  forwardedUserInputDraftKeys,
  restoreUserInputDraft,
  type PendingUserInputRecoveryDraft,
} from "./pendingUserInputRecovery";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
} from "./composerDraftPersistence";

const requestId = ApprovalRequestId.makeUnsafe("saved-question");
const key = pendingRequestInstanceKey(requestId, "generation-a");
const draft: PendingUserInputRecoveryDraft = {
  request: {
    requestId,
    lifecycleGeneration: "generation-a",
    createdAt: "2026-09-10T10:00:00.000Z",
    questions: [
      {
        id: "1",
        header: "Color",
        question: "Which color?",
        options: [{ label: "Blue", description: "Brand" }],
      },
      { id: "2", header: "Features", question: "Which features?", options: [], multiSelect: true },
      { id: "3", header: "Notes", question: "Anything else?", options: [] },
    ],
  },
  answers: {
    "1": { selectedOptionLabels: ["Blue"] },
    "2": { selectedOptionLabels: ["Search", "Tabs"] },
    "3": { customAnswer: "Keep it simple" },
  },
};
afterEach(() => useComposerDraftStore.setState({ draftsByThreadId: {} }));

it("preserves structured answers without a normal prompt through persistence and reload", () => {
  const threadId = ThreadId.makeUnsafe("saved-thread");
  const store = useComposerDraftStore.getState();
  store.setPendingUserInputDrafts(threadId, { [key]: draft });
  store.setPrompt(threadId, "");
  const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(
    JSON.parse(JSON.stringify(persisted)),
  );
  const hydrated = toHydratedThreadDraft(threadId, normalized.draftsByThreadId[threadId]!);
  expect(hydrated.pendingUserInputDrafts).toEqual({ [key]: draft });
  store.clearComposerContent(threadId);
  expect(
    useComposerDraftStore.getState().draftsByThreadId[threadId]?.pendingUserInputDrafts,
  ).toEqual({ [key]: draft });
});

it("only offers recovery for an explicit invalidation of the saved instance", () => {
  const failure = {
    id: EventId.makeUnsafe("expired"),
    kind: "provider.user-input.respond.failed",
    summary: "Failed",
    tone: "error" as const,
    createdAt: "2026-09-10T10:01:00.000Z",
    turnId: null,
    payload: {
      requestId,
      lifecycleGeneration: "generation-a",
      detail: "temporary transport failure",
    },
  };
  expect(expiredUserInputDrafts({ [key]: draft }, [failure])).toEqual([]);
  const expired = {
    ...failure,
    payload: {
      ...failure.payload,
      detail: buildStalePendingRequestFailureDetail("user-input", requestId),
    },
  };
  expect(expiredUserInputDrafts({ [key]: draft }, [expired])).toEqual([[key, draft]]);
  expect(
    expiredUserInputDrafts({ [key]: draft }, [
      { ...expired, payload: { ...expired.payload, lifecycleGeneration: "different-generation" } },
    ]),
  ).toEqual([]);
});

it("offers recovery from an expired durable settlement without its failure activity", () => {
  const settlement = {
    interactionKind: "userInput" as const,
    requestId,
    threadId: ThreadId.makeUnsafe("saved-thread"),
    turnId: null,
    lifecycleGeneration: "generation-a",
    status: "uncertain" as const,
    decision: null,
    responseCommandId: null,
    responseRequestedAt: "2026-09-10T10:00:30.000Z",
    createdAt: "2026-09-10T10:00:00.000Z",
    resolvedAt: "2026-09-10T10:01:00.000Z",
  };
  expect(expiredUserInputDrafts({ [key]: draft }, [], [settlement])).toEqual([[key, draft]]);
  // An ambiguous delivery keeps the question answerable, so no recovery yet.
  expect(
    expiredUserInputDrafts({ [key]: draft }, [], [{ ...settlement, resolvedAt: null }]),
  ).toEqual([]);
  // A settlement for a different lifecycle generation does not expire this draft.
  expect(
    expiredUserInputDrafts(
      { [key]: draft },
      [],
      [{ ...settlement, lifecycleGeneration: "generation-b" }],
    ),
  ).toEqual([]);
});

it("treats an expired answer the server forwarded as delivered", () => {
  const settlement = {
    interactionKind: "userInput" as const,
    requestId,
    threadId: ThreadId.makeUnsafe("saved-thread"),
    turnId: null,
    lifecycleGeneration: "generation-a",
    status: "uncertain" as const,
    decision: null,
    responseCommandId: CommandId.makeUnsafe("respond-1"),
    responseRequestedAt: "2026-09-10T10:00:30.000Z",
    createdAt: "2026-09-10T10:00:00.000Z",
    resolvedAt: "2026-09-10T10:01:00.000Z",
  };
  const forwarded = new Set(["user-input-answer:respond-1"]);
  expect([...forwardedUserInputDraftKeys([settlement], forwarded)]).toEqual([key]);
  // Not forwarded yet (or the follow-up turn was refused): keep it restorable.
  expect(forwardedUserInputDraftKeys([settlement], new Set()).size).toBe(0);
  // Only an expired settlement can have been forwarded.
  expect(forwardedUserInputDraftKeys([{ ...settlement, resolvedAt: null }], forwarded).size).toBe(
    0,
  );
  expect(
    forwardedUserInputDraftKeys([{ ...settlement, responseCommandId: null }], forwarded).size,
  ).toBe(0);
});

it("restores all question-answer pairs after the existing normal draft", () => {
  expect(restoreUserInputDraft("Existing draft", draft)).toBe(
    "Existing draft\n\nWhich color?\nBlue\n\nWhich features?\nSearch, Tabs\n\nAnything else?\nKeep it simple",
  );
});
