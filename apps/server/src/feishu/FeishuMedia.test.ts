import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuMedia, type FeishuMediaBinding } from "./FeishuMedia.ts";
import { FeishuMediaError } from "./feishuMediaTransport.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const binding: FeishuMediaBinding = {
  threadId: "thread",
  messageId: "feishu:incoming",
  appId: "app",
  senderId: "owner",
  chatId: "chat",
};
const request = {
  action: "send",
  requestId: "proof-1",
  attachments: [{ kind: "image", path: "/work/screen.png" }],
} as const;
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-outbox-"));
  dirs.push(directory);
  let state = "running";
  let allowed = true;
  const transport = {
    upload: vi.fn(),
    send: vi.fn(async () => "om_real_receipt"),
    reconcile: vi.fn(async (): Promise<string | undefined> => undefined),
  };
  const host = {
    turn: vi.fn(async (threadId: string) =>
      threadId === "thread" ? { messageId: binding.messageId, state } : undefined,
    ),
    transport: vi.fn(async () => {
      if (!allowed) throw new FeishuMediaError("permission_denied");
      return transport;
    }),
    prepare: vi.fn(async () => ({
      name: "screen.png",
      type: "image" as const,
      content: { image_key: "uploaded-key" },
    })),
  };
  const manager = new FeishuMedia(directory, host);
  await manager.initialize();
  await manager.bind(binding);
  return {
    manager,
    directory,
    host,
    transport,
    state: (value: string) => {
      state = value;
    },
    revoke: () => {
      allowed = false;
    },
  };
}
describe("Feishu media durable delivery", () => {
  it("refuses ambiguous reused media keys when reconciling an unknown receipt", async () => {
    const s = await setup();
    await s.manager.request("thread", "turn", request, "/work");
    s.transport.send.mockRejectedValueOnce(new FeishuMediaError("timeout", true));
    await s.manager.request("thread", "turn", { ...request, requestId: "second" }, "/work");
    s.transport.reconcile.mockResolvedValue("om_old_match");
    const receipt = await s.manager.request(
      "thread",
      "turn",
      { action: "status", requestId: "second" },
      null,
    );
    expect(receipt.state).toBe("unknown");
    expect(receipt.items[0]?.error).toBe("reconciliation_ambiguous_media_key");
    expect(s.transport.reconcile).not.toHaveBeenCalled();
  });
  it("rechecks revocation and the 24-hour expiry before deferred delivery", async () => {
    const s = await setup();
    await s.manager.request("thread", "turn", { ...request, action: "attach" }, "/work");
    s.revoke();
    s.state("completed");
    await s.manager.drain();
    expect(s.manager.receiptsForMessage(binding.messageId)[0]?.items[0]?.error).toBe(
      "permission_denied",
    );
    expect(s.transport.send).not.toHaveBeenCalled();
    const fresh = await setup();
    await fresh.manager.request("thread", "turn", { ...request, action: "attach" }, "/work");
    fresh.state("completed");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 3600_000);
    try {
      await fresh.manager.drain();
    } finally {
      clock.mockRestore();
    }
    expect(fresh.manager.receiptsForMessage(binding.messageId)[0]?.state).toBe("cancelled");
    expect(fresh.transport.send).not.toHaveBeenCalled();
  });

  it("sends caption then media, persists real receipts, and deduplicates concurrent and restart retries", async () => {
    const s = await setup();
    const req = { ...request, caption: "截图" };
    const receipts = await Promise.all([
      s.manager.request("thread", "turn", req, "/work"),
      s.manager.request("thread", "turn", req, "/work"),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]?.state).toBe("sent");
    expect(s.transport.send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      "text",
      "image",
    ]);
    const restarted = new FeishuMedia(s.directory, s.host);
    await restarted.initialize();
    expect((await restarted.request("thread", "turn", req, "/work")).items[1]?.messageId).toBe(
      "om_real_receipt",
    );
    expect(s.transport.send).toHaveBeenCalledTimes(2);
    await expect(
      restarted.request("thread", "turn", { ...req, caption: "different" }, "/work"),
    ).rejects.toThrow("id_conflict");
  });
  it("releases attached replies only on exact completed turn, including after restart", async () => {
    const s = await setup();
    expect(
      (await s.manager.request("thread", "turn", { ...request, action: "attach" }, "/work")).state,
    ).toBe("queued");
    await s.manager.drain();
    expect(s.transport.send).not.toHaveBeenCalled();
    const restarted = new FeishuMedia(s.directory, s.host);
    await restarted.initialize();
    s.state("completed");
    await restarted.drain();
    await restarted.drain();
    expect(s.transport.send).toHaveBeenCalledOnce();
    expect(restarted.receiptsForMessage(binding.messageId)[0]?.state).toBe("sent");
  });
  it("rejects other threads, web turns, rebound owners and revoked senders", async () => {
    const s = await setup();
    await expect(s.manager.request("other", "turn", request, "/work")).rejects.toThrow("binding");
    s.host.turn.mockResolvedValueOnce({ messageId: "web-message", state: "running" });
    await expect(s.manager.request("thread", "turn", request, "/work")).rejects.toThrow("binding");
    await expect(s.manager.bind({ ...binding, chatId: "other-chat" })).rejects.toThrow("conflict");
    s.revoke();
    await expect(s.manager.request("thread", "turn", request, "/work")).rejects.toThrow(
      "permission",
    );
    expect(s.host.prepare).not.toHaveBeenCalled();
    expect(s.transport.send).not.toHaveBeenCalled();
  });
  it("keeps unknown sends fenced, reconciles positive evidence, and never resends", async () => {
    const s = await setup();
    s.transport.send.mockRejectedValueOnce(new FeishuMediaError("network_unknown", true));
    const first = await s.manager.request("thread", "turn", request, "/work");
    expect(first.state).toBe("unknown");
    await s.manager.request("thread", "turn", request, "/work");
    expect(
      (
        await s.manager.request(
          "thread",
          "turn",
          { action: "status", requestId: request.requestId },
          null,
        )
      ).state,
    ).toBe("unknown");
    s.transport.reconcile.mockResolvedValueOnce("om_verified");
    const receipt = await s.manager.request(
      "thread",
      "turn",
      { action: "status", requestId: request.requestId },
      null,
    );
    expect(receipt.items[0]?.messageId).toBe("om_verified");
    expect(receipt.state).toBe("sent");
    expect(s.transport.send).toHaveBeenCalledOnce();
  });
  it("recovers a crash after send fence as unknown, including old UUID dedupe windows", async () => {
    const s = await setup();
    await s.manager.request("thread", "turn", { ...request, action: "attach" }, "/work");
    const file = (await fs.readdir(s.directory)).find((name) => name.startsWith("request-"))!;
    const record = JSON.parse(await fs.readFile(path.join(s.directory, file), "utf8"));
    record.items[0].state = "sending";
    record.items[0].startedAt = Date.now() - 2 * 3600_000;
    await fs.writeFile(path.join(s.directory, file), JSON.stringify(record));
    const restarted = new FeishuMedia(s.directory, s.host);
    await restarted.initialize();
    s.state("completed");
    await restarted.drain();
    expect(restarted.receiptsForMessage(binding.messageId)[0]?.state).toBe("unknown");
    expect(s.transport.send).not.toHaveBeenCalled();
  });
  it("cancels deferred media on interrupted turns, expiry or explicit cancel", async () => {
    const s = await setup();
    await s.manager.request("thread", "turn", { ...request, action: "attach" }, "/work");
    const cancelled = await s.manager.request(
      "thread",
      "turn",
      { action: "cancel", requestId: request.requestId },
      null,
    );
    expect(cancelled.state).toBe("cancelled");
    s.state("completed");
    await s.manager.drain();
    expect(s.transport.send).not.toHaveBeenCalled();
    s.state("running");
    await s.manager.request(
      "thread",
      "turn",
      { ...request, requestId: "second", action: "attach" },
      "/work",
    );
    s.state("interrupted");
    await s.manager.drain();
    expect(s.manager.receiptsForMessage(binding.messageId)[1]?.state).toBe("cancelled");
  });
  it("reports partial success and stops remaining items after unknown send", async () => {
    const s = await setup();
    s.transport.send
      .mockResolvedValueOnce("om_first")
      .mockRejectedValueOnce(new FeishuMediaError("timeout", true));
    const receipt = await s.manager.request(
      "thread",
      "turn",
      {
        ...request,
        attachments: [request.attachments[0], request.attachments[0], request.attachments[0]],
      },
      "/work",
    );
    expect(receipt.items.map((item) => item.state)).toEqual(["sent", "unknown", "cancelled"]);
    expect(s.transport.send).toHaveBeenCalledTimes(2);
  });
  it("records a definitive API rejection without leaking original error details", async () => {
    const s = await setup();
    s.transport.send.mockRejectedValueOnce(new FeishuMediaError("feishu_api_99991672"));
    expect((await s.manager.request("thread", "turn", request, "/work")).state).toBe("failed");
    await s.manager.request("thread", "turn", request, "/work");
    expect(s.transport.send).toHaveBeenCalledOnce();
  });
  it("cancellation during an upload prevents the subsequent send", async () => {
    const s = await setup();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    s.host.prepare.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { name: "screen.png", type: "image", content: { image_key: "key" } };
    });
    const send = s.manager.request("thread", "turn", request, "/work");
    await began;
    const cancel = s.manager.request(
      "thread",
      "turn",
      { action: "cancel", requestId: request.requestId },
      null,
    );
    await Promise.resolve();
    release();
    await send;
    expect((await cancel).state).toBe("cancelled");
    expect(s.transport.send).not.toHaveBeenCalled();
  });
});
