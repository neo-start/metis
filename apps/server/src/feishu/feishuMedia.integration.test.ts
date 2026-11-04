import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { FeishuMediaAttachment } from "@synara/contracts";
import { makeManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { makeFeishuMediaFiles } from "./feishuMediaFiles.ts";
import { makeFeishuMediaTransport } from "./feishuMediaTransport.ts";
import { FeishuMedia } from "./FeishuMedia.ts";
import { saveBrowserProof } from "../agentGateway/browserProof.ts";
import {
  reserveManagedAttachmentUpload,
  persistReservedManagedAttachment,
} from "../managedAttachmentStore.ts";
import { feishuAttachmentPrincipal } from "./feishuInboundAttachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-media-integration-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const baseDir = path.join(root, "private");
  await fs.mkdir(baseDir);
  const attachmentsDir = path.join(baseDir, "attachments");
  const runtime = ManagedRuntime.make(
    makeManagedAttachmentRepositoryLive().pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  cleanups.push(() => runtime.dispose());
  const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
  const uploads: Array<{ fields: Record<string, string>; bytes: Buffer }> = [];
  const messages: Array<Record<string, unknown>> = [];
  let failUpload = false;
  let loseSendResponse = false;
  const appId = `test_${randomUUID()}`;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    const json = (data: unknown) => res.end(JSON.stringify(data));
    if (req.url?.includes("/auth/")) {
      json({ code: 0, tenant_access_token: "fake-test-token", expire: 7200 });
      return;
    }
    if (req.url === "/open-apis/im/v1/images" || req.url === "/open-apis/im/v1/files") {
      const form = await new Request("http://localhost/upload", {
        method: "POST",
        headers: { "Content-Type": req.headers["content-type"]! },
        body: bytes,
      }).formData();
      const fields: Record<string, string> = {};
      let uploaded = Buffer.alloc(0);
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") fields[key] = value;
        else uploaded = Buffer.from(await value.arrayBuffer());
      }
      uploads.push({ fields, bytes: uploaded });
      if (failUpload) {
        json({ code: 99991672, msg: "permission denied" });
        return;
      }
      json({
        code: 0,
        data: req.url.endsWith("images")
          ? { image_key: `img_${uploads.length}` }
          : { file_key: `file_${uploads.length}` },
      });
      return;
    }
    if (req.url?.startsWith("/open-apis/im/v1/messages") && req.method === "POST") {
      const body = JSON.parse(bytes.toString());
      messages.push({ ...body, create_time: String(Date.now()) });
      if (loseSendResponse) {
        req.socket.destroy();
        return;
      }
      json({ code: 0, data: { message_id: `om_${messages.length}` } });
      return;
    }
    if (req.url?.startsWith("/open-apis/im/v1/messages") && req.method === "GET") {
      json({
        code: 0,
        data: {
          has_more: false,
          items: messages.map((message, index) => ({
            message_id: `om_${index + 1}`,
            create_time: message.create_time,
            chat_id: message.receive_id,
            msg_type: message.msg_type,
            sender: { id: appId, sender_type: "app" },
            body: { content: message.content },
            deleted: false,
          })),
        },
      });
      return;
    }
    res.statusCode = 404;
    json({ code: -1 });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const transport = makeFeishuMediaTransport(
    { appId, appSecret: "fake-local-test-secret" },
    `http://127.0.0.1:${address.port}`,
  );
  const prepare = makeFeishuMediaFiles({
    repository,
    attachmentsDir,
    baseDir,
    proofRoot: path.join(root, "proofs"),
  });
  const binding = {
    threadId: "thread",
    messageId: "feishu:incoming",
    appId,
    senderId: "owner",
    chatId: "oc_current",
  };
  const owner = { ...binding, workspaceRoot: workspace };
  const manager = new FeishuMedia(path.join(baseDir, "outbox"), {
    turn: async () => ({ messageId: binding.messageId, state: "running" }),
    transport: async () => transport,
    prepare: (attachment) => prepare(attachment, owner, transport),
  });
  await manager.initialize();
  await manager.bind(binding);
  const file = async (name: string, bytes: Buffer) => {
    const target = path.join(workspace, name);
    await fs.writeFile(target, bytes);
    return target;
  };
  return {
    root,
    workspace,
    baseDir,
    repository,
    attachmentsDir,
    transport,
    prepare,
    owner,
    manager,
    uploads,
    messages,
    file,
    failUpload: () => {
      failUpload = true;
    },
    loseSendResponse: () => {
      loseSendResponse = true;
    },
  };
}

describe("Feishu media real SDK + local HTTP protocol (not live Feishu)", () => {
  it("uploads actual multipart bytes and sends returned keys for image, file, Opus and MP4 with duration/cover", async () => {
    const s = await setup();
    const image = await s.file("screen.png", png);
    const file = await s.file("report.txt", Buffer.from("report"));
    const audio = await s.file(
      "voice.opus",
      Buffer.concat([
        Buffer.from("OggS"),
        Buffer.alloc(24),
        Buffer.from("OpusHead"),
        Buffer.alloc(32),
      ]),
    );
    const video = await s.file(
      "clip.mp4",
      Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]),
    );
    const receipt = await s.manager.request(
      "thread",
      "turn",
      {
        action: "send",
        requestId: "batch",
        caption: "交付",
        attachments: [
          { kind: "image", path: image },
          { kind: "file", path: file },
          { kind: "audio", path: audio, durationMs: 1234 },
          { kind: "video", path: video, durationMs: 2000, coverPath: image },
        ],
      },
      s.workspace,
    );
    expect(receipt.state).toBe("sent");
    expect(receipt.items.map((item) => item.messageId)).toEqual([
      "om_1",
      "om_2",
      "om_3",
      "om_4",
      "om_5",
    ]);
    expect(s.uploads.map((upload) => upload.fields.image_type ?? upload.fields.file_type)).toEqual([
      "message",
      "stream",
      "opus",
      "mp4",
      "message",
    ]);
    expect(s.uploads[0]?.bytes).toEqual(png);
    expect(s.uploads[2]?.fields.duration).toBe("1234");
    expect(s.uploads[3]?.fields.duration).toBe("2000");
    expect(s.messages.map((message) => message.msg_type)).toEqual([
      "text",
      "image",
      "file",
      "audio",
      "media",
    ]);
    expect(JSON.parse(s.messages[4]!.content as string)).toEqual({
      file_key: "file_4",
      image_key: "img_5",
    });
    expect(
      s.messages.every(
        (message) => message.receive_id === "oc_current" && typeof message.uuid === "string",
      ),
    ).toBe(true);
    expect(new Set(s.messages.map((message) => message.uuid)).size).toBe(5);
  });
  it("sends own durable browser proof and rejects another thread's proof", async () => {
    const s = await setup();
    const proofRoot = path.join(s.root, "proofs");
    const own = await saveBrowserProof("thread", png.toString("base64"), proofRoot);
    const other = await saveBrowserProof("other", png.toString("base64"), proofRoot);
    expect((await s.prepare({ path: own, kind: "image" }, s.owner, s.transport)).type).toBe(
      "image",
    );
    await expect(s.prepare({ path: other, kind: "image" }, s.owner, s.transport)).rejects.toThrow(
      "path_forbidden",
    );
    expect(s.uploads).toHaveLength(1);
  });
  it("falls back with explicit warning for unsupported media and missing duration", async () => {
    const s = await setup();
    for (const kind of ["image", "audio", "video"] as const) {
      const result = await s.prepare(
        { kind, path: await s.file(`${kind}.bin`, Buffer.from("not-native-media")) },
        s.owner,
        s.transport,
      );
      expect(result.type).toBe("file");
      expect(result.warning).toContain("文件附件");
    }
    expect(s.uploads.every((upload) => upload.fields.file_type === "stream")).toBe(true);
  });
  it("blocks URLs, hidden/private paths, escaping symlinks, directories, empty and oversized files before upload", async () => {
    const s = await setup();
    const secret = path.join(s.baseDir, "feishu-app.json");
    await fs.writeFile(secret, "secret");
    const symlink = path.join(s.workspace, "escape.png");
    await fs.symlink(secret, symlink);
    const empty = await s.file("empty.txt", Buffer.alloc(0));
    const hidden = await s.file(".env", Buffer.from("secret"));
    const big = path.join(s.workspace, "large.bin");
    const handle = await fs.open(big, "w");
    await handle.truncate(26 * 1024 * 1024);
    await handle.close();
    for (const target of [
      "https://example.com/image.png",
      secret,
      symlink,
      empty,
      hidden,
      big,
      s.workspace,
    ])
      await expect(
        s.prepare({ kind: "file", path: target }, s.owner, s.transport),
      ).rejects.toThrow();
    expect(s.uploads).toHaveLength(0);
  });
  it("checks managed attachment owner, thread, expiry and original hash", async () => {
    const s = await setup();
    const principal = feishuAttachmentPrincipal(s.owner.appId, s.owner.senderId);
    const now = new Date().toISOString();
    const reservation = await Effect.runPromise(
      reserveManagedAttachmentUpload({
        type: "image",
        threadId: "thread",
        name: "inbound.png",
        mimeType: "image/png",
        reservedBytes: png.length,
        now,
        principal,
        repository: s.repository,
      }),
    );
    const attachment = await Effect.runPromise(
      persistReservedManagedAttachment({
        reservation,
        bytes: png,
        attachmentsDir: s.attachmentsDir,
        now,
        principal,
        repository: s.repository,
      }),
    );
    const input: FeishuMediaAttachment = { kind: "image", attachmentId: attachment.id };
    await expect(s.prepare(input, { ...s.owner, senderId: "other" }, s.transport)).rejects.toThrow(
      "forbidden",
    );
    await expect(s.prepare(input, { ...s.owner, threadId: "other" }, s.transport)).rejects.toThrow(
      "forbidden",
    );
    expect((await s.prepare(input, s.owner, s.transport)).type).toBe("image");
    await fs.writeFile(
      path.join(s.attachmentsDir, reservation.relativePath),
      Buffer.from("tampered"),
    );
    await expect(s.prepare(input, s.owner, s.transport)).rejects.toThrow("hash_mismatch");
    await Effect.runPromise(
      s.repository.cancelStaged({
        attachmentId: attachment.id,
        ...principal,
        reason: "expired",
        requestedAt: now,
      }),
    );
    await expect(s.prepare(input, s.owner, s.transport)).rejects.toThrow("expired");
  });
  it("surfaces upload permission codes safely, without sending or exposing credentials", async () => {
    const s = await setup();
    s.failUpload();
    const image = await s.file("image.png", png);
    const receipt = await s.manager.request(
      "thread",
      "turn",
      { action: "send", requestId: "denied", attachments: [{ kind: "image", path: image }] },
      s.workspace,
    );
    expect(receipt.items[0]?.error).toBe("feishu_api_99991672");
    expect(s.messages).toHaveLength(0);
    expect(JSON.stringify(receipt)).not.toContain("fake-local-test-secret");
  });
  it("reconciles an accepted message with lost HTTP response using its uploaded key, without POST retry", async () => {
    const s = await setup();
    s.loseSendResponse();
    const image = await s.file("image.png", png);
    const receipt = await s.manager.request(
      "thread",
      "turn",
      { action: "send", requestId: "unknown", attachments: [{ kind: "image", path: image }] },
      s.workspace,
    );
    expect(receipt.state).toBe("unknown");
    const checked = await s.manager.request(
      "thread",
      "turn",
      { action: "status", requestId: "unknown" },
      null,
    );
    expect(checked.state).toBe("sent");
    expect(checked.items[0]?.messageId).toBe("om_1");
    expect(s.messages).toHaveLength(1);
  });
});
