import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuOutbound, type FeishuOutboundTransport } from "./FeishuOutbound.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-feishu-outbound-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const receipts = path.join(root, "receipts");
  await mkdir(workspaceRoot);
  const config = {
    appId: "cli_test",
    appSecret: "private-test-secret",
    allowedOpenIds: ["ou_owner"],
  };
  const configure = () => writeFile(path.join(root, "feishu-app.json"), JSON.stringify(config));
  await configure();
  const file = path.join(workspaceRoot, "shot.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const transport = {
    uploadImage: vi.fn<FeishuOutboundTransport["uploadImage"]>().mockResolvedValue("img_test"),
    uploadFile: vi.fn<FeishuOutboundTransport["uploadFile"]>().mockResolvedValue("file_test"),
    send: vi.fn<FeishuOutboundTransport["send"]>().mockResolvedValue("om_test"),
  };
  const factory = vi.fn(async () => transport);
  const retryDelay = vi.fn(async (_ms: number) => {});
  const sender = new FeishuOutbound(root, receipts, factory, retryDelay);
  const context = { threadId: "thread", workspaceRoot, assertActive: vi.fn(async () => {}) };
  const input = { kind: "image" as const, requestId: "shot-1", path: "shot.png" };
  return {
    root,
    workspaceRoot,
    receipts,
    file,
    config,
    configure,
    transport,
    factory,
    sender,
    context,
    input,
    retryDelay,
  };
}

it("uploads an image, sends its key to the sole owner, and replays the persisted message receipt after restart", async () => {
  const f = await fixture();
  expect(await f.sender.send(f.input, f.context)).toEqual({
    messageId: "om_test",
    kind: "image",
    replayed: false,
  });
  expect(f.transport.send).toHaveBeenCalledWith(
    "ou_owner",
    "image",
    JSON.stringify({ image_key: "img_test" }),
    expect.stringMatching(/^[a-f0-9]{40}$/),
  );
  const restarted = new FeishuOutbound(f.root, f.receipts, f.factory);
  expect((await restarted.send(f.input, f.context)).replayed).toBe(true);
  expect(f.transport.uploadImage).toHaveBeenCalledTimes(1);
  expect(f.transport.send).toHaveBeenCalledTimes(1);
  const receipt = await readFile(path.join(f.receipts, (await readdir(f.receipts))[0]!), "utf8");
  expect(receipt).not.toContain(f.config.appSecret);
  expect(receipt).not.toContain("ou_owner");
});

it("retries transient upload/send failures with bounded delays and one stable message UUID", async () => {
  const f = await fixture();
  f.transport.uploadImage.mockRejectedValueOnce(
    Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  );
  f.transport.send.mockRejectedValueOnce({ response: { status: 503 } });
  expect((await f.sender.send(f.input, f.context)).messageId).toBe("om_test");
  expect(f.transport.uploadImage).toHaveBeenCalledTimes(2);
  expect(f.transport.send).toHaveBeenCalledTimes(2);
  expect(f.transport.send.mock.calls[0]).toEqual(f.transport.send.mock.calls[1]);
  expect(f.retryDelay.mock.calls).toEqual([[250], [250]]);
});

it("bounds retries and keeps exhausted delivery uncertain", async () => {
  const f = await fixture();
  f.transport.send.mockRejectedValue(
    Object.assign(new Error("secret SDK request"), { code: "ETIMEDOUT" }),
  );
  await expect(f.sender.send(f.input, f.context)).rejects.toMatchObject({
    stage: "send",
    details: { retryable: true, category: "network_or_timeout" },
  });
  expect(f.transport.send).toHaveBeenCalledTimes(3);
  expect(f.retryDelay.mock.calls).toEqual([[250], [500]]);
  expect((await f.sender.status(f.input.requestId, f.context)).state).toBe("uncertain");
});

it("honors short rate-limit waits and leaves long waits for an explicit retry", async () => {
  const f = await fixture();
  f.transport.send.mockRejectedValueOnce({
    response: { status: 429, headers: { "retry-after": "2" } },
  });
  await f.sender.send(f.input, f.context);
  expect(f.retryDelay).toHaveBeenCalledWith(2_000);
  f.transport.send.mockRejectedValue({
    response: { status: 429, headers: { "retry-after": "120" } },
  });
  await expect(f.sender.send({ ...f.input, requestId: "second" }, f.context)).rejects.toMatchObject(
    {
      details: { retryAfterMs: 120_000, retryable: true },
    },
  );
  expect(f.transport.send).toHaveBeenCalledTimes(3);
});

it("does not retry permission failures or continue after authorization is revoked during backoff", async () => {
  const f = await fixture();
  f.transport.uploadImage.mockRejectedValueOnce({
    response: { status: 403, data: { code: 999, secret: "private" } },
  });
  await expect(f.sender.send(f.input, f.context)).rejects.toMatchObject({
    stage: "upload",
    details: { retryable: false, httpStatus: 403, apiCode: 999 },
  });
  expect(f.retryDelay).not.toHaveBeenCalled();
  f.transport.send.mockRejectedValue({ response: { status: 503 } });
  f.retryDelay.mockImplementation(async () => {
    f.context.assertActive.mockRejectedValue(new Error("turn ended"));
  });
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("turn ended");
  expect(f.transport.send).toHaveBeenCalledTimes(1);
});

it("sends files with a filename and text without uploading", async () => {
  const f = await fixture();
  await f.sender.send({ ...f.input, kind: "file" }, f.context);
  expect(f.transport.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), "shot.png");
  expect(f.transport.send).toHaveBeenCalledWith(
    "ou_owner",
    "file",
    JSON.stringify({ file_key: "file_test" }),
    expect.any(String),
  );
  await f.sender.send(
    { kind: "text", text: "完成", requestId: "text-1" },
    { ...f.context, workspaceRoot: null },
  );
  expect(f.transport.send).toHaveBeenLastCalledWith(
    "ou_owner",
    "text",
    JSON.stringify({ text: "完成" }),
    expect.any(String),
  );
  expect(f.transport.uploadImage).not.toHaveBeenCalled();
});

it("serializes simultaneous same-ID sends and rejects changed content", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.sender.send(f.input, f.context),
    f.sender.send(f.input, f.context),
  ]);
  expect(results.map((r) => r.replayed)).toEqual([false, true]);
  expect(f.transport.send).toHaveBeenCalledTimes(1);
  await writeFile(f.file, "different");
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("different content");
});

it("preserves the upload and remote UUID across an uncertain send, but refuses late automatic replay", async () => {
  const f = await fixture();
  f.transport.send.mockRejectedValueOnce(new Error("secret SDK request payload"));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("same requestId");
  const uuid = f.transport.send.mock.calls[0]![3];
  await f.sender.send(f.input, f.context);
  expect(f.transport.uploadImage).toHaveBeenCalledTimes(1);
  expect(f.transport.send.mock.calls[1]![3]).toBe(uuid);
  const receiptPath = path.join(f.receipts, (await readdir(f.receipts))[0]!);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  delete receipt.messageId;
  receipt.attemptedAt = Date.now() - 31 * 60_000;
  await writeFile(receiptPath, JSON.stringify(receipt));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("safe retry window");
  expect(f.transport.send).toHaveBeenCalledTimes(2);
});

it("refuses missing configuration, ambiguous recipients and non-owner recipients before upload", async () => {
  const f = await fixture();
  await expect(
    f.sender.send({ ...f.input, recipientOpenId: "ou_other" }, f.context),
  ).rejects.toThrow("allowedOpenIds");
  f.config.allowedOpenIds.push("ou_second");
  await f.configure();
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("allowedOpenIds");
  await rm(path.join(f.root, "feishu-app.json"));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("unavailable");
  expect(f.factory).not.toHaveBeenCalled();
});

it("refuses paths outside the workspace, including symlinks, and refuses directories and oversized files", async () => {
  const f = await fixture();
  await symlink(path.join(f.root, "feishu-app.json"), path.join(f.workspaceRoot, "escape"));
  for (const p of ["../feishu-app.json", "escape", "."]) {
    await expect(f.sender.send({ ...f.input, path: p }, f.context)).rejects.toThrow("outside");
  }
  await mkdir(path.join(f.workspaceRoot, "directory"));
  await expect(f.sender.send({ ...f.input, path: "directory" }, f.context)).rejects.toThrow(
    "regular file",
  );
  await truncate(f.file, 11 * 1024 * 1024);
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("10 MiB");
  await truncate(f.file, 26 * 1024 * 1024);
  await expect(f.sender.send({ ...f.input, kind: "file" }, f.context)).rejects.toThrow("25 MiB");
  expect(f.factory).not.toHaveBeenCalled();
});

it("rechecks active turn and recipient authorization between upload and send", async () => {
  const f = await fixture();
  f.transport.uploadImage.mockImplementation(async () => {
    f.config.allowedOpenIds = ["ou_someone_else"];
    await f.configure();
    return "img_test";
  });
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("authorization changed");
  expect(f.transport.send).not.toHaveBeenCalled();
  f.config.allowedOpenIds = ["ou_owner"];
  await f.configure();
  f.context.assertActive.mockRejectedValue(new Error("turn ended"));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("turn ended");
  expect(f.transport.send).not.toHaveBeenCalled();
});

it("does not send on upload failure or expose SDK credentials", async () => {
  const f = await fixture();
  f.transport.uploadImage.mockRejectedValue(new Error(f.config.appSecret));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("attachment upload failed");
  expect(f.transport.send).not.toHaveBeenCalled();
});

it("queries confirmed receipts after restart without the original file or bot configuration", async () => {
  const f = await fixture();
  await f.sender.send(f.input, f.context);
  await rm(f.file);
  await rm(path.join(f.root, "feishu-app.json"));
  f.factory.mockClear();
  const restarted = new FeishuOutbound(f.root, f.receipts, f.factory);
  expect(await restarted.status(f.input.requestId, f.context)).toMatchObject({
    state: "confirmed",
    messageId: "om_test",
    inProgress: false,
  });
  expect(await restarted.status(f.input.requestId, { threadId: "other-thread" })).toMatchObject({
    state: "not_found",
  });
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.transport.send).toHaveBeenCalledTimes(1);
});

it("distinguishes upload failure, uncertain delivery, and expired retries without sending", async () => {
  const f = await fixture();
  expect((await f.sender.status(f.input.requestId, f.context)).state).toBe("not_found");
  f.transport.uploadImage.mockRejectedValueOnce(new Error("upload failure"));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("upload failed");
  expect((await f.sender.status(f.input.requestId, f.context)).state).toBe("prepared");
  f.transport.send.mockRejectedValueOnce(new Error("timeout"));
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("same requestId");
  expect(await f.sender.status(f.input.requestId, f.context)).toMatchObject({
    state: "uncertain",
    nextAction: expect.stringContaining("same content and requestId"),
  });
  const receiptPath = path.join(f.receipts, (await readdir(f.receipts))[0]!);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.attemptedAt = Date.now() - 31 * 60_000;
  await writeFile(receiptPath, JSON.stringify(receipt));
  expect(await f.sender.status(f.input.requestId, f.context)).toMatchObject({
    state: "uncertain",
    nextAction: expect.stringContaining("safe retry window expired"),
  });
  expect(f.transport.send).toHaveBeenCalledTimes(1);
  await writeFile(receiptPath, "invalid json");
  await expect(f.sender.status(f.input.requestId, f.context)).rejects.toThrow();
  await expect(f.sender.status(" ", f.context)).rejects.toThrow("requestId");
});

it("reports uploaded but unconfirmed artifacts without exposing resource keys", async () => {
  const f = await fixture();
  f.transport.uploadImage.mockImplementation(async () => {
    f.context.assertActive.mockRejectedValue(new Error("turn ended"));
    return "img_private_resource";
  });
  await expect(f.sender.send(f.input, f.context)).rejects.toThrow("turn ended");
  const result = await f.sender.status(f.input.requestId, f.context);
  expect(result.state).toBe("uploaded");
  expect(JSON.stringify(result)).not.toContain("img_private_resource");
  expect(f.transport.send).not.toHaveBeenCalled();
});

it("reports an in-flight send so a status check cannot encourage another send", async () => {
  const f = await fixture();
  let finishSend!: (messageId: string) => void;
  let started!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.transport.send.mockImplementation(() => {
    started();
    return new Promise<string>((resolve) => {
      finishSend = resolve;
    });
  });
  const operation = f.sender.send(f.input, f.context);
  await sending;
  try {
    expect(await f.sender.status(f.input.requestId, f.context)).toMatchObject({
      state: "uncertain",
      inProgress: true,
      nextAction: expect.stringContaining("in progress"),
    });
  } finally {
    finishSend("om_test");
    await operation;
  }
  expect((await f.sender.status(f.input.requestId, f.context)).state).toBe("confirmed");
});
