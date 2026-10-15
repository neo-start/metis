import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { ThreadId, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import {
  resolveProviderDispatchAttachments,
  resolveProviderAttachmentPath,
} from "../provider/providerAttachmentPaths.ts";
import { loadProviderPromptImageBlocks } from "../provider/promptAttachments.ts";
import {
  feishuAttachmentPrincipal,
  withFeishuInboundAttachments,
} from "./feishuInboundAttachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const runtime = () =>
  ManagedRuntime.make(
    makeManagedAttachmentRepositoryLive().pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );

describe("Feishu inbound attachment handoff", () => {
  let services: ReturnType<typeof runtime>;
  let repository: ManagedAttachmentRepositoryShape;
  let attachmentsDir: string;
  beforeEach(async () => {
    services = runtime();
    repository = await services.runPromise(
      Effect.gen(function* () {
        return yield* ManagedAttachmentRepository;
      }),
    );
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-feishu-"));
  });
  afterEach(async () => {
    await services.dispose();
    await fs.rm(attachmentsDir, { recursive: true, force: true });
  });
  const base = () => ({
    appId: "app",
    senderId: "sender",
    messageId: "om_message",
    threadId: "thread",
    attachmentsDir,
    repository,
  });
  const response = (bytes: Buffer, mime = "application/octet-stream") => ({
    headers: { "content-type": mime },
    getReadableStream: () => Readable.from([bytes]),
  });

  it("downloads the message-bound image and file, claims them and supplies real bytes to the provider", async () => {
    const file = Buffer.from("EXAMPLE=value\n");
    const getResource = vi.fn(async (request: { path: { file_key: string } }) =>
      response(request.path.file_key === "image" ? png : file),
    );
    await withFeishuInboundAttachments({
      ...base(),
      resources: [
        { type: "image", fileKey: "image" },
        { type: "file", fileKey: "file", fileName: "consumer-new-machine.env" },
      ],
      getResource,
      submit: async (attachments, principal) => {
        expect(attachments.map((a) => a.type)).toEqual(["image", "file"]);
        const now = new Date().toISOString();
        const wrongOwner = await Effect.runPromise(
          repository.claimForAcceptedTurn({
            attachmentIds: attachments.map((a) => a.id),
            ownerThreadId: "thread",
            ...feishuAttachmentPrincipal("app", "other"),
            commandId: "cmd",
            messageId: "msg",
            now,
          }),
        );
        expect(wrongOwner.status).toBe("rejected");
        const claim = await Effect.runPromise(
          repository.claimForAcceptedTurn({
            attachmentIds: attachments.map((a) => a.id),
            ownerThreadId: "thread",
            ...principal,
            commandId: "cmd",
            messageId: "msg",
            now,
          }),
        );
        expect(claim.status).toBe("claimed");
        const resolved = await Effect.runPromise(
          resolveProviderDispatchAttachments({
            attachments,
            attachmentsDir,
            repository,
            threadId: ThreadId.makeUnsafe("thread"),
            messageId: "msg",
            provider: "codex",
            operation: "sendTurn",
          }),
        );
        const images = await Effect.runPromise(
          loadProviderPromptImageBlocks({
            attachments: resolved,
            attachmentsDir,
            provider: "codex",
            method: "sendTurn",
            readFile: (filePath) => Effect.promise(() => fs.readFile(filePath)),
          }),
        );
        expect(images).toEqual([
          { type: "image", mimeType: "image/png", data: png.toString("base64") },
        ]);
        const filePath = resolveProviderAttachmentPath({
          attachment: resolved[1]!,
          attachmentsDir,
        });
        expect(await fs.readFile(filePath!)).toEqual(file);
      },
    });
    expect(getResource.mock.calls).toEqual([
      [{ path: { message_id: "om_message", file_key: "image" }, params: { type: "image" } }],
      [{ path: { message_id: "om_message", file_key: "file" }, params: { type: "file" } }],
    ]);
  });

  it("resolves JPEG octet-stream metadata instead of mislabelling it PNG", async () => {
    await withFeishuInboundAttachments({
      ...base(),
      resources: [{ type: "image", fileKey: "jpeg" }],
      getResource: async () => response(Buffer.from([255, 216, 255, 224, 1])),
      submit: async (attachments) => {
        expect(attachments[0]?.mimeType).toBe("image/jpeg");
      },
    });
  });

  it("does not submit incomplete text-only turns when a later download fails, and cancels staging", async () => {
    let call = 0;
    const submit = vi.fn();
    await expect(
      withFeishuInboundAttachments({
        ...base(),
        resources: [
          { type: "image", fileKey: "ok" },
          { type: "file", fileKey: "denied" },
        ],
        getResource: async () => {
          if (call++ === 0) return response(png);
          throw new Error("permission denied");
        },
        submit,
      }),
    ).rejects.toThrow("permission denied");
    expect(submit).not.toHaveBeenCalled();
    const usage = await Effect.runPromise(
      repository.getUsage(feishuAttachmentPrincipal("app", "sender")),
    );
    expect(usage.principalStagingCount).toBe(0);
  });

  it("stops an oversized stream without submitting a turn", async () => {
    const stream = Readable.from([
      Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
      Buffer.from([1]),
    ]);
    const submit = vi.fn();
    await expect(
      withFeishuInboundAttachments({
        ...base(),
        resources: [{ type: "image", fileKey: "big" }],
        getResource: async () => ({ headers: {}, getReadableStream: () => stream }),
        submit,
      }),
    ).rejects.toThrow("超过");
    expect(stream.destroyed).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps claimed bytes when dispatch acknowledgement is lost", async () => {
    let id = "";
    await expect(
      withFeishuInboundAttachments({
        ...base(),
        resources: [{ type: "image", fileKey: "img" }],
        getResource: async () => response(png),
        submit: async (attachments, principal) => {
          id = attachments[0]!.id;
          await Effect.runPromise(
            repository.claimForAcceptedTurn({
              attachmentIds: [id],
              ownerThreadId: "thread",
              ...principal,
              commandId: "cmd",
              messageId: "msg",
              now: new Date().toISOString(),
            }),
          );
          throw new Error("lost ack");
        },
      }),
    ).rejects.toThrow("lost ack");
    const claimed = await Effect.runPromise(repository.findClaimedById({ attachmentId: id }));
    expect(claimed._tag).toBe("Some");
  });

  it("rejects unsupported stickers and excess attachments before downloading", async () => {
    const getResource = vi.fn();
    const submit = vi.fn();
    await expect(
      withFeishuInboundAttachments({
        ...base(),
        resources: [{ type: "sticker", fileKey: "sticker" }],
        getResource,
        submit,
      }),
    ).rejects.toThrow("表情包");
    await expect(
      withFeishuInboundAttachments({
        ...base(),
        resources: Array.from({ length: 9 }, () => ({ type: "file" as const, fileKey: "file" })),
        getResource,
        submit,
      }),
    ).rejects.toThrow("最多");
    expect(getResource).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("preserves the text-only path without downloading anything", async () => {
    const getResource = vi.fn();
    const submit = vi.fn(async () => "accepted");
    expect(
      await withFeishuInboundAttachments({ ...base(), resources: [], getResource, submit }),
    ).toBe("accepted");
    expect(submit).toHaveBeenCalledWith([], feishuAttachmentPrincipal("app", "sender"));
    expect(getResource).not.toHaveBeenCalled();
  });
});
