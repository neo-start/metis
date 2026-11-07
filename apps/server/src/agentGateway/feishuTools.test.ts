import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { FeishuOutbound } from "../feishu/FeishuOutbound.ts";
import { makeFeishuTools } from "./feishuTools.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  jsonRpcRequestId: 1,
  assertCallerTurnActive: () => Effect.void,
};

function fixture() {
  const send = vi
    .fn<FeishuOutbound["send"]>()
    .mockResolvedValue({ messageId: "om_test", kind: "image", replayed: false });
  const tool = makeFeishuTools({ send }, () => Effect.succeed("/workspace"))[0]!;
  return { send, tool };
}

it("uses the caller's workspace and active-turn authorization for outbound sends", async () => {
  const { send, tool } = fixture();
  const input = { kind: "image", path: "shot.png", requestId: "screenshot-1" };
  const result = await Effect.runPromise(tool.handler(input, context));
  expect(result.isError).not.toBe(true);
  expect(tool.requiresActiveTurn).toBe(true);
  expect(tool.requiredCapability).toBe("thread:write");
  expect(send).toHaveBeenCalledWith(input, {
    threadId: "thread",
    workspaceRoot: "/workspace",
    assertActive: expect.any(Function),
  });
  await send.mock.calls[0]![1].assertActive();
});

it.each([{}, { kind: "image", requestId: 42 }, { kind: "image", requestId: "r", path: 42 }])(
  "returns invalid input as a tool error without sending: %j",
  async (input) => {
    const { send, tool } = fixture();
    expect((await Effect.runPromise(tool.handler(input, context))).isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  },
);

it("rejects inactive calls before sender access", async () => {
  const { send, tool } = fixture();
  const result = await Effect.runPromise(
    tool.handler(
      { kind: "text", text: "hello", requestId: "r" },
      {
        ...context,
        assertCallerTurnActive: () => Effect.fail(new GatewayToolError("inactive", "Inactive")),
      },
    ),
  );
  expect(result.isError).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
