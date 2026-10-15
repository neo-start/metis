import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetisController, type MetisControllerHost } from "./MetisController.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-controller-"));
  roots.push(root);
  let now = 100000;
  let current: string | null = null;
  let status: "missing" | "working" | "settled" = "missing";
  const accepted = new Set<string>();
  const host: MetisControllerHost = {
    initializeSoul: vi.fn(async () => {}),
    resolveThread: vi.fn(async () => current),
    createThread: vi.fn(async (id) => {
      current = id;
      return id;
    }),
    sources: vi.fn(async () => [{ threadId: "work", turnId: "turn-1", title: "Work" }]),
    isIdle: vi.fn(async () => true),
    dispatchReflection: vi.fn(async (_id, batch) => {
      accepted.add(batch);
      status = "working";
    }),
    reflectionState: vi.fn(async () => status),
    isReflectionTurn: vi.fn(async (_id, turnId) => turnId === "reflection-turn"),
  };
  const create = async () => {
    const instance = new MetisController(root, host, () => now);
    await instance.initialize();
    return instance;
  };
  const controller = await create();
  const open = {
    action: "open",
    modelSelection: { provider: "codex", model: "test-model" },
    runtimeMode: "approval-required",
  } as const;
  return {
    root,
    controller,
    host,
    open,
    create,
    accepted,
    advance: () => {
      now += 3600001;
    },
    setThread: (id: string | null) => {
      current = id;
    },
    settle: () => {
      status = "settled";
    },
  };
}

describe("persistent Metis identity and reflection lifecycle", () => {
  it("creates one conversation for concurrent windows, persists identity and follows handoff", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.controller.control(f.open), f.controller.control(f.open)]);
    expect(a.threadId).toBe(b.threadId);
    expect(f.host.createThread).toHaveBeenCalledTimes(1);
    const restarted = await f.create();
    expect((await restarted.overview()).id).toBe(a.id);
    f.setThread("handoff-successor");
    expect((await restarted.overview()).threadId).toBe("handoff-successor");
    expect((await restarted.overview()).id).toBe(a.id);
  });
  it("does not create an identity replacement or invoke a model when a conversation is unavailable", async () => {
    const f = await setup();
    const original = await f.controller.control(f.open);
    f.setThread(null);
    expect((await f.controller.overview()).threadId).toBeNull();
    await f.controller.tick();
    expect(f.host.dispatchReflection).not.toHaveBeenCalled();
    const reopened = await f.controller.control(f.open);
    expect(reopened.id).toBe(original.id);
    expect(reopened.threadId).not.toBe(original.threadId);
  });
  it("adopts a legacy console without changing its model or permissions", async () => {
    const f = await setup();
    f.setThread("legacy-console");
    expect((await f.controller.control(f.open)).threadId).toBe("legacy-console");
    expect(f.host.createThread).not.toHaveBeenCalled();
  });
  it("persists a batch before dispatch and recovers the same ID after a failure", async () => {
    const f = await setup();
    await f.controller.control(f.open);
    vi.mocked(f.host.dispatchReflection).mockRejectedValueOnce(new Error("offline"));
    await expect(f.controller.tick()).rejects.toThrow("offline");
    const batch = (await f.controller.overview()).reflection!;
    const disk = JSON.parse(await readFile(path.join(f.root, "identity.json"), "utf8"));
    expect(disk.identity.reflection.id).toBe(batch.id);
    const restarted = await f.create();
    await restarted.tick();
    expect(f.host.dispatchReflection).toHaveBeenLastCalledWith(
      restarted.identity.threadId,
      batch.id,
      batch.sources,
    );
    await restarted.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(2);
    expect(f.accepted.size).toBe(1);
  });
  it("requires the reflection's own turn to acknowledge sources and writes an audit", async () => {
    const f = await setup();
    const identity = await f.controller.control(f.open);
    await f.controller.tick();
    const batch = f.controller.identity.reflection!;
    await expect(
      f.controller.completeReflection("other", "reflection-turn", batch.id, "ok"),
    ).rejects.toThrow();
    await expect(
      f.controller.completeReflection(identity.threadId!, "other-turn", batch.id, "ok"),
    ).rejects.toThrow();
    await f.controller.completeReflection(
      identity.threadId!,
      "reflection-turn",
      batch.id,
      "已更新用户偏好，并保留来源。",
    );
    const audit = JSON.parse(
      await readFile(path.join(f.root, "reflections", `${batch.id}.json`), "utf8"),
    );
    expect(audit.state).toBe("completed");
    expect(audit.sources).toEqual(batch.sources);
    f.advance();
    await f.controller.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(1);
    const restarted = await f.create();
    await restarted.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(1);
  });
  it("pauses an unacknowledged settled batch instead of repeatedly calling a model", async () => {
    const f = await setup();
    await f.controller.control(f.open);
    await f.controller.tick();
    f.settle();
    await f.controller.tick();
    expect(f.controller.identity.reflection?.state).toBe("paused");
    f.advance();
    await f.controller.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(1);
    await f.controller.tick(true);
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(2);
  });
  it("does not reflect while disabled, busy, without new work, or on its own lineage", async () => {
    const f = await setup();
    const identity = await f.controller.control(f.open);
    await f.controller.control({ action: "growth", enabled: false });
    await f.controller.tick();
    expect(f.host.dispatchReflection).not.toHaveBeenCalled();
    await f.controller.control({ action: "growth", enabled: true });
    vi.mocked(f.host.isIdle).mockResolvedValueOnce(false);
    await f.controller.tick();
    expect(f.host.dispatchReflection).not.toHaveBeenCalled();
    vi.mocked(f.host.sources).mockResolvedValue([
      { threadId: identity.threadId!, turnId: "own", title: "Metis" },
    ]);
    await f.controller.tick();
    expect(f.host.dispatchReflection).not.toHaveBeenCalled();
  });
  it("batches at most ten changed conversations and waits an hour between automatic batches", async () => {
    const f = await setup();
    const identity = await f.controller.control(f.open);
    vi.mocked(f.host.sources).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        threadId: `work-${i}`,
        turnId: "turn",
        title: "Work",
      })),
    );
    await f.controller.tick();
    const batch = f.controller.identity.reflection!;
    expect(batch.sources).toHaveLength(10);
    await f.controller.completeReflection(
      identity.threadId!,
      "reflection-turn",
      batch.id,
      "没有新的长期事实。",
    );
    await f.controller.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(1);
    f.advance();
    await f.controller.tick();
    expect(f.host.dispatchReflection).toHaveBeenCalledTimes(2);
    expect(f.controller.identity.reflection?.sources[0]?.threadId).toBe("work-10");
  });
});
