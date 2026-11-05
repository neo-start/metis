import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuRouterDelivery } from "./FeishuRouterDelivery.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("recovers a worker notification and completion after reconnect without re-sending confirmed replies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-router-outbox-"));
  roots.push(root);
  const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("feishu:turn:test"),
    threadId: ThreadId.makeUnsafe("controller"),
    message: {
      messageId: MessageId.makeUnsafe("feishu:test"),
      role: "user",
      text: "新任务：分析",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  };
  const key = createHash("sha256").update(command.commandId).digest("hex");
  const messages: Array<{ id: string; role: string; text: string }> = [];
  const host = {
    accept: vi.fn(async () => ({ sequence: 1, routed: true })),
    readThread: async () => ({ messages }) as unknown as OrchestrationThread,
    allowed: () => true,
    send: vi.fn(async () => ({ messageId: "bot-reply" })),
  };
  const original = new FeishuRouterDelivery(root, host);
  await original.enqueue({ chatId: "chat", senderId: "owner", replyTo: "test", command });
  original.stop();
  const recovered = new FeishuRouterDelivery(root, host);
  messages.push({
    id: `router-${key}`,
    role: "assistant",
    text: "Router：已创建独立任务 [agent-test](/tasks?thread=agent-test)。",
  });
  host.send.mockRejectedValueOnce(new Error("transport disconnected"));
  await expect(recovered.flush()).rejects.toThrow("transport disconnected");
  await recovered.flush();
  expect(host.send).toHaveBeenCalledTimes(2);
  messages.push({
    id: "router-completion:agent-test",
    role: "assistant",
    text: "Router：任务完成，分析结果",
  });
  await recovered.flush();
  expect(host.send).toHaveBeenLastCalledWith("chat", "Router：任务完成，分析结果", "test");
  const again = new FeishuRouterDelivery(root, host);
  await again.flush();
  expect(host.send).toHaveBeenCalledTimes(3);
  expect(await again.has(command.commandId)).toBe(true);
  expect(await again.resolveReference("chat", "owner", "test")).toBe(command.commandId);
  expect(await again.resolveReference("chat", "owner", "bot-reply")).toBe(command.commandId);
  expect(await again.resolveReference("another-chat", "owner", "bot-reply")).toBeUndefined();
  expect(await again.resolveReference("chat", "someone-else", "test")).toBeUndefined();
});
it("does not admit or deliver persisted messages after allowlist revocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-router-revoke-"));
  roots.push(root);
  const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("revoked"),
    threadId: ThreadId.makeUnsafe("controller"),
    message: {
      messageId: MessageId.makeUnsafe("revoked"),
      role: "user",
      text: "你好",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  };
  let allowed = true;
  const host = {
    accept: vi.fn(async () => ({ sequence: 1, routed: true })),
    readThread: vi.fn(async () => undefined),
    allowed: () => allowed,
    send: vi.fn(async () => {}),
  };
  const delivery = new FeishuRouterDelivery(root, host);
  await delivery.enqueue({ chatId: "chat", senderId: "owner", replyTo: "revoked", command });
  allowed = false;
  await delivery.flush();
  expect(host.accept).toHaveBeenCalledTimes(1);
  expect(host.readThread).not.toHaveBeenCalled();
  expect(host.send).not.toHaveBeenCalled();
});
