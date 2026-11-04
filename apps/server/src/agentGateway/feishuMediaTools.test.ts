import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { decodeFeishuMediaRequest, makeFeishuMediaTools } from "./feishuMediaTools.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";
import { FeishuMedia } from "../feishu/FeishuMedia.ts";

const valid = {
  action: "send",
  requestId: "screen-1",
  attachments: [{ path: "/work/screen.png", kind: "image" }],
};
describe("Feishu media gateway boundary", () => {
  it("rejects caller-specified destinations, ambiguous sources, invalid durations and oversized batches", () => {
    expect(decodeFeishuMediaRequest(valid)).toEqual(valid);
    for (const args of [
      { ...valid, chatId: "other" },
      { ...valid, recipient: "owner" },
      { ...valid, attachments: [] },
      { ...valid, attachments: Array(9).fill(valid.attachments[0]) },
      { ...valid, attachments: [{ kind: "file" }] },
      { ...valid, attachments: [{ ...valid.attachments[0], attachmentId: "other" }] },
      { ...valid, attachments: [{ ...valid.attachments[0], durationMs: -1 }] },
      { ...valid, attachments: [{ ...valid.attachments[0], coverPath: "/work/a.png" }] },
      { action: "status", requestId: "id", attachments: valid.attachments },
    ])
      expect(() => decodeFeishuMediaRequest(args)).toThrow();
  });
  it("requires live write authority before reaching any file or transport code", async () => {
    const manager = new FeishuMedia("unused", {
      turn: async () => undefined,
      transport: async () => {
        throw new Error("must not reach transport");
      },
      prepare: async () => {
        throw new Error("must not read file");
      },
    });
    const request = vi.spyOn(manager, "request");
    const [tool] = makeFeishuMediaTools(manager, () => Effect.succeed("/work"));
    const context: ToolContext = {
      principal: {
        kind: "provider-session",
        sessionKey: "key",
        threadId: "thread",
        provider: "codex",
        turnId: "turn",
      },
      callerThreadId: "thread",
      callerThreadLabel: null,
      callerSessionKey: "key",
      callerProvider: "codex",
      callerCapabilities: new Set(["thread:write"]),
      callerTurnId: "turn",
      jsonRpcRequestId: 1,
      assertCallerTurnActive: () =>
        Effect.fail(new GatewayToolError("stale_turn", "Turn has ended")),
    };
    expect(tool!.requiredCapability).toBe("thread:write");
    expect(tool!.requiresActiveTurn).toBe(true);
    const result = await Effect.runPromise(tool!.handler(valid, context));
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
