import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { FEISHU_APP_CONFIG_FILENAME, parseFeishuBridgeConfig } from "./feishuBridgeConfig.ts";

export interface FeishuSendInput {
  requestId: string;
  kind: "text" | "image" | "file";
  text?: string;
  path?: string;
  recipientOpenId?: string;
}

export interface FeishuOutboundTransport {
  uploadImage(bytes: Buffer): Promise<string>;
  uploadFile(bytes: Buffer, name: string): Promise<string>;
  send(
    recipient: string,
    kind: FeishuSendInput["kind"],
    content: string,
    uuid: string,
  ): Promise<string>;
}

const Receipt = Schema.Struct({
  digest: Schema.String,
  resourceKey: Schema.optional(Schema.String),
  attemptedAt: Schema.optional(Schema.Number),
  messageId: Schema.optional(Schema.String),
});
type Receipt = typeof Receipt.Type;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Narrow SDK adapter: never expose SDK request objects (which contain credentials) on failure. */
export async function createFeishuOutboundTransport(config: {
  appId: string;
  appSecret: string;
}): Promise<FeishuOutboundTransport> {
  const sdk = await import("@larksuiteoapi/node-sdk");
  const client = new sdk.Client({
    ...config,
    domain: sdk.Domain.Feishu,
    loggerLevel: sdk.LoggerLevel.fatal,
  });
  return {
    async uploadImage(bytes) {
      const result = await client.im.v1.image.create({
        data: { image_type: "message", image: bytes },
      });
      if (!result?.image_key) throw new Error("Image upload returned no key.");
      return result.image_key;
    },
    async uploadFile(bytes, name) {
      const result = await client.im.v1.file.create({
        data: { file_type: "stream", file_name: name, file: bytes },
      });
      if (!result?.file_key) throw new Error("File upload returned no key.");
      return result.file_key;
    },
    async send(recipient, kind, content, uuid) {
      const result = await client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: recipient, msg_type: kind, content, uuid },
      });
      if (result.code !== 0 || !result.data?.message_id)
        throw new Error("Message send returned no receipt.");
      return result.data.message_id;
    },
  };
}

/** Explicit, owner-requested sends; ordinary assistant markdown never triggers file uploads. */
export class FeishuOutbound {
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(
    private readonly baseDir: string,
    private readonly receiptsDir: string,
    private readonly transport = createFeishuOutboundTransport,
  ) {}

  async send(
    input: FeishuSendInput,
    context: {
      threadId: string;
      workspaceRoot: string | null;
      assertActive: () => Promise<void>;
    },
  ): Promise<{ messageId: string; kind: FeishuSendInput["kind"]; replayed: boolean }> {
    if (!input.requestId?.trim() || input.requestId.length > 200)
      throw new Error("requestId must contain 1–200 characters.");
    if (!["text", "image", "file"].includes(input.kind))
      throw new Error("kind must be text, image or file.");
    if (input.kind === "text" ? Boolean(input.path) : Boolean(input.text))
      throw new Error("Send text or one attachment per request.");
    const key = digest(JSON.stringify([context.threadId, input.requestId]));
    // Serialize same-ID calls, then validate their content against the durable receipt.
    while (this.active.has(key)) await this.active.get(key)?.catch(() => undefined);
    const operation = this.perform(key, input, context);
    this.active.set(key, operation);
    try {
      return await operation;
    } finally {
      this.active.delete(key);
    }
  }

  private async perform(
    key: string,
    input: FeishuSendInput,
    context: {
      workspaceRoot: string | null;
      assertActive: () => Promise<void>;
    },
  ) {
    const loadConfig = async () => {
      const raw = await readFile(path.join(this.baseDir, FEISHU_APP_CONFIG_FILENAME), "utf8").catch(
        () => null,
      );
      const parsed = parseFeishuBridgeConfig(raw);
      if (parsed.kind !== "ready") throw new Error(`Feishu unavailable: ${parsed.reason}`);
      return parsed.config;
    };
    const config = await loadConfig();
    const recipient =
      input.recipientOpenId ??
      (config.allowedOpenIds.length === 1 ? config.allowedOpenIds[0] : undefined);
    if (!recipient || !config.allowedOpenIds.includes(recipient))
      throw new Error(
        "Choose an explicitly configured allowedOpenIds recipient; no group or arbitrary recipient is permitted.",
      );
    const authorize = async () => {
      await context.assertActive();
      const current = await loadConfig();
      if (
        current.appId !== config.appId ||
        current.appSecret !== config.appSecret ||
        !current.allowedOpenIds.includes(recipient)
      )
        throw new Error("Feishu configuration or recipient authorization changed; send cancelled.");
    };
    await authorize();
    let bytes: Buffer | undefined;
    let filename: string | undefined;
    if (input.kind === "text") {
      if (!input.text?.trim() || Buffer.byteLength(input.text) > 20_000)
        throw new Error("Text must contain 1–20000 UTF-8 bytes.");
    } else {
      if (!context.workspaceRoot || !input.path)
        throw new Error("An attachment path and an active workspace are required.");
      const root = await realpath(context.workspaceRoot);
      const file = await realpath(path.resolve(root, input.path));
      const relative = path.relative(root, file);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Attachment resolves outside the active workspace.");
      const handle = await open(
        file,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const stat = await handle.stat();
        const limit = input.kind === "image" ? 10 * 1024 * 1024 : 25 * 1024 * 1024;
        if (!stat.isFile() || stat.size === 0 || stat.size > limit)
          throw new Error(
            `Attachment must be a nonempty regular file, at most ${limit / 1024 / 1024} MiB.`,
          );
        // Bound the read even if the source file grows while it is being read.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length !== stat.size)
          throw new Error("Attachment changed while reading; retry with a stable file.");
        bytes = buffer.subarray(0, length);
        filename = path.basename(file);
      } finally {
        await handle.close();
      }
    }
    const fingerprint = digest(
      JSON.stringify([
        config.appId,
        recipient,
        input.kind,
        input.text ?? null,
        filename ?? null,
        bytes ? digest(bytes) : null,
      ]),
    );
    const receiptPath = path.join(this.receiptsDir, `${key}.json`);
    const previous = await readFile(receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let receipt: Receipt = previous
      ? Schema.decodeUnknownSync(Receipt)(JSON.parse(previous))
      : { digest: fingerprint };
    if (receipt.digest !== fingerprint)
      throw new Error("requestId is already bound to different content or recipient.");
    if (receipt.messageId)
      return { messageId: receipt.messageId, kind: input.kind, replayed: true };
    // Do not retry an uncertain send indefinitely beyond Feishu's UUID deduplication window.
    if (receipt.attemptedAt && Date.now() - receipt.attemptedAt > 30 * 60_000)
      throw new Error(
        "Previous send outcome is unknown and its safe retry window has expired. Check Feishu before issuing a new requestId.",
      );
    const save = () =>
      Effect.runPromise(
        writeFileStringAtomically({ filePath: receiptPath, contents: JSON.stringify(receipt) }),
      );
    await save();
    await authorize();
    const transport = await this.transport(config);
    if (bytes && !receipt.resourceKey) {
      let resourceKey: string;
      try {
        resourceKey =
          input.kind === "image"
            ? await transport.uploadImage(bytes)
            : await transport.uploadFile(bytes, filename!);
      } catch {
        throw new Error(
          "Feishu attachment upload failed. Check the image/file format and bot resource permissions; no message was sent.",
        );
      }
      receipt = { ...receipt, resourceKey };
      await save();
    }
    await authorize();
    receipt = { ...receipt, attemptedAt: receipt.attemptedAt ?? Date.now() };
    await save();
    const content =
      input.kind === "text"
        ? { text: input.text }
        : input.kind === "image"
          ? { image_key: receipt.resourceKey }
          : { file_key: receipt.resourceKey };
    let messageId: string;
    try {
      messageId = await transport.send(
        recipient,
        input.kind,
        JSON.stringify(content),
        key.slice(0, 40),
      );
    } catch {
      throw new Error(
        "Feishu send did not return a confirmed message ID. Retry only with the same requestId; delivery may already have occurred.",
      );
    }
    receipt = { ...receipt, messageId };
    await save();
    return { messageId, kind: input.kind, replayed: false };
  }
}
