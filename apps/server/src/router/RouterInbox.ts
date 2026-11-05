import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CommandId, MessageId, OrchestrationCommand } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import {
  presentRouterResponse,
  routerResultInput,
  routerResultFallback,
  type RouterResult,
} from "./RouterPresentation.ts";
import { AgentRouter, type AgentRouterHost } from "./AgentRouter.ts";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
const Record = Schema.Struct({
  fingerprint: Schema.String,
  command: Schema.optional(OrchestrationCommand),
  sequence: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  errorCreatedAt: Schema.optional(Schema.String),
});
type Record = typeof Record.Type;

/** Durable owner admission. The returned receipt acknowledges storage, never task completion.
 * Recovery reuses router plans + engine receipts + gateway creation saga ids.
 */
export class RouterInbox {
  private readonly admissions = new Map<string, Promise<{ sequence: number; routed: true }>>();
  private readonly running = new Set<string>();
  private stopped = false;
  constructor(
    private readonly root: string,
    private readonly router: AgentRouter,
    private readonly host: AgentRouterHost,
  ) {}

  readDelivery(command: TurnStart) {
    return this.router.readDelivery(command);
  }

  async presentResult(command: TurnStart, result: RouterResult) {
    const fallback = routerResultFallback(result);
    if (this.stopped) return fallback;
    const source = await this.host.readThread(command.threadId);
    if (!source || source.deletedAt || source.archivedAt) return fallback;
    return presentRouterResponse(
      this.host.generate,
      routerResultInput(this.host.generationCwd, source, command.message.text, result),
      fallback,
    );
  }

  stop() {
    this.stopped = true;
  }
  private file(key: string) {
    return path.join(this.root, `${key}.json`);
  }
  private save(key: string, record: Record) {
    return Effect.runPromise(
      writeFileStringAtomically({ filePath: this.file(key), contents: JSON.stringify(record) }),
    );
  }
  private async read(key: string): Promise<Record | undefined> {
    try {
      return Schema.decodeUnknownSync(Record)(JSON.parse(await readFile(this.file(key), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  async accept(command: TurnStart): Promise<{ sequence: number; routed: true }> {
    const key = createHash("sha256").update(command.commandId).digest("hex");
    // Same-key callers serialize before checking the persisted fingerprint.
    const previous = this.admissions.get(key);
    if (previous) {
      await previous;
      return this.accept(command);
    }
    const result = this.admit(key, command);
    this.admissions.set(key, result);
    try {
      return await result;
    } finally {
      this.admissions.delete(key);
    }
  }
  private async admit(
    key: string,
    command: TurnStart,
  ): Promise<{ sequence: number; routed: true }> {
    if (this.stopped) throw new Error("Router is shutting down.");
    const fingerprint = fingerprintOrchestrationCommand(command).value;
    let record = await this.read(key);
    if (record && record.fingerprint !== fingerprint)
      throw new Error("Router commandId is already bound to different content.");
    if (!record) {
      const thread = await this.host.readThread(command.threadId);
      if (!thread || thread.deletedAt || thread.archivedAt || thread.sidechatExpiredAt)
        throw new Error("Router conversation unavailable.");
      record = { fingerprint, command };
      await this.save(key, record);
    }
    if (record.sequence === undefined) {
      const result = await this.host.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`router-accepted-${key}`),
        threadId: command.threadId,
        createdAt: command.createdAt,
        messages: [
          {
            messageId: command.message.messageId,
            role: "user",
            text: command.message.text,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        ],
      });
      record = { ...record, sequence: result.sequence };
      await this.save(key, record);
    }
    this.start(key, record);
    return { sequence: record.sequence!, routed: true };
  }
  private start(key: string, record: Record) {
    if (this.stopped || !record.command || this.running.has(key)) return;
    this.running.add(key);
    void this.process(key, record)
      .catch(() => {
        // Keep the exact admitted request for the next recovery pass; do not silently drop it.
      })
      .finally(() => this.running.delete(key));
  }
  private async process(key: string, record: Record) {
    const command = record.command;
    if (!command || command.type !== "thread.turn.start")
      throw new Error("Invalid Router inbox command.");
    if (!record.error) {
      try {
        const guard = () => {
          if (this.stopped) throw new Error("Router is shutting down.");
        };
        await this.router.dispatch(command, {
          ...this.host,
          inputAccepted: true,
          readThread: (id) => {
            guard();
            return this.host.readThread(id);
          },
          generate: (input) => {
            guard();
            return this.host.generate(input);
          },
          dispatch: (planned) => {
            guard();
            return this.host.dispatch(planned);
          },
          ...(this.host.createWorker
            ? {
                createWorker: (worker: TurnStart, sourceContext?: string) => {
                  guard();
                  return this.host.createWorker!(worker, sourceContext);
                },
              }
            : {}),
        });
      } catch (error) {
        if (this.stopped) return;
        record = {
          ...record,
          errorCreatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 2000) : "Router task failed.",
        };
        await this.save(key, record);
      }
    }
    if (this.stopped) return;
    if (record.error)
      await this.host.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`router-failure-${key}`),
        threadId: command.threadId,
        createdAt: record.errorCreatedAt ?? command.createdAt,
        messages: [
          {
            messageId: MessageId.makeUnsafe(`router-failure-${key}`),
            role: "assistant",
            text: `处理遇到错误，任务可能已提交；请先查看此会话的任务和进度，再决定是否重试。${record.error}`,
            createdAt: record.errorCreatedAt ?? command.createdAt,
            updatedAt: record.errorCreatedAt ?? command.createdAt,
          },
        ],
      });
    await this.save(key, { fingerprint: record.fingerprint, sequence: record.sequence });
  }
  async recover() {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pending: Array<{ key: string; record: Record }> = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      const key = file.slice(0, -5);
      const record = await this.read(key);
      if (record?.command?.type === "thread.turn.start") pending.push({ key, record });
    }
    pending.sort(
      (left, right) =>
        (left.record.sequence ?? Number.MAX_SAFE_INTEGER) -
          (right.record.sequence ?? Number.MAX_SAFE_INTEGER) ||
        (left.record.command as TurnStart).createdAt.localeCompare(
          (right.record.command as TurnStart).createdAt,
        ),
    );
    for (const { key, record } of pending) {
      if (record.command?.type !== "thread.turn.start") continue;
      if (record.sequence === undefined) await this.accept(record.command);
      else this.start(key, record);
    }
  }
}
