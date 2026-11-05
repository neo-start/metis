import type { LarkChannel, StreamInput } from "@larksuiteoapi/node-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuReplyStreams } from "./FeishuReplyStreams.ts";

afterEach(() => vi.useRealTimers());

function setup(timeoutMs?: number) {
  const contents: string[] = [];
  const stream = vi.fn<Pick<LarkChannel, "stream">["stream"]>(async (_chat, input: StreamInput) => {
    if (!("markdown" in input)) throw new Error("Expected markdown stream");
    await input.markdown({
      messageId: "card",
      append: async () => {},
      setContent: async (text) => {
        contents.push(text);
      },
    });
    return { messageId: "card" };
  });
  const warn = vi.fn();
  return { stream, contents, warn, replies: new FeishuReplyStreams({ stream }, warn, timeoutMs) };
}

it("opens typing immediately, reuses the card for the reply, and opens a new card for completion", async () => {
  const f = setup();
  f.replies.start("chat", "input");
  f.replies.start("chat", "input");
  expect(f.stream).toHaveBeenCalledTimes(1);
  expect(f.contents).toEqual([]);
  expect(await f.replies.send("chat", "你好", "input")).toEqual({ messageId: "card" });
  expect(f.stream).toHaveBeenCalledTimes(1);
  await f.replies.send("chat", "完成结果", "input");
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(f.contents).toEqual(["你好", "完成结果"]);
});

it("keeps chats and concurrent requests independent", async () => {
  const f = setup();
  f.replies.start("a", "input");
  f.replies.start("b", "input");
  await f.replies.send("b", "先回复 B", "input");
  expect(f.contents).toEqual(["先回复 B"]);
  await f.replies.send("a", "再回复 A", "input");
  expect(f.stream).toHaveBeenCalledTimes(2);
});

it("handles early transport failure and propagates send failures for durable retry", async () => {
  const f = setup();
  f.stream.mockRejectedValueOnce(new Error("offline"));
  f.replies.start("chat", "input");
  await vi.waitFor(() => expect(f.warn).toHaveBeenCalledTimes(1));
  f.stream.mockRejectedValueOnce(new Error("still offline"));
  await expect(f.replies.send("chat", "回复", "input")).rejects.toThrow("still offline");
  await expect(f.replies.send("chat", "回复", "input")).resolves.toEqual({ messageId: "card" });
});

it("closes waiting cards on timeout and can deliver the eventual reply", async () => {
  vi.useFakeTimers();
  const f = setup(100);
  f.replies.start("chat", "input");
  await vi.advanceTimersByTimeAsync(100);
  expect(f.contents).toEqual(["回复仍在生成，完成后会继续发送。"]);
  await f.replies.send("chat", "回复", "input");
  expect(f.stream).toHaveBeenCalledTimes(2);
});

it("finalizes typing on cancellation and shutdown", async () => {
  const f = setup();
  f.replies.start("chat", "revoked");
  f.replies.start("chat", "pending");
  await f.replies.cancel("chat", "revoked");
  await f.replies.stop();
  expect(f.contents).toEqual([
    "本次回复已暂停。",
    "连接正在重启，未完成的回复将在恢复后继续发送。",
  ]);
});
