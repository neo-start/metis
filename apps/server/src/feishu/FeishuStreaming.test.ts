import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { expect, it, vi } from "vitest";
import { FeishuStreaming } from "./FeishuStreaming.ts";

const silent = () => {};

function setup(failure?: "content" | "settings" | "network" | "fallback" | "recall" | "one") {
  const calls: HttpRequestOptions<unknown>[] = [];
  let id = 0;
  const request = vi.fn(async (options: HttpRequestOptions<unknown>) => {
    calls.push(options);
    const url = options.url ?? "";
    if (url.includes("tenant_access_token"))
      return { code: 0, tenant_access_token: "test-token", expire: 7200 };
    if (url.endsWith("/cards")) return { code: 0, data: { card_id: `card-${++id}` } };
    if (url.endsWith("/content") && failure) {
      if (failure === "network") throw new Error("network unavailable");
      if (
        failure !== "settings" &&
        (failure !== "one" || (options.data as { content: string }).content === "坏回复")
      )
        return { code: 200570, msg: "invalid card markdown" };
    }
    if (url.endsWith("/settings") && failure === "settings") return { code: 200570 };
    if (options.method === "DELETE") return failure === "recall" ? { code: 230006 } : { code: 0 };
    if (url.includes("/im/v1/messages")) {
      const data = options.data as { msg_type: string };
      if (data.msg_type === "text" && failure === "fallback") return { code: 230006 };
      return { code: 0, data: { message_id: `message-${++id}` } };
    }
    return { code: 0 };
  });
  const warn = vi.fn();
  const streaming = new FeishuStreaming({ request: request as HttpInstance["request"] }, warn);
  const channel = createLarkChannel({
    appId: "cli_test",
    appSecret: "test-secret",
    transport: "webhook",
    httpInstance: streaming.httpInstance,
    logger: { trace: silent, debug: silent, info: silent, warn: silent, error: silent },
  });
  const send = (text: string) =>
    streaming.stream(
      channel,
      "oc_chat",
      { markdown: async (controller) => controller.setContent(text) },
      { replyTo: "om_input" },
    );
  return { calls, warn, streaming, channel, send };
}

it("keeps successful native streaming without an extra reply", async () => {
  const f = setup();
  expect(await f.send("完成了")).toEqual({ messageId: "message-2" });
  expect(f.warn).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
});

it.each(["content", "settings", "network"] as const)(
  "detects swallowed %s errors with the real SDK, delivers text, then recalls the placeholder",
  async (failure) => {
    const f = setup(failure);
    const text = "已完成\n\n![截图](/Users/neo/artifacts/proof.png)";
    const result = await f.send(text);
    expect(result.messageId).toBe("message-3");
    const fallback = f.calls.find((c) => (c.data as { msg_type?: string })?.msg_type === "text")!;
    expect(fallback.url).toContain("/messages/om_input/reply");
    expect(JSON.parse((fallback.data as { content: string }).content)).toEqual({ text });
    const recall = f.calls.find((c) => c.method === "DELETE")!;
    expect(recall.url).toContain("/messages/message-2");
    expect(f.calls.indexOf(recall)).toBeGreaterThan(f.calls.indexOf(fallback));
  },
);

it("rejects failed fallback delivery so the durable outbox can retry", async () => {
  const f = setup("fallback");
  await expect(f.send("正文")).rejects.toBeDefined();
  expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
});

it("retains successful delivery when placeholder recall fails", async () => {
  const f = setup("recall");
  expect((await f.send("正文")).messageId).toBe("message-3");
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("could not be recalled"));
});

it("does not rerun or deliver partial output from a failing producer", async () => {
  const f = setup("content");
  const producer = vi.fn(async () => {
    throw new Error("task failed");
  });
  await expect(f.streaming.stream(f.channel, "oc_chat", { markdown: producer })).rejects.toThrow(
    "task failed",
  );
  expect(producer).toHaveBeenCalledTimes(1);
  expect(f.calls.some((c) => (c.data as { msg_type?: string })?.msg_type === "text")).toBe(false);
});

it("isolates concurrent streams so one rejected card cannot duplicate another reply", async () => {
  const f = setup("one");
  await Promise.all([f.send("坏回复"), f.send("正常回复")]);
  const fallbacks = f.calls.filter((c) => (c.data as { msg_type?: string })?.msg_type === "text");
  expect(fallbacks).toHaveLength(1);
  expect(JSON.parse((fallbacks[0]!.data as { content: string }).content)).toEqual({
    text: "坏回复",
  });
  expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
});

it("retains all rollover message IDs in successful delivery receipts", async () => {
  const f = setup();
  const result = await f.send("长回复段落。\n".repeat(5000));
  expect(result.chunkIds).toHaveLength(2);
  expect(result.chunkIds?.[0]).toBe(result.messageId);
});
