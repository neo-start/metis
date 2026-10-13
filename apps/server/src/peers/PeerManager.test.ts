import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerManager, type PeerExecution } from "./PeerManager.ts";
import {
  discoverCertificate,
  peerRequest,
  instanceId,
  parsePeerAddress,
  type PeerIdentity,
} from "./peerTransport.ts";

const roots: string[] = [];
const managers: PeerManager[] = [];
function execution(): PeerExecution {
  return {
    templates: async () => [{ id: "template", title: "Local project / Existing model" }],
    project: async (id) => (id ? "Local project" : null),
    submit: vi.fn(async (task) => task.threadId!),
    status: vi.fn(async () => ({ state: "completed" as const, result: "测试完成" })),
    cancel: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    deliver: vi.fn(async () => {}),
  };
}
async function create(name: string, root?: string, adapter = execution(), lan = false) {
  const directory = root ?? (await mkdtemp(path.join(os.tmpdir(), "metis-peer-")));
  if (!root) roots.push(directory);
  const manager = new PeerManager(directory, adapter, {
    discovery: lan,
    host: lan ? "0.0.0.0" : "127.0.0.1",
    autoTick: false,
  });
  managers.push(manager);
  await manager.initialize();
  await manager.control({ action: "configure", enabled: true, name, templateThreadId: "template" });
  const view = await manager.overview();
  return {
    manager,
    directory,
    id: view.instanceId,
    address: `https://127.0.0.1:${view.listeningPort}`,
    adapter,
  };
}
async function pair(a: Awaited<ReturnType<typeof create>>, b: Awaited<ReturnType<typeof create>>) {
  await a.manager.control({ action: "pair", peerId: b.id, address: b.address });
  const pendingA = (await a.manager.overview()).pending[0]!;
  const pendingB = (await b.manager.overview()).pending[0]!;
  expect(pendingA.code).toBe(pendingB.code);
  await b.manager.control({ action: "approve", requestId: pendingB.id });
  await a.manager.tick();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Metis LAN peer protocol (real mutual TLS, isolated stores)", () => {
  it.runIf(process.env.METIS_PEER_DISCOVERY_SMOKE === "1")(
    "discovers and pairs by ID alone through real mDNS",
    async () => {
      const a = await create("Discovery A", undefined, execution(), true);
      const b = await create("Discovery B", undefined, execution(), true);
      const deadline = Date.now() + 15000;
      while (
        Date.now() < deadline &&
        !(await a.manager.overview()).nearby.some((peer) => peer.id === b.id)
      )
        await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await a.manager.overview()).nearby.some((peer) => peer.id === b.id)).toBe(true);
      await a.manager.control({ action: "pair", peerId: b.id });
      const pending = (await b.manager.overview()).pending[0]!;
      await b.manager.control({ action: "approve", requestId: pending.id });
      await a.manager.tick();
      await a.manager.remote(b.id, { action: "message", id: "discovery-message", text: "ID only" });
      expect(
        (await b.manager.overview()).messages.some((message) => message.text === "ID only"),
      ).toBe(true);
    },
  );
  it("pins instance identity, requires confirmation, pairs both directions and revokes immediately", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    const identity = JSON.parse(
      await readFile(path.join(a.directory, "identity.json"), "utf8"),
    ) as PeerIdentity;
    expect(instanceId(identity.cert)).toBe(a.id);
    await expect(discoverCertificate(b.address, c.id, identity)).rejects.toThrow("不匹配");
    const cert = await discoverCertificate(b.address, b.id, identity);
    await expect(
      peerRequest(b.address, cert, identity, "/rpc", { action: "status" }),
    ).rejects.toThrow("未配对");
    await pair(a, b);
    expect((await a.manager.overview()).peers[0]?.id).toBe(b.id);
    expect((await b.manager.overview()).peers[0]?.id).toBe(a.id);
    await a.manager.remote(b.id, { action: "message", id: "hello", text: "你好 B" });
    await b.manager.remote(a.id, { action: "message", id: "reply", text: "你好 A" });
    expect(
      (await b.manager.overview()).messages.some(
        (m) => m.direction === "incoming" && m.text === "你好 B",
      ),
    ).toBe(true);
    expect(
      (await a.manager.overview()).messages.some(
        (m) => m.direction === "incoming" && m.text === "你好 A",
      ),
    ).toBe(true);
    await b.manager.control({ action: "revoke", peerId: a.id });
    await expect(a.manager.remote(b.id, { action: "status" })).rejects.toThrow("授权已撤销");
    if (process.platform !== "win32")
      expect((await stat(path.join(a.directory, "identity.json"))).mode & 0o777).toBe(0o600);
  });

  it("deduplicates durable task requests, queues execution, reports results and prevents delegation loops", async () => {
    const a = await create("A");
    const b = await create("B");
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "job-1", text: "跑测试" }, "source-thread");
    await a.manager.remote(b.id, { action: "task", id: "job-1", text: "跑测试" }, "source-thread");
    await a.manager.remote(b.id, { action: "task", id: "job-2", text: "检查结果" });
    expect((await b.manager.overview()).tasks).toHaveLength(2);
    await b.manager.tick();
    expect(b.adapter.submit).toHaveBeenCalledTimes(1);
    const inbound = (await b.manager.overview()).tasks[0]!;
    await expect(
      b.manager.remote(a.id, { action: "task", id: "loop", text: "转派回去" }, inbound.threadId),
    ).rejects.toThrow("不能再次转派");
    await b.manager.tick();
    expect(b.adapter.submit).toHaveBeenCalledTimes(2);
    await a.manager.tick();
    expect((await a.manager.overview()).tasks[0]).toMatchObject({
      state: "completed",
      result: "测试完成",
    });
    expect(a.adapter.notify).toHaveBeenCalledTimes(1);
    await a.manager.tick();
    expect(a.adapter.notify).toHaveBeenCalledTimes(1);
    await expect(
      a.manager.remote(b.id, { action: "task", id: "job-1", text: "改成另一件事" }),
    ).rejects.toThrow("请求 ID");
  });

  it("keeps identity, trust, port and unsent requests across restarts without duplicate work", async () => {
    const a = await create("A");
    const b = await create("B");
    await pair(a, b);
    await b.manager.stop();
    await expect(
      a.manager.remote(b.id, { action: "message", id: "offline", text: "上线后收到" }),
    ).rejects.toThrow();
    expect((await a.manager.overview()).messages[0]?.delivered).toBe(false);
    await a.manager.stop();
    const restartedA = await create("A", a.directory);
    const restartedB = await create("B", b.directory);
    expect(restartedA.id).toBe(a.id);
    expect(restartedB.address).toBe(b.address);
    await restartedA.manager.tick();
    await restartedA.manager.tick();
    expect(
      (await restartedB.manager.overview()).messages.filter((m) => m.id === "offline"),
    ).toHaveLength(1);
    expect((await restartedA.manager.overview()).messages[0]?.delivered).toBe(true);
  });

  it("cancels queued work before provider execution and restricts remote task access to its owner", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    await pair(a, b);
    await pair(c, b);
    await a.manager.remote(b.id, { action: "task", id: "cancel-me", text: "稍后执行" });
    await expect(c.manager.remote(b.id, { action: "cancel", taskId: "cancel-me" })).rejects.toThrow(
      "不属于",
    );
    expect((await c.manager.remote(b.id, { action: "status" })).tasks).toHaveLength(0);
    await a.manager.remote(b.id, { action: "cancel", taskId: "cancel-me" });
    await b.manager.tick();
    expect(b.adapter.submit).not.toHaveBeenCalled();
    expect((await b.manager.overview()).tasks[0]?.state).toBe("interrupted");
  });

  it("rejects public endpoints, credentials and malformed IDs before connecting", async () => {
    expect(() => parsePeerAddress("https://8.8.8.8:443")).toThrow();
    expect(() => parsePeerAddress("https://user:secret@192.168.1.2:1234")).toThrow();
    expect(() => parsePeerAddress("http://192.168.1.2:1234")).toThrow();
    expect(parsePeerAddress("192.168.1.2:1234").origin).toBe("https://192.168.1.2:1234");
  });

  it("routes task messages to the owning conversation exactly once and rejects foreign task IDs", async () => {
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    await pair(a, b);
    await pair(c, a);
    await a.manager.remote(
      b.id,
      { action: "task", id: "question-task", text: "分析项目" },
      "origin-thread",
    );
    await b.manager.tick();
    const message = {
      action: "message" as const,
      id: "question",
      taskId: "question-task",
      text: "需要补充信息",
    };
    await b.manager.remote(a.id, message);
    await b.manager.remote(a.id, message);
    await a.manager.tick();
    await a.manager.tick();
    expect(a.adapter.deliver).toHaveBeenCalledTimes(1);
    expect(a.adapter.deliver).toHaveBeenCalledWith(
      "origin-thread",
      expect.objectContaining({ text: "需要补充信息" }),
    );
    await expect(c.manager.remote(a.id, { ...message, id: "foreign" })).rejects.toThrow("不属于");
  });
});
