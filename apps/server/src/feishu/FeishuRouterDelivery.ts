import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { OrchestrationCommand, type OrchestrationThread, type ThreadId } from "@synara/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
const Delivery = Schema.Struct({
  chatId: Schema.String,
  senderId: Schema.String,
  replyTo: Schema.String,
  command: OrchestrationCommand,
  replied: Schema.optional(Schema.Boolean),
  workerId: Schema.optional(Schema.String),
  sentMessageIds: Schema.optional(Schema.Array(Schema.String)),
  done: Schema.optional(Schema.Boolean),
  followup: Schema.optional(Schema.Boolean),
  completionText: Schema.optional(Schema.String),
});
type Delivery = typeof Delivery.Type;

/** Durable transport binding: Router replies have no provider turn to stream.
 * Save before admission so reconnects/clear cannot send an input to a new thread.
 * Feishu send failures remain pending. A lost remote send ACK can repeat a reply.
 */
export class FeishuRouterDelivery {
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly root: string,
    private readonly host: {
      accept(command: TurnStart): Promise<unknown>;
      readThread(id: ThreadId): Promise<OrchestrationThread | undefined>;
      readFollowup?(workerId: string, command: TurnStart): Promise<string | undefined>;
      allowed(senderId: string): boolean;
      send(
        chatId: string,
        text: string,
        replyTo: string,
      ): Promise<void | { messageId: string; chunkIds?: string[] }>;
    },
  ) {}
  stop() {
    this.stopped = true;
  }
  private key(commandId: string) {
    return createHash("sha256").update(commandId).digest("hex");
  }
  private file(key: string) {
    return path.join(this.root, `${key}.json`);
  }
  private async read(key: string): Promise<Delivery | undefined> {
    try {
      return Schema.decodeUnknownSync(Delivery)(JSON.parse(await readFile(this.file(key), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  private save(key: string, record: Delivery) {
    return Effect.runPromise(
      writeFileStringAtomically({ filePath: this.file(key), contents: JSON.stringify(record) }),
    );
  }
  async has(commandId: string) {
    return (await this.read(this.key(commandId))) !== undefined;
  }
  async resolveReference(chatId: string, senderId: string, messageId: string) {
    if (!this.host.allowed(senderId)) return;
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      const record = await this.read(file.slice(0, -5));
      if (
        record?.chatId === chatId &&
        record.senderId === senderId &&
        (record.replyTo === messageId || record.sentMessageIds?.includes(messageId))
      )
        return record.command.commandId;
    }
  }
  private async locked(key: string, work: () => Promise<void>) {
    const existing = this.active.get(key);
    if (existing) return existing;
    const result = work();
    this.active.set(key, result);
    try {
      await result;
    } finally {
      this.active.delete(key);
    }
  }
  async enqueue(input: { chatId: string; senderId: string; replyTo: string; command: TurnStart }) {
    if (this.stopped) throw new Error("Feishu Router is shutting down.");
    const key = this.key(input.command.commandId);
    await this.locked(key, async () => {
      const record = (await this.read(key)) ?? input;
      if (!this.host.allowed(record.senderId) || this.stopped) return;
      await this.save(key, record);
      if (record.command.type !== "thread.turn.start") throw new Error("Invalid Router delivery.");
      await this.host.accept(record.command);
    });
  }
  async flush() {
    if (this.stopped) return;
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // One slow transport delivery must not delay other accepted messages.
    await Promise.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))
        .map(async (file) => {
          const key = file.slice(0, -5);
          if (this.active.has(key)) return;
          await this.locked(key, async () => {
            let record = await this.read(key);
            if (!record || record.done || this.stopped || !this.host.allowed(record.senderId))
              return;
            if (record.command.type !== "thread.turn.start")
              throw new Error("Invalid Router delivery.");
            const command = record.command;
            await this.host.accept(command);
            const thread = await this.host.readThread(record.command.threadId);
            if (!thread || thread.deletedAt || thread.archivedAt) return;
            if (!record.replied) {
              const reply = thread.messages.find(
                (m) => m.id === `router-${key}` || m.id === `router-failure-${key}`,
              );
              if (!reply || this.stopped || !this.host.allowed(record.senderId)) return;
              const sent = await this.host.send(record.chatId, reply.text, record.replyTo);
              const followupId = reply.text.match(
                /^(?:Router[：:]\s*)?(?:修改已加入任务 |已向任务 )([a-zA-Z0-9_-]+)(?: 的队列。| 提交修改，)/u,
              )?.[1];
              const workerId = /^(?:Router[：:]\s*)?已创建独立任务/u.test(reply.text)
                ? reply.text.match(/\/tasks\?thread=([a-zA-Z0-9_-]+)/u)?.[1]
                : followupId;
              record = {
                ...record,
                replied: true,
                sentMessageIds: sent ? [sent.messageId, ...(sent.chunkIds ?? [])] : [],
                ...(workerId ? { workerId, followup: Boolean(followupId) } : { done: true }),
              };
              await this.save(key, record);
            }
            if (record.workerId && !record.done) {
              const completionText =
                record.completionText ??
                (record.followup
                  ? await this.host.readFollowup?.(record.workerId, command)
                  : thread.messages.find((m) => m.id === `router-completion:${record!.workerId}`)
                      ?.text);
              if (!completionText || this.stopped || !this.host.allowed(record.senderId)) return;
              record = { ...record, completionText };
              await this.save(key, record);
              const sent = await this.host.send(record.chatId, completionText, record.replyTo);
              await this.save(key, {
                ...record,
                done: true,
                sentMessageIds: [
                  ...(record.sentMessageIds ?? []),
                  ...(sent ? [sent.messageId, ...(sent.chunkIds ?? [])] : []),
                ],
              });
            }
          });
        }),
    );
  }
}
