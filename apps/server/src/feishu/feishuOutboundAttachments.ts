import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { parseFeishuBridgeConfig, type FeishuBridgeConfig } from "./feishuBridgeConfig.ts";

export interface FeishuAttachmentInput {
  threadId: string;
  workspaceRoot: string;
  filePath: string;
  kind: "image" | "file";
  idempotencyKey: string;
}
export interface FeishuAttachmentTarget {
  chatId: string;
  senderId: string;
  replyTo: string;
}

/** Resolve only the calling task's durable inbound binding; never guess a recipient. */
export async function resolveFeishuAttachmentTarget(stateDir: string, threadId: string) {
  const directory = path.join(stateDir, "feishu-router-delivery");
  const matches: FeishuAttachmentTarget[] = [];
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
    const record = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    if (record.workerId !== threadId && record.command?.threadId !== threadId) continue;
    if (
      typeof record.chatId !== "string" ||
      typeof record.senderId !== "string" ||
      typeof record.replyTo !== "string"
    )
      continue;
    matches.push({ chatId: record.chatId, senderId: record.senderId, replyTo: record.replyTo });
  }
  const recipients = new Set(matches.map((match) => `${match.chatId}:${match.senderId}`));
  if (recipients.size !== 1)
    throw new Error("No unambiguous Feishu private-chat binding for this task.");
  return matches.at(-1)!;
}

export function makeFeishuAttachmentSender(options: {
  baseDir: string;
  stateDir: string;
  resolveTarget?: (threadId: string) => Promise<FeishuAttachmentTarget>;
  send?: (
    config: FeishuBridgeConfig,
    target: FeishuAttachmentTarget,
    input: { kind: "image" | "file"; bytes: Buffer; fileName: string },
  ) => Promise<{ messageId: string }>;
}) {
  const active = new Map<string, Promise<{ messageId: string; fileName: string; kind: string }>>();
  const readConfig = async () => {
    const parsed = parseFeishuBridgeConfig(
      await readFile(path.join(options.baseDir, "feishu-app.json"), "utf8"),
    );
    if (parsed.kind !== "ready") throw new Error("Feishu is not configured.");
    return parsed.config;
  };
  const send =
    options.send ??
    (async (config, target, input) => {
      const sdk = await import("@larksuiteoapi/node-sdk");
      const channel = sdk.createLarkChannel({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: sdk.Domain.Feishu,
        loggerLevel: sdk.LoggerLevel.error,
      });
      // SDK send uploads a Buffer and posts the native image/file; no websocket is opened.
      return channel.send(
        target.chatId,
        input.kind === "image"
          ? { image: { source: input.bytes } }
          : { file: { source: input.bytes, fileName: input.fileName } },
        { replyTo: target.replyTo },
      );
    });
  return async (
    input: FeishuAttachmentInput,
    assertActive: () => Promise<void> = async () => {},
  ) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(input.idempotencyKey))
      throw new Error("Invalid idempotencyKey.");
    const key = createHash("sha256")
      .update(`${input.threadId}:${input.idempotencyKey}`)
      .digest("hex");
    // Serialize same-key calls, then validate their bytes instead of sharing an unchecked result.
    await active.get(key)?.catch(() => undefined);
    const work = async () => {
      const target = await (
        options.resolveTarget ??
        ((threadId) => resolveFeishuAttachmentTarget(options.stateDir, threadId))
      )(input.threadId);
      const config = await readConfig();
      if (!config.allowedOpenIds.includes(target.senderId))
        throw new Error("Feishu sender is no longer allowed.");
      const root = await realpath(input.workspaceRoot);
      const file = await realpath(path.resolve(root, input.filePath));
      const relative = path.relative(root, file);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      )
        throw new Error("Attachment must be inside this task's workspace.");
      const info = await stat(file);
      const limit = (input.kind === "image" ? 10 : 25) * 1024 * 1024;
      if (!info.isFile() || info.size === 0 || info.size > limit)
        throw new Error("Attachment is empty, not a regular file, or exceeds the size limit.");
      const bytes = await readFile(file);
      if (bytes.length > limit) throw new Error("Attachment exceeds the size limit.");
      const fileName = path.basename(file);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([target.chatId, target.senderId, input.kind, fileName]))
        .update(bytes)
        .digest("hex");
      const directory = path.join(options.stateDir, "feishu-outbound");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const receiptPath = path.join(directory, `${key}.json`);
      let receipt: { fingerprint: string; messageId?: string } | undefined;
      try {
        receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new Error("idempotencyKey was already used for different content.");
        if (!receipt.messageId)
          throw new Error(
            "Previous delivery outcome is unknown. Check Feishu before sending again.",
          );
        return { messageId: receipt.messageId, fileName, kind: input.kind };
      }
      await assertActive();
      const current = await readConfig();
      if (!current.allowedOpenIds.includes(target.senderId) || current.appId !== config.appId)
        throw new Error("Feishu authorization changed.");
      // Exclusive durable intent prevents duplicate sends across restarts/concurrent callers.
      const intent = await open(receiptPath, "wx", 0o600);
      try {
        await intent.writeFile(JSON.stringify({ fingerprint }));
        await intent.sync();
      } finally {
        await intent.close();
      }
      let result: { messageId: string };
      try {
        result = await send(current, target, { kind: input.kind, bytes, fileName });
      } catch {
        throw new Error(
          "Feishu attachment delivery failed or its result is unknown; inspect Feishu before retrying with a new key.",
        );
      }
      if (!result.messageId) throw new Error("Feishu did not return a message receipt.");
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: receiptPath,
          contents: JSON.stringify({ fingerprint, messageId: result.messageId }),
        }),
      );
      return { messageId: result.messageId, fileName, kind: input.kind };
    };
    const promise = work();
    active.set(key, promise);
    try {
      return await promise;
    } finally {
      if (active.get(key) === promise) active.delete(key);
    }
  };
}
