import { Schema } from "effect";

/** Only the authenticated turn supplies the recipient; never accept a chat/user ID. */
export const FeishuMediaAttachment = Schema.Struct({
  path: Schema.optional(Schema.String),
  attachmentId: Schema.optional(Schema.String),
  kind: Schema.Literals(["image", "file", "audio", "video"]),
  durationMs: Schema.optional(Schema.Finite),
  coverPath: Schema.optional(Schema.String),
});
export type FeishuMediaAttachment = typeof FeishuMediaAttachment.Type;

export const FeishuMediaRequest = Schema.Struct({
  action: Schema.Literals(["send", "attach", "status", "cancel"]),
  requestId: Schema.String,
  attachments: Schema.optional(Schema.Array(FeishuMediaAttachment)),
  caption: Schema.optional(Schema.String),
});
export type FeishuMediaRequest = typeof FeishuMediaRequest.Type;

export interface FeishuMediaReceipt {
  readonly requestId: string;
  readonly state: "queued" | "sent" | "partial" | "failed" | "unknown" | "cancelled";
  readonly items: ReadonlyArray<{
    readonly name: string;
    readonly type: "text" | "image" | "file" | "audio" | "media";
    readonly state: string;
    readonly messageId?: string;
    readonly error?: string;
    readonly warning?: string;
  }>;
}
