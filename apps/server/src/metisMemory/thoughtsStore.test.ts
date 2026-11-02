import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeThoughtsStore } from "./thoughtsStore.ts";
import { makeMetisMemoryShape } from "./Layers/MetisMemory.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const run = Effect.runPromise;
const user = { origin: "user" as const };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metis-thoughts-"));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  let clock = new Date("2026-11-02T02:00:00.000Z");
  const directory = path.join(root, "memory", "thoughts");
  return {
    root,
    directory,
    store: makeThoughtsStore(directory, () => clock),
    tick: () => {
      clock = new Date(clock.getTime() + 60_000);
    },
  };
}

describe("personal thoughts storage", () => {
  it("preserves exact words, time and provenance across restart without becoming memory", async () => {
    const f = fixture();
    const body = "  今天有点累。\n也有一点期待。\n";
    const saved = await run(
      f.store.create(
        { id: "first", body },
        { origin: "agent", sourceThreadId: "thread-1", sourceTurnId: "turn-1" },
      ),
    );
    expect(saved).toMatchObject({
      body,
      origin: "agent",
      revision: 1,
      sourceThreadId: "thread-1",
      sourceTurnId: "turn-1",
      createdAt: "2026-11-02T02:00:00.000Z",
    });
    expect(await run(makeThoughtsStore(f.directory).read({ id: "first" }))).toEqual(saved);
    const memory = makeMetisMemoryShape({
      rootDir: path.join(f.root, "memory"),
      readModel: () => null,
    });
    expect(await run(memory.list({ scope: "all" }))).toEqual([]);
    expect(
      memory.renderContext({ projectId: null, projectTitle: null, toolsAvailable: true }),
    ).toBeNull();
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(f.directory, "thoughts.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    }
  });

  it("deduplicates concurrent retries, rejects ID reuse and keeps separate moments with identical text", async () => {
    const { store } = fixture();
    await Promise.all(
      Array.from({ length: 8 }, () => run(store.create({ id: "one", body: "想休息" }, user))),
    );
    expect((await run(store.list({}))).total).toBe(1);
    await expect(run(store.create({ id: "one", body: "换了内容" }, user))).rejects.toThrow(
      "编号已被使用",
    );
    await run(store.create({ id: "two", body: "想休息" }, user));
    expect((await run(store.list({}))).total).toBe(2);
  });

  it("searches Chinese and inclusive creation dates, with stable pagination", async () => {
    const f = fixture();
    await run(f.store.create({ id: "one", body: "工作的节奏" }, user));
    f.tick();
    await run(f.store.create({ id: "two", body: "散步后，工作也轻松了" }, user));
    f.tick();
    await run(f.store.create({ id: "three", body: "Tea TIME" }, user));
    const first = await run(f.store.list({ query: "工作", limit: 1 }));
    expect(first.entries.map((entry) => entry.id)).toEqual(["two"]);
    expect(first.nextOffset).toBe(1);
    expect(
      (await run(f.store.list({ query: "工作", offset: 1, limit: 1 }))).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual(["one"]);
    expect((await run(f.store.list({ query: "time" }))).total).toBe(1);
    expect(
      (
        await run(
          f.store.list({ from: "2026-11-02T02:01:00.000Z", to: "2026-11-02T02:01:00.000Z" }),
        )
      ).entries.map((entry) => entry.id),
    ).toEqual(["two"]);
    await expect(
      run(f.store.list({ from: "2026-12-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" })),
    ).rejects.toThrow("开始时间");
    await expect(run(f.store.list({ limit: 500 }))).rejects.toThrow("参数无效");
  });

  it("serializes competing edits and rejects stale deletes without changing creation provenance", async () => {
    const f = fixture();
    const saved = await run(f.store.create({ id: "one", body: "最初" }, user));
    f.tick();
    const results = await Promise.allSettled(
      ["后来", "现在"].map((body) =>
        run(
          f.store.update(
            { id: "one", expectedRevision: 1, body },
            { origin: "agent", sourceThreadId: "other" },
          ),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const edited = await run(f.store.read({ id: "one" }));
    expect(edited).toMatchObject({
      revision: 2,
      createdAt: saved.createdAt,
      origin: "user",
      sourceThreadId: null,
    });
    expect(edited.updatedAt).not.toBe(saved.updatedAt);
    await expect(run(f.store.remove({ id: "one", expectedRevision: 1 }))).rejects.toThrow(
      "已被修改",
    );
    expect((await run(f.store.read({ id: "one" }))).revision).toBe(2);
  });

  it("deletes content durably and prevents late creation retries from resurrecting it", async () => {
    const f = fixture();
    await run(f.store.create({ id: "one", body: "不想保留的原文" }, user));
    expect(await run(f.store.remove({ id: "one", expectedRevision: 1 }))).toEqual({
      deleted: true,
    });
    expect(await run(f.store.remove({ id: "one", expectedRevision: 1 }))).toEqual({
      deleted: false,
    });
    const reopened = makeThoughtsStore(f.directory);
    await expect(run(reopened.create({ id: "one", body: "不想保留的原文" }, user))).rejects.toThrow(
      "已删除",
    );
    await expect(run(reopened.read({ id: "one" }))).rejects.toThrow("不存在或已删除");
    expect(fs.readFileSync(path.join(f.directory, "thoughts.json"), "utf8")).not.toContain(
      "不想保留的原文",
    );
  });

  it("validates UTF-8 bytes, blank content, IDs and agent credentials", async () => {
    const { store } = fixture();
    await expect(run(store.create({ id: "one", body: "感".repeat(6000) }, user))).rejects.toThrow(
      "16 KiB",
    );
    await expect(run(store.create({ id: "one", body: "  \n" }, user))).rejects.toThrow("内容");
    await expect(run(store.create({ id: "../outside", body: "hello" }, user))).rejects.toThrow(
      "参数无效",
    );
    await expect(
      run(store.create({ id: "one", body: `sk-${"a".repeat(32)}` }, { origin: "agent" })),
    ).rejects.toThrow("凭据");
    expect((await run(store.list({}))).total).toBe(0);
  });

  it("fails closed on corrupt storage instead of replacing existing data", async () => {
    const f = fixture();
    await run(f.store.create({ id: "one", body: "原文" }, user));
    const target = path.join(f.directory, "thoughts.json");
    fs.writeFileSync(target, "broken-json");
    await expect(run(f.store.create({ id: "two", body: "新内容" }, user))).rejects.toThrow(
      "无法读写",
    );
    expect(fs.readFileSync(target, "utf8")).toBe("broken-json");
  });

  it.skipIf(process.platform === "win32")("rejects symlink files", async () => {
    const f = fixture();
    fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(outside, '{"version":1,"entries":[],"deletedIds":[]}');
    fs.symlinkSync(outside, path.join(f.directory, "thoughts.json"));
    await expect(run(f.store.list({}))).rejects.toThrow("普通文件");
    await expect(run(f.store.create({ id: "one", body: "你好" }, user))).rejects.toThrow(
      "普通文件",
    );
    expect(JSON.parse(fs.readFileSync(outside, "utf8")).entries).toEqual([]);
  });
});
