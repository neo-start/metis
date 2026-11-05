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
import { FEISHU_RECEIVED_TEXT } from "./feishuAcknowledgement.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([false, true])(
  "sends the receipt before admission and recovers without repeating it (failed send=%s)",
  async (failFirst) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "feishu-receipt-"));
    roots.push(root);
    const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("receipt-order"),
      threadId: ThreadId.makeUnsafe("controller"),
      message: {
        messageId: MessageId.makeUnsafe("input"),
        role: "user",
        text: "检查项目",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    };
    const key = createHash("sha256").update(command.commandId).digest("hex");
    const messages: Array<{ id: string; text: string }> = [];
    let finishSend!: () => void;
    const host = {
      allowed: () => true,
      readThread: async () => ({ messages }) as unknown as OrchestrationThread,
      accept: vi.fn(async () => ({})),
      send: vi.fn(async () => ({ messageId: "final" })),
    };
    host.send.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishSend = resolve;
      });
      if (failFirst) throw new Error("offline");
      return { messageId: "receipt" };
    });
    const input = {
      chatId: "chat",
      senderId: "owner",
      replyTo: "input",
      command,
      acknowledgementText: FEISHU_RECEIVED_TEXT,
    };
    const delivery = new FeishuRouterDelivery(root, host);
    const pending = delivery.enqueue(input);
    // Attach the rejection assertion before releasing the failed transport.
    const settled = failFirst ? expect(pending).rejects.toThrow("offline") : pending;
    await vi.waitFor(() => expect(finishSend).toBeDefined());
    await delivery.flush();
    expect(host.accept).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(1);
    finishSend();
    await settled;
    delivery.stop();
    if (failFirst) {
      expect(host.accept).not.toHaveBeenCalled();
      host.send.mockResolvedValueOnce({ messageId: "receipt" });
    }
    const recovered = new FeishuRouterDelivery(root, host);
    await recovered.flush();
    expect(host.accept).toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(failFirst ? 2 : 1);
    messages.push({ id: `router-${key}`, text: "检查完成" });
    await recovered.flush();
    await Promise.all([recovered.enqueue(input), recovered.enqueue(input)]);
    await new FeishuRouterDelivery(root, host).flush();
    expect(host.send).toHaveBeenCalledTimes(failFirst ? 3 : 2);
    expect(await recovered.resolveReference("chat", "owner", "receipt")).toBe(command.commandId);
    expect(await recovered.resolveReference("chat", "owner", "final")).toBe(command.commandId);
  },
);
it.each(["修改已加入任务 worker 的队列。", "已向任务 worker 提交修改，等待执行器接收。"])(
  "delivers and freezes follow-up results after reconnect: %s",
  async (ack) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "feishu-followup-"));
    roots.push(root);
    const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("followup"),
      threadId: ThreadId.makeUnsafe("controller"),
      message: {
        messageId: MessageId.makeUnsafe("input"),
        role: "user",
        text: "补充",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    };
    const key = createHash("sha256").update(command.commandId).digest("hex");
    const host = {
      accept: vi.fn(async () => ({})),
      allowed: () => true,
      readThread: async () =>
        ({ messages: [{ id: `router-${key}`, text: ack }] }) as unknown as OrchestrationThread,
      readFollowup: vi.fn(async (): Promise<string | undefined> => undefined),
      send: vi.fn(async () => ({ messageId: "ack" })),
    };
    const delivery = new FeishuRouterDelivery(root, host);
    await delivery.enqueue({ chatId: "chat", senderId: "owner", replyTo: "input", command });
    await delivery.flush();
    expect(host.send).toHaveBeenCalledTimes(1);
    delivery.stop();
    const recovered = new FeishuRouterDelivery(root, host);
    host.readFollowup.mockResolvedValue("补充结果");
    host.send.mockRejectedValueOnce(new Error("disconnected"));
    await expect(recovered.flush()).rejects.toThrow("disconnected");
    host.readFollowup.mockResolvedValue("another result must not replace the frozen result");
    host.send.mockResolvedValue({ messageId: "final" });
    const again = new FeishuRouterDelivery(root, host);
    await again.flush();
    expect(host.send).toHaveBeenLastCalledWith("chat", "补充结果", "input");
    await again.flush();
    expect(host.send).toHaveBeenCalledTimes(3);
    expect(await again.resolveReference("chat", "owner", "final")).toBe(command.commandId);
  },
);
it.each(["", "Router："])(
  "recovers worker notifications with prefix %j after reconnect",
  async (prefix) => {
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
      readThread: async () => ({ messages }) as unknown as unknown as OrchestrationThread,
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
      text: `${prefix}已创建独立任务 [agent-test](/tasks?thread=agent-test)。`,
    });
    host.send.mockRejectedValueOnce(new Error("transport disconnected"));
    await expect(recovered.flush()).rejects.toThrow("transport disconnected");
    await recovered.flush();
    expect(host.send).toHaveBeenCalledTimes(2);
    messages.push({
      id: "router-completion:agent-test",
      role: "assistant",
      text: "任务完成，分析结果",
    });
    await recovered.flush();
    expect(host.send).toHaveBeenLastCalledWith("chat", "任务完成，分析结果", "test");
    const again = new FeishuRouterDelivery(root, host);
    await again.flush();
    expect(host.send).toHaveBeenCalledTimes(3);
    expect(await again.has(command.commandId)).toBe(true);
    expect(await again.resolveReference("chat", "owner", "test")).toBe(command.commandId);
    expect(await again.resolveReference("chat", "owner", "bot-reply")).toBe(command.commandId);
    expect(await again.resolveReference("another-chat", "owner", "bot-reply")).toBeUndefined();
    expect(await again.resolveReference("chat", "someone-else", "test")).toBeUndefined();
  },
);
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
    startReply: vi.fn(),
    cancelReply: vi.fn(),
    send: vi.fn(async () => {}),
  };
  const delivery = new FeishuRouterDelivery(root, host);
  await delivery.enqueue({ chatId: "chat", senderId: "owner", replyTo: "revoked", command });
  expect(host.startReply).toHaveBeenCalledWith("chat", "revoked");
  allowed = false;
  await delivery.flush();
  expect(host.accept).toHaveBeenCalledTimes(1);
  expect(host.readThread).not.toHaveBeenCalled();
  expect(host.send).not.toHaveBeenCalled();
  expect(host.cancelReply).toHaveBeenCalledWith("chat", "revoked");
});

it.each([false, true])(
  "delivers natural replies using structured bindings (followup=%s)",
  async (followup) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "feishu-natural-"));
    roots.push(root);
    const command = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("natural"),
      threadId: ThreadId.makeUnsafe("source"),
      message: {
        messageId: MessageId.makeUnsafe("input"),
        role: "user",
        text: "补上 MCP 入口",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    } as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    const key = createHash("sha256").update(command.commandId).digest("hex");
    const messages = [
      { id: `router-${key}`, text: "我来补上 MCP 入口。" },
      { id: "router-completion:worker", text: "入口已补上，接口检查通过。" },
    ];
    const host = {
      accept: vi.fn(async () => ({})),
      allowed: () => true,
      readThread: async () => ({ messages }) as unknown as OrchestrationThread,
      readDelivery: vi.fn(async () => ({ workerId: "worker", followup })),
      readFollowup: vi.fn(async () => "补充要求已处理，检查通过。"),
      send: vi.fn(async () => ({ messageId: "reply" })),
    };
    const delivery = new FeishuRouterDelivery(root, host);
    await delivery.enqueue({ chatId: "chat", senderId: "owner", replyTo: "input", command });
    await delivery.flush();
    expect(host.send).toHaveBeenNthCalledWith(1, "chat", "我来补上 MCP 入口。", "input");
    expect(host.send).toHaveBeenLastCalledWith(
      "chat",
      followup ? "补充要求已处理，检查通过。" : "入口已补上，接口检查通过。",
      "input",
    );
    await new FeishuRouterDelivery(root, host).flush();
    expect(host.send).toHaveBeenCalledTimes(2);
    expect(host.readFollowup).toHaveBeenCalledTimes(followup ? 1 : 0);
  },
);
