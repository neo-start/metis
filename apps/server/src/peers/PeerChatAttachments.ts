import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PEER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PeerChatAttachment,
  type PeerChatRequest,
  type PeerChatReply,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { resolveAttachmentRelativePath } from "../attachmentPaths";
import { MANAGED_ATTACHMENT_WRITING_LEASE_MS } from "../managedAttachmentCleanup";
import { attachmentPrincipalForSession } from "../managedAttachmentPrincipal";
import {
  MANAGED_ATTACHMENT_STAGING_TTL_MS,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";

export const peerAttachmentPrincipal = (peerId: string) =>
  attachmentPrincipalForSession(`peer-chat:${peerId}`);

type AttachmentRequest = Extract<PeerChatRequest, { action: `chat.attachment.${string}` }>;
const metadata = (blob: ManagedAttachmentBlob): PeerChatAttachment => ({
  type: blob.kind as "image" | "file",
  id: blob.attachmentId,
  name: blob.originalName,
  mimeType: blob.mimeType,
  sizeBytes: blob.sizeBytes ?? blob.reservedBytes,
});

/** Called inside PeerManager's serialized, authenticated RPC queue. Bytes never
 * enter its durable command outbox. The existing quota/expiry sweeper owns every
 * partial blob, including reservations abandoned by a disconnected client. */
export function makePeerChatAttachments(
  repository: ManagedAttachmentRepositoryShape,
  attachmentsDir: string,
) {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  return async (
    peerId: string,
    threadId: string,
    request: AttachmentRequest,
  ): Promise<Pick<PeerChatReply, "attachment" | "attachmentData">> => {
    const principal = peerAttachmentPrincipal(peerId);
    const now = new Date().toISOString();
    if (request.action === "chat.attachment.begin") {
      const maxBytes =
        request.type === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (request.sizeBytes <= 0 || request.sizeBytes > maxBytes)
        throw new Error("附件为空或超出大小限制。");
      return {
        attachment: metadata(
          await run(
            reserveManagedAttachmentUpload({
              ...request,
              threadId,
              reservedBytes: request.sizeBytes,
              now,
              principal,
              repository,
            }),
          ),
        ),
      };
    }
    const blob = Option.getOrUndefined(
      await run(
        repository.findServerOwned({
          attachmentId: request.attachmentId,
          ownerThreadId: threadId,
          ...principal,
          now,
          uploadingCutoff: new Date(Date.now() - MANAGED_ATTACHMENT_WRITING_LEASE_MS).toISOString(),
        }),
      ),
    );
    if (!blob) throw new Error("附件不存在、已过期或不属于此对话，请重新添加。");
    if (request.action === "chat.attachment.cancel") {
      await run(
        repository.cancelStaged({
          attachmentId: blob.attachmentId,
          ...principal,
          reason: "peer-upload-cancelled",
          requestedAt: now,
        }),
      );
      return {};
    }
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: blob.relativePath,
    });
    if (!filePath) throw new Error("附件存储路径无效。");
    if (request.action === "chat.attachment.read") {
      if (
        blob.state !== "claimed" ||
        blob.kind !== "image" ||
        request.offset >= (blob.sizeBytes ?? 0)
      )
        throw new Error("图片尚未发送或读取位置无效。");
      const file = await fs.open(filePath, "r");
      try {
        const bytes = Buffer.alloc(
          Math.min(PEER_ATTACHMENT_CHUNK_BYTES, blob.sizeBytes! - request.offset),
        );
        const read = await file.read(bytes, 0, bytes.length, request.offset);
        if (read.bytesRead !== bytes.length) throw new Error("图片内容不完整。");
        return { attachment: metadata(blob), attachmentData: bytes.toString("base64") };
      } finally {
        await file.close();
      }
    }
    if (request.action === "chat.attachment.chunk") {
      if (blob.state !== "uploading") throw new Error("附件已完成上传，不能继续写入。");
      const bytes = Buffer.from(request.data, "base64");
      if (
        !bytes.length ||
        bytes.length > PEER_ATTACHMENT_CHUNK_BYTES ||
        bytes.toString("base64") !== request.data ||
        request.offset + bytes.length > blob.reservedBytes
      )
        throw new Error("附件分块大小或编码无效。");
      ensurePrivateDirectorySync(attachmentsDir);
      ensurePrivateDirectorySync(path.dirname(filePath));
      // Partial content is inaccessible while uploading; the managed row is
      // staged only after complete length, digest and fsync verification.
      const file = await fs.open(filePath, "a+", 0o600);
      try {
        const size = (await file.stat()).size;
        if (request.offset < size) {
          const previous = Buffer.alloc(bytes.length);
          const read = await file.read(previous, 0, bytes.length, request.offset);
          if (read.bytesRead !== bytes.length || !previous.equals(bytes))
            throw new Error("附件重试内容不一致。");
        } else {
          if (request.offset !== size) throw new Error("附件分块顺序不正确。");
          await file.writeFile(bytes);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      return { attachment: metadata(blob) };
    }
    // A lost finish acknowledgement is safe to retry, including after restart.
    if (blob.state === "staged" || blob.state === "claimed") {
      if (blob.sha256 !== request.sha256) throw new Error("附件校验不一致。");
      return { attachment: metadata(blob) };
    }
    const bytes = await fs.readFile(filePath);
    if (
      bytes.length !== blob.reservedBytes ||
      createHash("sha256").update(bytes).digest("hex") !== request.sha256
    )
      throw new Error("附件未上传完整或校验失败，请重新添加。");
    for (const directory of [
      path.dirname(filePath),
      path.dirname(path.dirname(filePath)),
      attachmentsDir,
    ])
      await syncDirectoryEntry(directory);
    const result = await run(
      repository.finalizeStaged({
        attachmentId: blob.attachmentId,
        ownerThreadId: threadId,
        ...principal,
        sizeBytes: bytes.length,
        sha256: request.sha256,
        now,
        stagingExpiresAt: new Date(Date.now() + MANAGED_ATTACHMENT_STAGING_TTL_MS).toISOString(),
      }),
    );
    if (result.status !== "staged") throw new Error("附件上传已过期，请重新添加。");
    return { attachment: metadata(result.attachment) };
  };
}
