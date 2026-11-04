import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type {
  FeishuMediaAttachment,
  FeishuMediaReceipt,
  FeishuMediaRequest,
} from "@synara/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { FeishuMediaError, type FeishuMediaTransport } from "./feishuMediaTransport.ts";

export interface FeishuMediaBinding {
  threadId: string;
  messageId: string;
  appId: string;
  senderId: string;
  chatId: string;
}
export interface FeishuMediaTurn {
  messageId: string | null;
  state: string;
}
type Prepared = {
  name: string;
  type: "image" | "file" | "audio" | "media";
  content: Record<string, unknown>;
  warning?: string;
};
type Item = {
  name: string;
  type: "text" | Prepared["type"];
  state: "preparing" | "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled";
  content?: Record<string, unknown>;
  uuid: string;
  messageId?: string;
  error?: string;
  warning?: string;
  startedAt?: number;
};
type RecordEntry = {
  binding: FeishuMediaBinding;
  turnId: string;
  requestId: string;
  fingerprint: string;
  action: "send" | "attach";
  createdAt: number;
  cancelled: boolean;
  items: Item[];
};
type Host = {
  turn(threadId: string, turnId: string): Promise<FeishuMediaTurn | undefined>;
  transport(binding: FeishuMediaBinding): Promise<FeishuMediaTransport>;
  prepare(
    attachment: FeishuMediaAttachment,
    binding: FeishuMediaBinding,
    transport: FeishuMediaTransport,
    workspaceRoot: string | null,
  ): Promise<Prepared>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const errorCode = (error: unknown) => {
  if (error instanceof FeishuMediaError) return error.code;
  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOENT") return "media_file_missing_or_expired";
  if (code === "EACCES" || code === "EPERM") return "media_file_permission_denied";
  if (code === "ENOSPC") return "media_storage_full";
  return "media_local_or_storage_error";
};

/** Small channel-specific outbox. Provider completion and peer outboxes target other
 * protocols; reuse their atomic persistence boundary, not their routing/receipt tables. */
export class FeishuMedia {
  private bindings = new Map<string, FeishuMediaBinding>();
  private records = new Map<string, RecordEntry>();
  private cancellations = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly host: Host,
  ) {}
  private key(threadId: string, requestId: string) {
    return hash(JSON.stringify([threadId, requestId]));
  }
  private serial<A>(work: () => Promise<A>): Promise<A> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private save(name: string, value: unknown) {
    return Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.directory, `${name}.json`),
        contents: JSON.stringify(value),
      }),
    );
  }
  private persist(record: RecordEntry) {
    return this.save(`request-${this.key(record.binding.threadId, record.requestId)}`, record);
  }
  async initialize() {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((name) =>
      /^(binding|request)-[a-f0-9]{64}\.json$/.test(name),
    )) {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
      if (name.startsWith("binding-")) this.bindings.set(value.messageId, value);
      else {
        const record = value as RecordEntry;
        for (const item of record.items) {
          if (item.state === "sending") {
            item.state = "unknown";
            item.error = "process_lost_after_send_started";
          }
          if (item.state === "preparing") {
            item.state = "failed";
            item.error = "process_lost_during_upload";
          }
        }
        this.records.set(this.key(record.binding.threadId, record.requestId), record);
        await this.persist(record);
      }
    }
  }
  bind(binding: FeishuMediaBinding) {
    return this.serial(async () => {
      const existing = this.bindings.get(binding.messageId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
        throw new FeishuMediaError("feishu_binding_conflict");
      await this.save(`binding-${hash(binding.messageId)}`, binding);
      this.bindings.set(binding.messageId, binding);
    });
  }
  private async binding(threadId: string, turnId: string) {
    const turn = await this.host.turn(threadId, turnId);
    const binding = turn?.messageId ? this.bindings.get(turn.messageId) : undefined;
    if (!binding || binding.threadId !== threadId || turn?.state !== "running")
      throw new FeishuMediaError("no_active_feishu_turn_binding");
    return binding;
  }
  private receipt(record: RecordEntry): FeishuMediaReceipt {
    const states = record.items.map((item) => item.state);
    const state =
      states.includes("unknown") || states.includes("sending")
        ? "unknown"
        : states.includes("queued") || states.includes("preparing")
          ? "queued"
          : states.every((state) => state === "sent")
            ? "sent"
            : states.includes("sent")
              ? "partial"
              : states.every((state) => state === "cancelled")
                ? "cancelled"
                : "failed";
    return {
      requestId: record.requestId,
      state,
      items: record.items.map(({ name, type, state, messageId, error, warning }) => ({
        name,
        type,
        state,
        ...(messageId ? { messageId } : {}),
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
      })),
    };
  }
  async request(
    threadId: string,
    turnId: string,
    request: FeishuMediaRequest,
    workspaceRoot: string | null,
  ): Promise<FeishuMediaReceipt> {
    const binding = await this.binding(threadId, turnId);
    const key = this.key(threadId, request.requestId);
    const previous = this.records.get(key);
    if (
      previous &&
      (previous.binding.appId !== binding.appId ||
        previous.binding.senderId !== binding.senderId ||
        previous.binding.chatId !== binding.chatId)
    )
      throw new FeishuMediaError("media_request_owner_mismatch");
    // Cancellation is observable between uploads/sends even when the serial queue is busy.
    if (request.action === "cancel" && previous) this.cancellations.add(key);
    return this.serial(async () => {
      const existing = this.records.get(key);
      if (request.action === "status" || request.action === "cancel") {
        if (!existing) throw new FeishuMediaError("media_request_not_found");
        if (request.action === "cancel") {
          existing.cancelled = true;
          this.cancelRemaining(existing);
          await this.persist(existing);
        } else await this.reconcile(existing);
        return this.receipt(existing);
      }
      const fingerprint = hash(
        JSON.stringify({
          action: request.action,
          attachments: request.attachments,
          caption: request.caption,
        }),
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.turnId !== turnId)
          throw new FeishuMediaError("media_request_id_conflict_use_status");
        return this.receipt(existing);
      }
      await this.binding(threadId, turnId);
      const transport = await this.host.transport(binding);
      const record: RecordEntry = {
        binding,
        turnId,
        requestId: request.requestId,
        fingerprint,
        action: request.action,
        createdAt: Date.now(),
        cancelled: false,
        items: [],
      };
      if (request.caption)
        record.items.push({
          name: "说明",
          type: "text",
          state: "queued",
          content: { text: request.caption },
          uuid: hash(`${key}:caption`).slice(0, 40),
        });
      for (const [index, attachment] of request.attachments!.entries())
        record.items.push({
          name: attachment.path ? path.basename(attachment.path) : attachment.attachmentId!,
          type: attachment.kind === "video" ? "media" : attachment.kind,
          state: "preparing",
          uuid: hash(`${key}:${index}`).slice(0, 40),
        });
      await this.persist(record);
      this.records.set(key, record);
      for (const [index, attachment] of request.attachments!.entries()) {
        const item = record.items[index + (request.caption ? 1 : 0)]!;
        try {
          if (this.cancellations.has(key)) {
            item.state = "cancelled";
            continue;
          }
          await this.binding(threadId, turnId);
          await this.host.transport(binding); // recheck current owner allowlist before reading/uploading
          const prepared = await this.host.prepare(attachment, binding, transport, workspaceRoot);
          Object.assign(item, prepared, { state: "queued" });
          if (attachment.coverPath && prepared.type === "media") {
            const cover = await this.host.prepare(
              { path: attachment.coverPath, kind: "image" },
              binding,
              transport,
              workspaceRoot,
            );
            if (cover.type !== "image")
              throw new FeishuMediaError("video_cover_requires_supported_image");
            item.content!.image_key = cover.content.image_key;
          }
        } catch (error) {
          item.state = "failed";
          item.error = errorCode(error);
        }
        await this.persist(record);
      }
      if (request.action === "send") await this.deliver(record);
      else if (this.cancellations.has(key)) {
        record.cancelled = true;
        this.cancelRemaining(record);
        await this.persist(record);
      }
      return this.receipt(record);
    });
  }
  private cancelRemaining(record: RecordEntry) {
    for (const item of record.items)
      if (item.state === "queued" || item.state === "preparing") item.state = "cancelled";
  }
  private async reconcile(record: RecordEntry) {
    const transport = await this.host.transport(record.binding);
    for (const item of record.items) {
      if (item.state !== "unknown" || !item.content || !item.startedAt) continue;
      const mediaKey = item.content.file_key ?? item.content.image_key;
      const reusedKey =
        mediaKey &&
        [...this.records.values()].some(
          (other) =>
            other.binding.appId === record.binding.appId &&
            other.binding.chatId === record.binding.chatId &&
            other.items.some(
              (candidate) =>
                candidate.uuid !== item.uuid &&
                (candidate.content?.file_key ?? candidate.content?.image_key) === mediaKey,
            ),
        );
      if (reusedKey) {
        item.error = "reconciliation_ambiguous_media_key";
        continue;
      }
      try {
        const id = await transport.reconcile(
          record.binding.chatId,
          record.binding.appId,
          item.type,
          item.content,
          item.startedAt,
        );
        if (id) {
          item.messageId = id;
          item.state = "sent";
          delete item.error;
        }
      } catch (error) {
        item.error = `reconciliation_unavailable:${errorCode(error)}`;
      }
    }
    await this.persist(record);
  }
  private async deliver(record: RecordEntry) {
    const key = this.key(record.binding.threadId, record.requestId);
    for (const item of record.items) {
      if (item.state === "unknown" || item.state === "sending") {
        this.cancelRemaining(record);
        break;
      }
      if (item.state !== "queued") continue;
      try {
        const turn = await this.host.turn(record.binding.threadId, record.turnId);
        if (
          record.cancelled ||
          this.cancellations.has(key) ||
          Date.now() - record.createdAt > 24 * 60 * 60_000 ||
          turn?.messageId !== record.binding.messageId ||
          (record.action === "attach" ? turn.state !== "completed" : turn.state !== "running")
        ) {
          record.cancelled = true;
          this.cancelRemaining(record);
          break;
        }
        const transport = await this.host.transport(record.binding);
        item.state = "sending";
        item.startedAt = Date.now();
        await this.persist(record); // write-ahead fence: never send if persistence fails
        try {
          item.messageId = await transport.send(
            record.binding.chatId,
            item.type,
            item.content!,
            item.uuid,
          );
          item.state = "sent";
        } catch (error) {
          item.state = error instanceof FeishuMediaError && !error.uncertain ? "failed" : "unknown";
          item.error = errorCode(error);
        }
        await this.persist(record);
        if (item.state === "unknown") {
          this.cancelRemaining(record);
          break;
        }
      } catch (error) {
        // Includes a lost local receipt write after remote success: never reset to queued.
        if (["sending", "sent", "unknown"].includes(item.state)) {
          item.state = "unknown";
          item.error = "receipt_persistence_unknown";
          this.cancelRemaining(record);
          break;
        }
        item.state = "failed";
        item.error = errorCode(error);
      }
    }
    await this.persist(record);
  }
  /** Called by terminal-turn bridge and recovery poll; only the exact completed turn releases attachments. */
  drain() {
    return this.serial(async () => {
      for (const record of this.records.values()) {
        if (!record.items.some((item) => item.state === "queued")) continue;
        const turn = await this.host.turn(record.binding.threadId, record.turnId);
        if (
          record.action === "attach" &&
          (turn?.state === "running" || turn?.state === "pending") &&
          Date.now() - record.createdAt < 24 * 60 * 60_000
        )
          continue;
        await this.deliver(record);
      }
    });
  }
  receiptsForMessage(messageId: string): FeishuMediaReceipt[] {
    return [...this.records.values()]
      .filter((record) => record.binding.messageId === messageId)
      .map((record) => this.receipt(record));
  }
}
