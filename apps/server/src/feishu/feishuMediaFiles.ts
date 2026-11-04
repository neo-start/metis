import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Mime from "@effect/platform-node/Mime";
import { Effect, Option } from "effect";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, type FeishuMediaAttachment } from "@synara/contracts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { resolveCodexGeneratedImagesRoot } from "../codexGeneratedImages.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore.ts";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments.ts";
import { feishuAttachmentPrincipal } from "./feishuInboundAttachments.ts";
import { FeishuMediaError, type FeishuMediaTransport } from "./feishuMediaTransport.ts";

const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
const privatePart = /^(?:\..*|credentials?|secrets?|feishu-app\.json)$/i;

export function mediaFormat(
  bytes: Buffer,
  kind: FeishuMediaAttachment["kind"],
  durationMs?: number,
) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  const imageMime = png
    ? "image/png"
    : jpeg
      ? "image/jpeg"
      : gif
        ? "image/gif"
        : webp
          ? "image/webp"
          : undefined;
  const imageDimensionsAllowed =
    png && bytes.length >= 24
      ? bytes.readUInt32BE(16) <= 12000 && bytes.readUInt32BE(20) <= 12000
      : gif && bytes.length >= 10
        ? bytes.readUInt16LE(6) <= 2000 && bytes.readUInt16LE(8) <= 2000
        : true;
  if (kind === "image" && imageMime && bytes.length <= 10_000_000 && imageDimensionsAllowed)
    return { uploadType: "image", messageType: "image", mime: imageMime } as const;
  if (
    kind === "audio" &&
    durationMs &&
    bytes.toString("ascii", 0, 4) === "OggS" &&
    bytes.subarray(0, 128).includes(Buffer.from("OpusHead"))
  )
    return { uploadType: "opus", messageType: "audio", mime: "audio/ogg" } as const;
  if (
    kind === "video" &&
    durationMs &&
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["isom", "iso2", "mp41", "mp42", "avc1"].includes(bytes.toString("ascii", 8, 12))
  )
    return { uploadType: "mp4", messageType: "media", mime: "video/mp4" } as const;
  return {
    uploadType: "stream",
    messageType: "file",
    mime: imageMime,
    ...(kind === "file"
      ? {}
      : {
          warning:
            "格式、大小或时长不满足飞书原生媒体要求，将按文件附件投递；实际结果以发送回执为准。",
        }),
  } as const;
}

export function makeFeishuMediaFiles(input: {
  repository: ManagedAttachmentRepositoryShape;
  attachmentsDir: string;
  baseDir: string;
  proofRoot?: string;
}) {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  return async (
    attachment: FeishuMediaAttachment,
    owner: { threadId: string; appId: string; senderId: string; workspaceRoot: string | null },
    transport: FeishuMediaTransport,
  ) => {
    const principal = feishuAttachmentPrincipal(owner.appId, owner.senderId);
    let filePath: string;
    let name: string;
    let expectedHash: string | null = null;
    if (attachment.attachmentId) {
      const blob = Option.getOrUndefined(
        await run(
          input.repository.findServerOwned({
            attachmentId: attachment.attachmentId,
            ownerThreadId: owner.threadId,
            ...principal,
            now: new Date().toISOString(),
          }),
        ),
      );
      if (!blob) throw new FeishuMediaError("attachment_missing_expired_or_forbidden");
      const resolved = resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: blob.relativePath,
      });
      if (!resolved) throw new FeishuMediaError("attachment_path_invalid");
      filePath = resolved;
      name = blob.originalName;
      expectedHash = blob.sha256;
    } else {
      const requested = attachment.path!;
      if (!path.isAbsolute(requested) || requested.includes("\0"))
        throw new FeishuMediaError("media_absolute_local_path_required");
      filePath = await fs.realpath(requested);
      const proofRoot = await fs
        .realpath(
          path.join(
            input.proofRoot ?? resolveCodexGeneratedImagesRoot(),
            "browser-proof",
            createHash("sha256").update(owner.threadId).digest("hex").slice(0, 24),
          ),
        )
        .catch(() => null);
      const workspace = owner.workspaceRoot
        ? await fs.realpath(owner.workspaceRoot).catch(() => null)
        : null;
      const baseDir = await fs.realpath(input.baseDir);
      const workspaceAllowed =
        workspace &&
        inside(workspace, filePath) &&
        !path
          .relative(workspace, filePath)
          .split(path.sep)
          .some((part) => privatePart.test(part));
      if (
        (!proofRoot || !inside(proofRoot, filePath)) &&
        (!workspaceAllowed || inside(baseDir, filePath))
      )
        throw new FeishuMediaError(
          "media_path_forbidden_use_thread_workspace_or_own_browser_proof",
        );
      if ((await fs.lstat(requested)).isSymbolicLink())
        throw new FeishuMediaError("media_symlink_forbidden");
      name = path.basename(filePath);
    }
    const handle = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
        throw new FeishuMediaError("media_empty_or_over_25MiB_or_not_file");
      bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset !== stat.size) throw new FeishuMediaError("media_changed_during_read");
      bytes = bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
    if (expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash)
      throw new FeishuMediaError("attachment_hash_mismatch");
    const format = mediaFormat(bytes, attachment.kind, attachment.durationMs);
    const reservation = await run(
      reserveManagedAttachmentUpload({
        type: format.messageType === "image" ? "image" : "file",
        threadId: owner.threadId,
        name,
        mimeType: format.mime ?? Mime.getType(name) ?? "application/octet-stream",
        reservedBytes: bytes.length,
        now: new Date().toISOString(),
        principal,
        repository: input.repository,
      }),
    );
    try {
      await run(
        persistReservedManagedAttachment({
          reservation,
          bytes,
          attachmentsDir: input.attachmentsDir,
          now: new Date().toISOString(),
          principal,
          repository: input.repository,
        }),
      );
      const key = await transport.upload({
        filePath: resolveAttachmentRelativePath({
          attachmentsDir: input.attachmentsDir,
          relativePath: reservation.relativePath,
        })!,
        name,
        type: format.uploadType,
        ...(attachment.durationMs && format.uploadType !== "stream"
          ? { durationMs: attachment.durationMs }
          : {}),
      });
      return {
        name,
        type: format.messageType,
        content: { [format.messageType === "image" ? "image_key" : "file_key"]: key },
        ...("warning" in format && format.warning ? { warning: format.warning } : {}),
      };
    } finally {
      await run(
        input.repository.cancelStaged({
          attachmentId: reservation.attachmentId,
          ...principal,
          reason: "feishu-outbound-upload-finished",
          requestedAt: new Date().toISOString(),
        }),
      );
    }
  };
}
