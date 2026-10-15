import path from "node:path";
import type { Readable } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@synara/contracts";
import { Effect } from "effect";

import { attachmentPrincipalForSession } from "../managedAttachmentPrincipal.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
  type BinaryChatAttachment,
} from "../managedAttachmentStore.ts";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments.ts";

export interface FeishuInboundResource {
  readonly type: "image" | "file" | "audio" | "video" | "sticker";
  readonly fileKey: string;
  readonly fileName?: string;
}

type ResourceResponse = {
  readonly headers: unknown;
  readonly getReadableStream: () => Readable;
};

/** Sender was authenticated by the bridge allowlist before staging or dispatch. */
export const feishuAttachmentPrincipal = (appId: string, senderId: string) =>
  attachmentPrincipalForSession(`feishu:${appId}:${senderId}`);

function contentType(headers: unknown): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  return typeof value === "string" ? value.split(";")[0]?.trim().toLowerCase() : undefined;
}

function imageMime(bytes: Buffer, header: string | undefined): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (header?.startsWith("image/")) return header;
  throw new Error("飞书图片未返回可识别的图片格式；本条消息尚未提交。");
}

async function readResource(response: ResourceResponse, maxBytes: number): Promise<Buffer> {
  const stream = response.getReadableStream();
  const timer = setTimeout(
    () => stream.destroy(new Error("飞书附件下载超时；本条消息尚未提交。")),
    60_000,
  );
  timer.unref();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes)
        throw new Error(`附件超过 ${maxBytes / 1024 / 1024} MiB；本条消息尚未提交。`);
      chunks.push(bytes);
    }
    if (length === 0) throw new Error("飞书附件为空；本条消息尚未提交。");
    return Buffer.concat(chunks, length);
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

/** Reuse the web upload store, quota, owner binding and turn claim; never expose Feishu keys as URLs. */
export async function withFeishuInboundAttachments<A>(input: {
  readonly appId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly resources: ReadonlyArray<FeishuInboundResource>;
  readonly attachmentsDir: string;
  readonly repository: ManagedAttachmentRepositoryShape;
  readonly getResource: (request: {
    path: { message_id: string; file_key: string };
    params: { type: "image" | "file" };
  }) => Promise<ResourceResponse>;
  readonly submit: (
    attachments: BinaryChatAttachment[],
    principal: ReturnType<typeof feishuAttachmentPrincipal>,
  ) => Promise<A>;
}): Promise<A> {
  if (input.resources.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    throw new Error(
      `每条消息最多 ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} 个附件；本条消息尚未提交。`,
    );
  }
  if (input.resources.some((resource) => resource.type === "sticker")) {
    throw new Error("飞书暂不支持下载表情包资源；本条消息尚未提交，请作为图片发送。");
  }
  const principal = feishuAttachmentPrincipal(input.appId, input.senderId);
  const reservations: string[] = [];
  const attachments: BinaryChatAttachment[] = [];
  const run = <T, E>(effect: Effect.Effect<T, E>) => Effect.runPromise(effect);
  try {
    for (const [index, resource] of input.resources.entries()) {
      const type = resource.type === "image" ? "image" : "file";
      const maxBytes =
        type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      // message.resource.get downloads user-sent resources. channel.downloadResource
      // instead uses image.get/file.get (bot-uploaded resources), which is not this API.
      const response = await input.getResource({
        path: { message_id: input.messageId, file_key: resource.fileKey },
        params: { type },
      });
      const header = contentType(response.headers);
      const name =
        path
          .basename((resource.fileName || `${resource.type}-${index + 1}`).replaceAll("\\", "/"))
          .replaceAll("\0", "_")
          .replace(/[\r\n]/gu, "_")
          .slice(0, 255) || `${resource.type}-${index + 1}`;
      // Reserve before consuming the body so the existing aggregate quota also
      // bounds multiple concurrent inbound messages. Refusal closes the stream.
      let reservation;
      try {
        reservation = await run(
          reserveManagedAttachmentUpload({
            type,
            name,
            threadId: input.threadId,
            mimeType:
              type === "image"
                ? header?.startsWith("image/")
                  ? header
                  : "image/png"
                : header || Mime.getType(name) || "application/octet-stream",
            reservedBytes: maxBytes,
            now: new Date().toISOString(),
            principal,
            repository: input.repository,
          }),
        );
      } catch (cause) {
        response.getReadableStream().destroy();
        throw cause;
      }
      reservations.push(reservation.attachmentId);
      const bytes = await readResource(response, maxBytes);
      // An image served as octet-stream needs its actual type/extension before
      // persistence; do not label a JPEG as PNG merely because it lacks a name.
      if (type === "image") {
        const actualMime = imageMime(bytes, header);
        if (actualMime !== reservation.mimeType) {
          await run(
            input.repository.cancelStaged({
              attachmentId: reservation.attachmentId,
              ...principal,
              reason: "image-type-resolved",
              requestedAt: new Date().toISOString(),
            }),
          );
          reservation = await run(
            reserveManagedAttachmentUpload({
              type,
              name,
              mimeType: actualMime,
              threadId: input.threadId,
              reservedBytes: bytes.length,
              now: new Date().toISOString(),
              principal,
              repository: input.repository,
            }),
          );
          reservations.push(reservation.attachmentId);
        }
      }
      attachments.push(
        await run(
          persistReservedManagedAttachment({
            reservation,
            bytes,
            attachmentsDir: input.attachmentsDir,
            now: new Date().toISOString(),
            principal,
            repository: input.repository,
          }),
        ),
      );
    }
    return await input.submit(attachments, principal);
  } catch (cause) {
    // Already-claimed bytes survive a lost dispatch acknowledgement; cleanup
    // only cancels unclaimed staging, just like the existing upload endpoint.
    await Promise.all(
      reservations.map((attachmentId) =>
        run(
          input.repository
            .cancelStaged({
              attachmentId,
              ...principal,
              reason: "feishu-message-not-submitted",
              requestedAt: new Date().toISOString(),
            })
            .pipe(Effect.ignore),
        ),
      ),
    );
    throw cause;
  }
}
