import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { PeerManager } from "../peers/PeerManager.ts";
import { makePeerTools } from "./peerTools.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const peerId = "metis-0123456789abcdef0123456789abcdef";
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "controller",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "controller",
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

function fixture() {
  const remote = vi.fn<PeerManager["remote"]>().mockResolvedValue({
    name: "remote",
    project: null,
    tasks: [],
    messages: [],
  });
  const tool = makePeerTools({ overview: vi.fn<PeerManager["overview"]>(), remote })[1]!;
  const call = (args: Record<string, unknown>, override: Partial<ToolContext> = {}) =>
    Effect.runPromise(tool.handler({ peerId, ...args }, { ...context, ...override }));
  return { remote, tool, call };
}

it.each([
  { action: "chat.list" },
  { action: "chat.open", title: "Project discussion", requestId: "open-1" },
  { action: "chat.read", chatId: "chat-1", revision: "revision-1" },
  { action: "chat.send", chatId: "chat-1", text: "Hello", requestId: "send-1" },
  { action: "chat.stop", chatId: "chat-1", turnId: "turn-1", requestId: "stop-1" },
])("dispatches controller operation $action through the paired manager", async (input) => {
  const { call, remote, tool } = fixture();
  expect(tool.requiredCapability).toBe("thread:write");
  expect(tool.requiresActiveTurn).toBe(true);
  expect((await call(input)).isError).not.toBe(true);
  const { requestId, ...request } = input as Record<string, unknown>;
  expect(remote).toHaveBeenCalledExactlyOnceWith(
    peerId,
    { ...request, ...(requestId ? { id: requestId } : {}) },
    "controller",
  );
});

it.each(["respond", "chat.approval", "chat.answer", "chat.async-answer", "configure", "pair"])(
  "keeps owner-only operation %s unavailable to agents",
  async (action) => {
    const { call, remote } = fixture();
    expect((await call({ action })).isError).toBe(true);
    expect(remote).not.toHaveBeenCalled();
  },
);

it("does not dispatch controller operations after the caller turn ends", async () => {
  const { call, remote } = fixture();
  expect(
    (
      await call(
        { action: "chat.list" },
        { assertCallerTurnActive: () => Effect.fail(new GatewayToolError("inactive", "Inactive")) },
      )
    ).isError,
  ).toBe(true);
  expect(remote).not.toHaveBeenCalled();
});
