import { expect, it, vi } from "vitest";
import { type OrchestrationCommand, type OrchestrationThread } from "@synara/contracts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import { readFeishuFollowup } from "./feishuRouterFollowup.ts";

function fixture() {
  const command = { threadId: "parent", message: { messageId: "correction" } } as Extract<
    OrchestrationCommand,
    { type: "thread.turn.start" }
  >;
  const worker = {
    creationSource: "router",
    sourceThreadId: "parent",
    messages: [
      { id: "correction", role: "user", turnId: "correct-turn" },
      { role: "assistant", turnId: "correct-turn", text: "correct result", streaming: false },
      { role: "assistant", turnId: "later-turn", text: "unrelated result", streaming: false },
    ],
  } as unknown as OrchestrationThread;
  const turn = {
    pendingMessageId: "correction",
    turnId: "correct-turn",
    state: "completed",
  } as ProjectionTurn;
  const host = {
    readThread: vi.fn(async () => worker),
    turns: vi.fn(async () => [turn]),
    isOutputSettled: vi.fn(async () => true),
    hasCompletedRun: vi.fn(async () => true),
  };
  return { command, worker, turn, host };
}

it("binds a follow-up to its own completed turn despite later replies", async () => {
  const { command, host } = fixture();
  expect(await readFeishuFollowup("worker", command, host)).toBe(
    "任务 [worker](/tasks?thread=worker) completed。\ncorrect result",
  );
});

it.each(["running", "pending", "unsettled", "missing-terminal", "wrong-owner", "missing-input"])(
  "waits or rejects %s instead of returning another result",
  async (condition) => {
    const { command, worker, turn, host } = fixture();
    if (condition === "running" || condition === "pending")
      host.turns.mockResolvedValue([{ ...turn, state: condition }]);
    if (condition === "unsettled") host.isOutputSettled.mockResolvedValue(false);
    if (condition === "missing-terminal") host.hasCompletedRun.mockResolvedValue(false);
    if (condition === "wrong-owner")
      host.readThread.mockResolvedValue({
        ...worker,
        sourceThreadId: "other",
      } as unknown as OrchestrationThread);
    if (condition === "missing-input")
      host.readThread.mockResolvedValue({ ...worker, messages: worker.messages.slice(1) });
    expect(await readFeishuFollowup("worker", command, host)).toBeUndefined();
  },
);

it("resolves native steering by the accepted user message's turn", async () => {
  const { command, turn, host } = fixture();
  host.turns.mockResolvedValue([{ ...turn, pendingMessageId: null }]);
  expect(await readFeishuFollowup("worker", command, host)).toContain("correct result");
});

it.each(["error", "interrupted"] as const)(
  "returns the bound %s outcome without a completion event",
  async (state) => {
    const { command, turn, host } = fixture();
    host.turns.mockResolvedValue([{ ...turn, state }]);
    host.hasCompletedRun.mockResolvedValue(false);
    expect(await readFeishuFollowup("worker", command, host)).toContain(`) ${state}。`);
  },
);
