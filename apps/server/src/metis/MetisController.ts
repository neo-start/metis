import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  MetisIdentity,
  MetisReflectionSource,
  type MetisControlInput,
  type ModelSelection,
  type RuntimeMode,
} from "@synara/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const State = Schema.Struct({
  identity: MetisIdentity,
  seen: Schema.Record(Schema.String, Schema.String),
  lineage: Schema.Array(Schema.String),
  batchThreadId: Schema.NullOr(Schema.String),
  nextReflectionAt: Schema.Number,
});
type State = typeof State.Type;

export interface MetisControllerHost {
  initializeSoul(): Promise<void>;
  resolveThread(current: string | null): Promise<string | null>;
  createThread(id: string, model: ModelSelection, mode: RuntimeMode): Promise<string>;
  sources(): Promise<ReadonlyArray<MetisReflectionSource>>;
  isIdle(threadId: string): Promise<boolean>;
  dispatchReflection(
    threadId: string,
    id: string,
    sources: ReadonlyArray<MetisReflectionSource>,
  ): Promise<void>;
  reflectionState(threadId: string, id: string): Promise<"missing" | "working" | "settled">;
  isReflectionTurn(threadId: string, turnId: string | null, batchId: string): Promise<boolean>;
}

/** The instance identity outlives its replaceable conversation and provider.
 * All state mutations are serialized, including the crash-recovery dispatch. */
export class MetisController {
  private state!: State;
  private serial: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  constructor(
    private readonly root: string,
    private readonly host: MetisControllerHost,
    private readonly now = () => Date.now(),
  ) {}

  get identity(): MetisIdentity {
    return this.state.identity;
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run);
    this.serial = result.catch(() => {});
    return result;
  }
  private async save() {
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.root, "identity.json"),
        contents: JSON.stringify(this.state),
      }),
    );
  }
  async initialize() {
    try {
      this.state = Schema.decodeUnknownSync(State)(
        JSON.parse(await readFile(path.join(this.root, "identity.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = {
        identity: {
          id: randomUUID(),
          createdAt: new Date(this.now()).toISOString(),
          threadId: null,
          growthEnabled: true,
          lastReflectionAt: null,
          reflection: null,
          error: null,
        },
        seen: {},
        lineage: [],
        batchThreadId: null,
        nextReflectionAt: 0,
      };
      await this.save();
    }
    await this.host.initializeSoul();
    await this.resolve();
  }
  private async resolve() {
    const current = this.state.identity.threadId;
    const threadId =
      !current && this.state.lineage.length ? null : await this.host.resolveThread(current);
    if (threadId !== current) {
      this.state = {
        ...this.state,
        identity: { ...this.state.identity, threadId },
        lineage: [
          ...new Set([
            ...this.state.lineage,
            ...(current ? [current] : []),
            ...(threadId ? [threadId] : []),
          ]),
        ],
      };
      await this.save();
    }
    return threadId;
  }
  async isController(threadId: string) {
    return this.exclusive(async () => (await this.resolve()) === threadId);
  }
  async overview(): Promise<MetisIdentity> {
    return this.exclusive(async () => {
      await this.resolve();
      return this.state.identity;
    });
  }
  async control(input: MetisControlInput): Promise<MetisIdentity> {
    if (input.action === "overview") return this.overview();
    if (input.action === "reflect") {
      await this.tick(true);
      return this.overview();
    }
    return this.exclusive(async () => {
      if (input.action === "growth") {
        this.state = {
          ...this.state,
          identity: { ...this.state.identity, growthEnabled: input.enabled },
        };
      } else if (!(await this.resolve())) {
        // A deterministic candidate survives a crash after thread.create commits.
        const id = `metis-${this.state.identity.id}-${this.state.lineage.length}`;
        const threadId = await this.host.createThread(id, input.modelSelection, input.runtimeMode);
        this.state = {
          ...this.state,
          identity: { ...this.state.identity, threadId, error: null },
          lineage: [...new Set([...this.state.lineage, threadId])],
        };
      }
      await this.save();
      return this.state.identity;
    });
  }
  async isReflectionTurn(threadId: string, turnId: string | null) {
    const batch = this.state.identity.reflection;
    return (
      !!batch &&
      this.state.batchThreadId === threadId &&
      this.host.isReflectionTurn(threadId, turnId, batch.id)
    );
  }
  async completeReflection(
    threadId: string,
    turnId: string | null,
    batchId: string,
    summary: string,
  ) {
    return this.exclusive(async () => {
      const batch = this.state.identity.reflection;
      if (
        !batch ||
        batch.id !== batchId ||
        this.state.batchThreadId !== threadId ||
        (await this.resolve()) !== threadId
      )
        throw new Error("This reflection does not belong to the active Metis controller.");
      if (!(await this.host.isReflectionTurn(threadId, turnId, batchId)))
        throw new Error("Only the reflection's own turn can complete it.");
      if (batch.state === "completed") return this.state.identity;
      if (batch.state !== "running") throw new Error("Reflection is not running.");
      const seen = { ...this.state.seen };
      for (const source of batch.sources) seen[source.threadId] = source.turnId;
      const identity: MetisIdentity = {
        ...this.state.identity,
        error: null,
        lastReflectionAt: new Date(this.now()).toISOString(),
        reflection: { ...batch, state: "completed", summary },
      };
      // Persist the audit record before advancing the cursor. A retry uses the same file.
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: path.join(this.root, "reflections", `${batch.id}.json`),
          contents: JSON.stringify(identity.reflection),
        }),
      );
      this.state = { ...this.state, identity, seen };
      await this.save();
      return identity;
    });
  }
  async tick(manual = false) {
    return this.exclusive(async () => {
      const threadId = await this.resolve();
      if (!threadId || (!manual && !this.state.identity.growthEnabled)) return;
      let batch = this.state.identity.reflection;
      if (batch?.state === "running") {
        const status = await this.host.reflectionState(this.state.batchThreadId!, batch.id);
        if (status === "working") return;
        if (status === "missing" && this.state.batchThreadId === threadId) {
          await this.host.dispatchReflection(threadId, batch.id, batch.sources);
          return;
        }
        this.state = {
          ...this.state,
          identity: {
            ...this.state.identity,
            reflection: { ...batch, state: "paused" },
            error: "上次经验整理未确认完成，可在总控继续处理。",
          },
        };
        await this.save();
        return;
      }
      if (batch?.state === "paused" && !manual) return;
      if (!manual && this.now() < this.state.nextReflectionAt) return;
      if (!(await this.host.isIdle(threadId))) return;
      const sources = (await this.host.sources())
        .filter(
          (source) =>
            !this.state.lineage.includes(source.threadId) &&
            source.threadId !== threadId &&
            this.state.seen[source.threadId] !== source.turnId,
        )
        .slice(0, 10);
      if (!sources.length) return;
      batch = { id: randomUUID(), sources, state: "running", summary: "" };
      this.state = {
        ...this.state,
        batchThreadId: threadId,
        nextReflectionAt: this.now() + 60 * 60 * 1000,
        identity: { ...this.state.identity, reflection: batch, error: null },
      };
      await this.save();
      await this.host.dispatchReflection(threadId, batch.id, sources);
    });
  }
  start() {
    this.stopped = false;
    this.timer ??= setInterval(() => {
      if (this.ticking || this.stopped) return;
      this.ticking = true;
      void this.tick()
        .catch((error: unknown) =>
          this.exclusive(async () => {
            this.state = {
              ...this.state,
              identity: {
                ...this.state.identity,
                error: error instanceof Error ? error.message : "Metis maintenance failed.",
                reflection:
                  this.state.identity.reflection?.state === "running"
                    ? { ...this.state.identity.reflection, state: "paused" }
                    : this.state.identity.reflection,
              },
            };
            await this.save();
          }),
        )
        .catch(() => {})
        .finally(() => {
          this.ticking = false;
        });
    }, 30_000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.serial;
  }
}
