import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { FEISHU_APP_CONFIG_FILENAME, parseFeishuBridgeConfig } from "./feishuBridgeConfig.ts";
import { describeFeishuFailure, FeishuOutboundFailure } from "./feishuOutboundFailure.ts";
import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";

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

function requestKey(threadId: string, requestId: string): string {
  if (!requestId?.trim() || requestId.length > 200)
    throw new Error("requestId must contain 1–200 characters.");
  return digest(JSON.stringify([threadId, requestId]));
}

/** Narrow SDK adapter: never expose SDK request objects (which contain credentials) on failure. */
export async function createFeishuOutboundTransport(config: {
  appId: string;
  appSecret: string;
}): Promise<FeishuOutboundTransport> {
  const sdk = await import("@larksuiteoapi/node-sdk");
  // Bound every request (including token acquisition), without changing the shared SDK client.
  const httpInstance: HttpInstance = {
    request: async <T, R = T, D = unknown>(opts: HttpRequestOptions<D>): Promise<R> => {
      const result = await sdk.defaultHttpInstance.request<T, R, D>({
        ...opts,
        timeout: 30_000,
        signal: AbortSignal.timeout(30_000),
      });
      // Upload helpers otherwise discard nonzero business codes when unwrapping data.
      const code =
        typeof result === "object" && result !== null && "code" in result ? result.code : undefined;
      if (typeof code === "number" && code !== 0)
        throw Object.assign(new Error("Feishu API rejected the request."), { code });
      return result;
    },
    get: (url, opts) => httpInstance.request({ ...opts, url, method: "GET" }),
    delete: (url, opts) => httpInstance.request({ ...opts, url, method: "DELETE" }),
    head: (url, opts) => httpInstance.request({ ...opts, url, method: "HEAD" }),
    options: (url, opts) => httpInstance.request({ ...opts, url, method: "OPTIONS" }),
    post: (url, data, opts) => httpInstance.request({ ...opts, url, data, method: "POST" }),
    put: (url, data, opts) => httpInstance.request({ ...opts, url, data, method: "PUT" }),
    patch: (url, data, opts) => httpInstance.request({ ...opts, url, data, method: "PATCH" }),
  };
  const client = new sdk.Client({
    ...config,
    domain: sdk.Domain.Feishu,
    loggerLevel: sdk.LoggerLevel.fatal,
    httpInstance,
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
        throw Object.assign(new Error("Message send returned no receipt."), { code: result.code });
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
    private readonly retryDelay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Local durable evidence only: never uploads, retries, or requires the original file. */
  async status(requestId: string, context: { threadId: string }) {
    const key = requestKey(context.threadId, requestId);
    const raw = await readFile(path.join(this.receiptsDir, `${key}.json`), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    const receipt = raw === null ? null : Schema.decodeUnknownSync(Receipt)(JSON.parse(raw));
    const inProgress = this.active.has(key);
    const state = receipt?.messageId
      ? "confirmed"
      : receipt?.attemptedAt !== undefined
        ? "uncertain"
        : receipt?.resourceKey
          ? "uploaded"
          : receipt
            ? "prepared"
            : "not_found";
    const retryWindowExpired =
      state === "uncertain" && Date.now() - receipt!.attemptedAt! > 30 * 60_000;
    return {
      requestId,
      state,
      inProgress,
      ...(receipt?.messageId ? { messageId: receipt.messageId } : {}),
      ...(receipt?.attemptedAt !== undefined ? { attemptedAt: receipt.attemptedAt } : {}),
      nextAction:
        state === "confirmed"
          ? "Already confirmed by Feishu. Do not resend; this is not a read receipt."
          : inProgress
            ? "A send is in progress. Query this requestId again before retrying."
            : retryWindowExpired
              ? "Delivery is unknown and the safe retry window expired. Check Feishu before any new send."
              : state === "not_found"
                ? "No local receipt in this thread. This does not prove no send occurred in another thread or under another requestId."
                : "Not confirmed. If delivery remains authorized, retry the exact same content and requestId.",
    };
  }

  async send(
    input: FeishuSendInput,
    context: {
      threadId: string;
      workspaceRoot: string | null;
      assertActive: () => Promise<void>;
    },
  ): Promise<{ messageId: string; kind: FeishuSendInput["kind"]; replayed: boolean }> {
    const key = requestKey(context.threadId, input.requestId);
    if (!["text", "image", "file"].includes(input.kind))
      throw new Error("kind must be text, image or file.");
    if (input.kind === "text" ? Boolean(input.path) : Boolean(input.text))
      throw new Error("Send text or one attachment per request.");
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
    const attempt = async <T>(stage: "upload" | "send", action: () => Promise<T>): Promise<T> => {
      for (let index = 0; ; index++) {
        await authorize();
        try {
          return await action();
        } catch (error) {
          const details = describeFeishuFailure(error);
          if (!details.retryable || index >= 2 || (details.retryAfterMs ?? 0) > 5_000)
            throw new FeishuOutboundFailure(stage, input.requestId, details);
          await this.retryDelay(Math.max(250 * 2 ** index, details.retryAfterMs ?? 0));
        }
      }
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
        throw new Error(
          "Attachment resolves outside the active workspace. Send from the producing thread, or use an authorized artifact handoff into this workspace; a local Markdown link does not deliver it to Feishu.",
        );
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
      resourceKey = await attempt("upload", () =>
        input.kind === "image"
          ? transport.uploadImage(bytes!)
          : transport.uploadFile(bytes!, filename!),
      );
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
    const messageId = await attempt("send", () =>
      transport.send(recipient, input.kind, JSON.stringify(content), key.slice(0, 40)),
    );
    receipt = { ...receipt, messageId };
    await save();
    return { messageId, kind: input.kind, replayed: false };
  }
}
