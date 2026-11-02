import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  Thought,
  ThoughtCreateInput,
  ThoughtDeleteInput,
  ThoughtListInput,
  ThoughtReadInput,
  ThoughtUpdateInput,
  THOUGHT_BODY_MAX_BYTES,
  type ThoughtListResult,
} from "@synara/contracts";
import { Effect, Schema, Semaphore } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { containsCredentialLikeText } from "./memoryFiles.ts";
import { MetisMemoryError } from "./Services/MetisMemory.ts";

const STORE_MAX_BYTES = 32 * 1_024 * 1_024;
const STORE_MAX_ENTRIES = 10_000;
const Store = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(Schema.Struct({ ...Thought.fields, createDigest: Schema.String })),
  // Content-free tombstones prevent a delayed create retry resurrecting a deleted thought.
  deletedIds: Schema.Array(Schema.String),
});
type Store = typeof Store.Type;
export interface ThoughtAuthor {
  origin: "user" | "agent";
  sourceThreadId?: string;
  sourceTurnId?: string;
}

function failure(
  message: string,
  code: "invalid-input" | "not-found" | "limit-exceeded" = "invalid-input",
) {
  return new MetisMemoryError({ code, message });
}
const ioError = (cause: unknown) =>
  cause instanceof MetisMemoryError
    ? cause
    : new MetisMemoryError({ code: "io", message: "无法读写随想，请重试。", cause });

function publicEntry(entry: Store["entries"][number]): Thought {
  const { createDigest: _, ...thought } = entry;
  return thought;
}

/** Independent from the memory index: private instance data, never prompt-injected. */
export function makeThoughtsStore(rootDir: string, now: () => Date = () => new Date()) {
  const filePath = path.join(rootDir, "thoughts.json");
  const lock = Effect.runSync(Semaphore.make(1));
  const readStore = () =>
    Effect.tryPromise({
      try: async (): Promise<Store> => {
        let handle;
        try {
          const directory = await fs.lstat(rootDir);
          if (!directory.isDirectory() || directory.isSymbolicLink())
            throw failure("随想目录必须是实际目录。");
          const file = await fs.lstat(filePath);
          if (!file.isFile() || file.isSymbolicLink()) throw failure("随想文件必须是普通文件。");
          handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT")
            return { version: 1, entries: [], deletedIds: [] };
          throw cause;
        }
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > STORE_MAX_BYTES)
            throw failure("随想文件异常或超过大小限制。", "limit-exceeded");
          return Schema.decodeUnknownSync(Store)(JSON.parse(await handle.readFile("utf8")));
        } finally {
          await handle.close();
        }
      },
      catch: ioError,
    });
  const saveStore = (store: Store) =>
    Effect.gen(function* () {
      const contents = JSON.stringify(store);
      if (
        Buffer.byteLength(contents) > STORE_MAX_BYTES ||
        store.entries.length > STORE_MAX_ENTRIES ||
        store.deletedIds.length > 100_000
      ) {
        return yield* failure("随想存储已达到容量限制。", "limit-exceeded");
      }
      yield* writeFileStringAtomically({ filePath, contents }).pipe(Effect.mapError(ioError));
    });
  const validated = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        cause instanceof MetisMemoryError ? cause : failure("随想参数无效，请检查内容后重试。"),
    });
  const validateBody = (body: string, author: ThoughtAuthor) => {
    if (!body.trim()) throw failure("写下一点内容再保存吧。");
    if (Buffer.byteLength(body, "utf8") > THOUGHT_BODY_MAX_BYTES)
      throw failure("每条随想最多 16 KiB。", "limit-exceeded");
    if (author.origin === "agent" && containsCredentialLikeText(body))
      throw failure("请勿将密钥或凭据保存到随想。");
    return body;
  };
  const read = (input: ThoughtReadInput) =>
    Effect.gen(function* () {
      const { id } = yield* validated(() => Schema.decodeUnknownSync(ThoughtReadInput)(input));
      const store = yield* readStore();
      const entry = store.entries.find((entry) => entry.id === id);
      if (!entry) return yield* failure("这条随想不存在或已删除。", "not-found");
      return publicEntry(entry);
    });
  const list = (input: ThoughtListInput) =>
    Effect.gen(function* () {
      const request = yield* validated(() => Schema.decodeUnknownSync(ThoughtListInput)(input));
      if (request.from && request.to && Date.parse(request.from) > Date.parse(request.to))
        return yield* failure("开始时间不能晚于结束时间。");
      const store = yield* readStore();
      const query = request.query?.trim().toLocaleLowerCase() ?? "";
      const entries = store.entries
        .filter(
          (entry) =>
            (!query || entry.body.toLocaleLowerCase().includes(query)) &&
            (!request.from || Date.parse(entry.createdAt) >= Date.parse(request.from)) &&
            (!request.to || Date.parse(entry.createdAt) <= Date.parse(request.to)),
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const offset = request.offset ?? 0;
      const end = offset + (request.limit ?? 20);
      return {
        entries: entries.slice(offset, end).map(publicEntry),
        total: entries.length,
        nextOffset: end < entries.length ? end : null,
      } satisfies ThoughtListResult;
    });
  const create = (input: ThoughtCreateInput, author: ThoughtAuthor) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const request = yield* validated(() => Schema.decodeUnknownSync(ThoughtCreateInput)(input));
        const body = yield* validated(() => validateBody(request.body, author));
        const sourceThreadId = author.sourceThreadId ?? null;
        const sourceTurnId = author.sourceTurnId ?? null;
        const createDigest = createHash("sha256")
          .update(JSON.stringify([body, author.origin, sourceThreadId, sourceTurnId]))
          .digest("hex");
        const store = yield* readStore();
        if (store.deletedIds.includes(request.id))
          return yield* failure("这条随想已删除，不能重试创建。");
        const existing = store.entries.find((entry) => entry.id === request.id);
        if (existing) {
          if (existing.createDigest !== createDigest)
            return yield* failure("此记录编号已被使用，请刷新后重试。");
          return publicEntry(existing);
        }
        const timestamp = now().toISOString();
        const entry = {
          id: request.id,
          body,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
          origin: author.origin,
          sourceThreadId,
          sourceTurnId,
          createDigest,
        };
        yield* saveStore({ ...store, entries: [...store.entries, entry] });
        return publicEntry(entry);
      }),
    );
  const update = (input: ThoughtUpdateInput, author: ThoughtAuthor) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const request = yield* validated(() => Schema.decodeUnknownSync(ThoughtUpdateInput)(input));
        const body = yield* validated(() => validateBody(request.body, author));
        const store = yield* readStore();
        const entry = store.entries.find((entry) => entry.id === request.id);
        if (!entry) return yield* failure("这条随想不存在或已删除。", "not-found");
        if (entry.revision !== request.expectedRevision)
          return yield* failure("这条随想已被修改，请重新读取后再保存。你的草稿仍然保留。");
        const updated = {
          ...entry,
          body,
          updatedAt: now().toISOString(),
          revision: entry.revision + 1,
        };
        yield* saveStore({
          ...store,
          entries: store.entries.map((entry) => (entry.id === updated.id ? updated : entry)),
        });
        return publicEntry(updated);
      }),
    );
  const remove = (input: ThoughtDeleteInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const request = yield* validated(() => Schema.decodeUnknownSync(ThoughtDeleteInput)(input));
        const store = yield* readStore();
        const entry = store.entries.find((entry) => entry.id === request.id);
        if (!entry) return { deleted: false };
        if (entry.revision !== request.expectedRevision)
          return yield* failure("这条随想已被修改，请重新读取后再删除。");
        yield* saveStore({
          ...store,
          entries: store.entries.filter((entry) => entry.id !== request.id),
          deletedIds: [...store.deletedIds, request.id],
        });
        return { deleted: true };
      }),
    );
  return { list, read, create, update, remove };
}
export type ThoughtsStore = ReturnType<typeof makeThoughtsStore>;
