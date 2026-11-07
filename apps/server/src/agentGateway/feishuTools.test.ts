import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { FeishuOutbound } from "../feishu/FeishuOutbound.ts";
import { describeFeishuFailure, FeishuOutboundFailure } from "../feishu/feishuOutboundFailure.ts";
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
  const status = vi.fn<FeishuOutbound["status"]>();
  const tools = makeFeishuTools({ send, status }, () => Effect.succeed("/workspace"));
  return { send, status, tool: tools[0]!, statusTool: tools[1]! };
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

it("returns actionable send failures without SDK credentials or response bodies", async () => {
  const { send, tool } = fixture();
  send.mockRejectedValue(
    new FeishuOutboundFailure(
      "send",
      "r",
      describeFeishuFailure({
        response: { status: 403, data: { code: 999, secret: "private-key" } },
        config: { appSecret: "private-key" },
      }),
    ),
  );
  const result = await Effect.runPromise(
    tool.handler({ kind: "text", text: "hello", requestId: "r" }, context),
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    stage: "send",
    delivery: "unknown",
    requestId: "r",
    retryable: false,
    httpStatus: 403,
    apiCode: 999,
  });
  expect(JSON.stringify(result)).not.toContain("private-key");
});

it("queries only the caller's receipt without sending or requiring an active turn", async () => {
  const { send, status, statusTool } = fixture();
  status.mockResolvedValue({
    requestId: "r",
    state: "confirmed",
    inProgress: false,
    messageId: "om_test",
    nextAction: "Already confirmed",
  });
  const result = await Effect.runPromise(statusTool.handler({ requestId: "r" }, context));
  expect(result.isError).not.toBe(true);
  expect(statusTool.requiredCapability).toBe("thread:read");
  expect(statusTool.definition.annotations?.readOnlyHint).toBe(true);
  expect(status).toHaveBeenCalledWith("r", { threadId: "thread" });
  expect(send).not.toHaveBeenCalled();
});

it("reports unreadable receipts as unknown without leaking storage errors", async () => {
  const { status, statusTool } = fixture();
  status.mockRejectedValue(new Error("private storage detail"));
  const result = await Effect.runPromise(statusTool.handler({ requestId: "r" }, context));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("unknown");
  expect(JSON.stringify(result)).not.toContain("private storage detail");
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
