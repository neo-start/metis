import { describe, expect, it } from "vitest";

import { IsoDateTime, ThreadId, TurnId } from "@synara/contracts";

import {
  HANDOFF_CONTINUATION_PROMPT,
  buildHandoffContinuationCommand,
  shouldContinueAfterHandoff,
} from "./handoffContinuation.ts";

const turn = (state: "running" | "interrupted" | "completed" | "error") => ({
  turnId: TurnId.makeUnsafe("turn-1"),
  state,
  requestedAt: IsoDateTime.makeUnsafe("2026-09-26T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

describe("shouldContinueAfterHandoff", () => {
  it("continues only a source chat that was stopped mid-work", () => {
    expect(shouldContinueAfterHandoff({ latestTurn: turn("interrupted") })).toBe(true);
    expect(shouldContinueAfterHandoff({ latestTurn: turn("completed") })).toBe(false);
    expect(shouldContinueAfterHandoff({ latestTurn: turn("error") })).toBe(false);
    expect(shouldContinueAfterHandoff({ latestTurn: turn("running") })).toBe(false);
    expect(shouldContinueAfterHandoff({ latestTurn: null })).toBe(false);
    expect(shouldContinueAfterHandoff(undefined)).toBe(false);
  });
});

describe("buildHandoffContinuationCommand", () => {
  it("builds one queued, automation-origin user turn keyed by the created event", () => {
    const command = buildHandoffContinuationCommand({
      threadId: ThreadId.makeUnsafe("thread-2"),
      eventId: "evt-9",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-26T00:00:01.000Z",
    });
    expect(command.commandId).toBe("server:handoff-continue:evt-9");
    expect(command.message.messageId).toBe("server:handoff-continue:evt-9");
    expect(command.message.text).toBe(HANDOFF_CONTINUATION_PROMPT);
    expect(command.dispatchMode).toBe("queue");
    expect(command.dispatchOrigin).toBe("automation");
    expect(command.runtimeMode).toBe("approval-required");
  });
});
