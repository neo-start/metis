import { describe, expect, it } from "vitest";

import {
  buildStaleUserInputAnswerFollowUp,
  formatUserInputAnswerPairs,
  isExpiredPendingInteraction,
  isPendingInteractionResponseClaimable,
  respondingInteractionReclaimAt,
  respondingInteractionReclaimCutoff,
  staleUserInputAnswerMessageId,
  userInputQuestionPrompts,
} from "./pendingInteractions";

describe("pending interaction response claims", () => {
  it.each(["pending", "retryable", "uncertain"] as const)(
    "allows %s interactions to be claimed",
    (status) => {
      expect(
        isPendingInteractionResponseClaimable({
          status,
          responseRequestedAt: null,
          requestedAt: "2026-07-14T12:31:00.000Z",
        }),
      ).toBe(true);
    },
  );

  it("never claims an uncertain interaction settled as expired", () => {
    // An ambiguous delivery stays retryable; a stale-callback settlement,
    // stamped with resolvedAt, can never reach the provider again.
    expect(
      isPendingInteractionResponseClaimable({
        status: "uncertain",
        responseRequestedAt: "2026-07-14T12:30:00.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
        resolvedAt: null,
      }),
    ).toBe(true);
    expect(
      isPendingInteractionResponseClaimable({
        status: "uncertain",
        responseRequestedAt: "2026-07-14T12:30:00.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
        resolvedAt: "2026-07-14T12:30:01.000Z",
      }),
    ).toBe(false);
    expect(
      isExpiredPendingInteraction({ status: "uncertain", resolvedAt: "2026-07-14T12:30:01.000Z" }),
    ).toBe(true);
    expect(isExpiredPendingInteraction({ status: "uncertain", resolvedAt: null })).toBe(false);
    expect(
      isExpiredPendingInteraction({ status: "confirmed", resolvedAt: "2026-07-14T12:30:01.000Z" }),
    ).toBe(false);
  });

  it("only reclaims responding interactions after the grace period", () => {
    expect(respondingInteractionReclaimCutoff("2026-07-14T12:31:00.000Z")).toBe(
      "2026-07-14T12:30:30.000Z",
    );
    expect(respondingInteractionReclaimAt("2026-07-14T12:30:30.000Z")).toBe(
      "2026-07-14T12:31:00.000Z",
    );
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: "2026-07-14T12:30:31.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(false);
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: "2026-07-14T12:30:30.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(true);
    expect(
      isPendingInteractionResponseClaimable({
        status: "responding",
        responseRequestedAt: null,
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(true);
  });

  it("never reclaims confirmed interactions", () => {
    expect(
      isPendingInteractionResponseClaimable({
        status: "confirmed",
        responseRequestedAt: "2026-07-14T12:00:00.000Z",
        requestedAt: "2026-07-14T12:31:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("expired user-input answer follow-up", () => {
  const questions = userInputQuestionPrompts({
    requestId: "request-1",
    questions: [
      { id: "line", header: "Line", question: "How should line 19 proceed?", options: [] },
      { id: "extras", header: "Extras", question: "Which extras?", options: [] },
      { id: "skipped", header: "Skipped", question: "Unanswered?", options: [] },
      { header: "Malformed" },
    ],
  });

  it("reads question prompts and ignores malformed entries", () => {
    expect(questions.map((question) => question.id)).toEqual(["line", "extras", "skipped"]);
    expect(userInputQuestionPrompts(null)).toEqual([]);
    expect(userInputQuestionPrompts({ questions: "nope" })).toEqual([]);
  });

  it("formats option labels and free text under their questions", () => {
    expect(
      formatUserInputAnswerPairs(questions, {
        line: "  Delete the old post, then continue  ",
        extras: ["Images", " ", "Prod"],
        skipped: null,
      }),
    ).toBe(
      "How should line 19 proceed?\nDelete the old post, then continue\n\nWhich extras?\nImages, Prod",
    );
  });

  it("keeps answers whose question is unknown under their id", () => {
    expect(formatUserInputAnswerPairs([], { line: "Continue" })).toBe("line\nContinue");
  });

  it("builds a follow-up only when something was answered", () => {
    expect(buildStaleUserInputAnswerFollowUp(questions, {})).toBeNull();
    expect(buildStaleUserInputAnswerFollowUp(questions, { line: "  ", extras: [] })).toBeNull();
    expect(buildStaleUserInputAnswerFollowUp(questions, { line: "Continue" })).toBe(
      "My answer to your earlier question, which expired before it could be delivered:\n\nHow should line 19 proceed?\nContinue",
    );
  });

  it("derives the follow-up message id from the claiming response command", () => {
    expect(staleUserInputAnswerMessageId("command-1")).toBe("user-input-answer:command-1");
  });
});
