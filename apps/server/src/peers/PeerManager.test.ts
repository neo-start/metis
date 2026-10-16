import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import path from "node:path";
import { PeerRemoteReply, type PeerTaskResponse } from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerManager, type PeerExecution } from "./PeerManager.ts";
import {
  discoverCertificate,
  peerRequest,
  readPeerJson,
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
    expect((await a.manager.overview()).tasks[0]?.stale).toBe(false);
    await a.manager.remote(b.id, { action: "cancel", taskId: "cancel-me" });
    expect((await a.manager.overview()).tasks[0]).toMatchObject({
      state: "interrupted",
      stale: false,
    });
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
  it("marks retained remote state stale offline and synchronizes after reconnect", async () => {
    const a = await create("A");
    const b = await create("B");
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "freshness", text: "Track progress" });
    await b.manager.tick();
    await a.manager.tick();
    const fresh = (await a.manager.overview()).tasks[0]!;
    expect(fresh.stale).toBe(false);
    expect(fresh.syncedAt).toBeTruthy();
    expect(fresh.updatedAt).toBeTruthy();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16000);
    try {
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(true);
    } finally {
      clock.mockRestore();
    }
    await b.manager.stop();
    await a.manager.tick();
    const offline = await a.manager.overview();
    expect(offline.tasks[0]?.stale).toBe(true);
    expect(offline.tasks[0]?.state).toBe(fresh.state);
    expect(offline.peers[0]?.lastSeenAt).toBeTruthy();
    const restarted = await create("B", b.directory);
    await restarted.manager.tick();
    await a.manager.tick();
    expect((await a.manager.overview()).tasks[0]).toMatchObject({
      state: "completed",
      stale: false,
      result: "测试完成",
    });
  });

  it("routes owner responses over paired TLS and rejects foreign tasks and agent callers", async () => {
    const a = await create("A");
    const adapter = execution();
    adapter.status = vi.fn(async () => ({ state: "waiting" as const, result: "Need approval" }));
    adapter.respond = vi.fn(async () => {});
    const b = await create("B", undefined, adapter);
    const c = await create("C");
    await pair(a, b);
    await pair(c, b);
    await a.manager.remote(b.id, { action: "task", id: "response-task", text: "Review" });
    await b.manager.tick();
    const response: PeerTaskResponse = {
      action: "respond",
      taskId: "response-task",
      requestId: "approval-1",
      lifecycleGeneration: "generation-1",
      responseAttemptId: null,
      createdAt: "2026-10-14T00:00:00.000Z",
      response: { kind: "approval", decision: "accept" },
    };
    await expect(a.manager.remote(b.id, response, "agent-thread")).rejects.toThrow("所有者");
    const identity = JSON.parse(
      await readFile(path.join(c.directory, "identity.json"), "utf8"),
    ) as PeerIdentity;
    const cert = await discoverCertificate(b.address, b.id, identity);
    await expect(peerRequest(b.address, cert, identity, "/rpc", response)).rejects.toThrow(
      "不属于",
    );
    expect(adapter.respond).not.toHaveBeenCalled();
    await a.manager.remote(b.id, response);
    expect(adapter.respond).toHaveBeenCalledWith(
      (await b.manager.overview()).tasks[0]?.threadId,
      response,
    );
    await a.manager.remote(b.id, {
      ...response,
      response: { kind: "userInput", answers: { choice: "yes" } },
    });
    expect(adapter.respond).toHaveBeenCalledTimes(2);
    await b.manager.control({ action: "revoke", peerId: a.id });
    await expect(a.manager.remote(b.id, response)).rejects.toThrow("撤销");
    expect(adapter.respond).toHaveBeenCalledTimes(2);
  });

  it("decodes legacy summaries and refuses responses without explicit remote capability", async () => {
    const legacy = Schema.decodeUnknownSync(PeerRemoteReply)({
      name: "old",
      project: null,
      tasks: [],
      messages: [],
    });
    expect(legacy.capabilities).toBeUndefined();
    const a = await create("A");
    const b = await create("Old execution");
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "legacy-task", text: "Work" });
    await expect(
      a.manager.remote(b.id, {
        action: "respond",
        taskId: "legacy-task",
        requestId: "q",
        lifecycleGeneration: null,
        responseAttemptId: null,
        createdAt: "2026-10-14T00:00:00.000Z",
        response: { kind: "approval", decision: "accept" },
      }),
    ).rejects.toThrow("不支持");
  });
  it("refreshes heartbeat freshness without rewriting unchanged durable snapshots", async () => {
    const a = await create("A");
    const b = await create("B");
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "heartbeat", text: "Work" });
    await b.manager.tick();
    await b.manager.tick();
    await a.manager.tick();
    const persisted = await readFile(path.join(a.directory, "state.json"), "utf8");
    await a.manager.tick();
    expect(await readFile(path.join(a.directory, "state.json"), "utf8")).toBe(persisted);
    expect((await a.manager.overview()).tasks[0]?.stale).toBe(false);
  });
  it("keeps live HTTP replies stale until the executor observes its running task again", async () => {
    const a = await create("A");
    const adapter = execution();
    adapter.status = vi.fn(async () => ({ state: "waiting" as const, result: "Approval pending" }));
    adapter.respond = vi.fn(async () => {});
    const b = await create("B", undefined, adapter);
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "stalled", text: "Work" });
    await b.manager.tick();
    await b.manager.tick();
    const fresh = await a.manager.remote(b.id, { action: "status" });
    expect(fresh.tasks[0]?.stale).toBe(false);
    const observedAt = fresh.tasks[0]?.observedAt;
    expect(observedAt).toBeTruthy();
    const response: PeerTaskResponse = {
      action: "respond",
      taskId: "stalled",
      requestId: "q",
      lifecycleGeneration: null,
      responseAttemptId: null,
      createdAt: "2026-10-14T00:00:00.000Z",
      response: { kind: "approval", decision: "accept" },
    };
    const identity = JSON.parse(
      await readFile(path.join(a.directory, "identity.json"), "utf8"),
    ) as PeerIdentity;
    const cert = await discoverCertificate(b.address, b.id, identity);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
    try {
      // No executor tick: it can answer HTTP, but only has an old observation.
      const cached = await a.manager.remote(b.id, { action: "status" });
      expect(cached.tasks[0]).toMatchObject({ stale: true, observedAt });
      expect(cached.tasks[0]?.observationAgeMs).toBeGreaterThanOrEqual(20000);
      const view = await a.manager.overview();
      expect(view.peers[0]?.online).toBe(true);
      expect(view.tasks[0]).toMatchObject({ stale: true, observedAt });
      expect(Date.parse(view.tasks[0]!.syncedAt!)).toBeGreaterThan(Date.parse(observedAt!));
      await expect(a.manager.remote(b.id, response)).rejects.toThrow("已过期");
      // Older clients cannot bypass the execution-side freshness guard either.
      await expect(peerRequest(b.address, cert, identity, "/rpc", response)).rejects.toThrow(
        "已过期",
      );
      expect(adapter.respond).not.toHaveBeenCalled();
      await b.manager.tick();
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(false);
      expect((await a.manager.overview()).tasks[0]?.observedAt).not.toBe(observedAt);
      await a.manager.remote(b.id, response);
      expect(adapter.respond).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it("treats legacy freshness as unknown and uses executor age, not cross-machine clock offsets", async () => {
    const a = await create("A");
    const b = await create("B");
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "legacy-observation", text: "Work" });
    await b.manager.tick();
    const local = (await b.manager.overview()).tasks[0]!;
    const identity = JSON.parse(
      await readFile(path.join(b.directory, "identity.json"), "utf8"),
    ) as PeerIdentity;
    await b.manager.stop();
    // A real authenticated older peer endpoint: status and response capabilities
    // predate observation metadata. Pairing and certificate pins remain real.
    let capabilities = ["task-status-v1", "task-responses-v1"];
    let fields: Partial<typeof local> = {};
    const actions: unknown[] = [];
    const server = https.createServer(
      {
        cert: identity.cert,
        key: identity.private,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      (req, res) => {
        const raw = (req.socket as TLSSocket).getPeerCertificate().raw;
        if (!raw || instanceId(raw) !== a.id) {
          res.writeHead(403);
          res.end();
          return;
        }
        void readPeerJson(req)
          .then((body) => {
            actions.push((body as { action: string }).action);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                name: "old",
                project: null,
                capabilities,
                messages: [],
                tasks: [
                  {
                    id: local.id,
                    peerId: a.id,
                    direction: "incoming",
                    text: local.text,
                    threadId: local.threadId,
                    sourceThreadId: null,
                    state: "waiting",
                    result: "cached",
                    createdAt: local.createdAt,
                    stale: false,
                    ...fields,
                  },
                ],
              }),
            );
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(b.address).port), "127.0.0.1", resolve),
    );
    try {
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]).toMatchObject({
        stale: true,
        observationAgeMs: null,
      });
      expect((await a.manager.overview()).peers[0]?.online).toBe(true);
      await expect(
        a.manager.remote(b.id, {
          action: "respond",
          taskId: local.id,
          requestId: "q",
          lifecycleGeneration: null,
          responseAttemptId: null,
          createdAt: local.createdAt,
          response: { kind: "approval", decision: "accept" },
        }),
      ).rejects.toThrow("观测时间未知");
      expect(actions).not.toContain("respond");
      capabilities = [...capabilities, "task-observation-v1"];
      fields = { observedAt: "2099-01-01T00:00:00.000Z", observationAgeMs: 20000 };
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(true);
      fields = { observedAt: "2000-01-01T00:00:00.000Z", observationAgeMs: 0 };
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(false);
      fields = { ...fields, stale: true };
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(true);
      fields = { ...fields, stale: false, observationAgeMs: null };
      await a.manager.remote(b.id, { action: "status" });
      expect((await a.manager.overview()).tasks[0]?.stale).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
  it("preserves an adapter's observation age when a delayed status read finally returns", async () => {
    const a = await create("A");
    const adapter = execution();
    adapter.status = vi.fn(async () => ({
      state: "waiting" as const,
      result: "cached projection",
      observedAt: "2020-01-01T00:00:00.000Z",
    }));
    const b = await create("B", undefined, adapter);
    await pair(a, b);
    await a.manager.remote(b.id, { action: "task", id: "slow-read", text: "Work" });
    await b.manager.tick();
    await b.manager.tick();
    await a.manager.remote(b.id, { action: "status" });
    expect((await a.manager.overview()).peers[0]?.online).toBe(true);
    expect((await a.manager.overview()).tasks[0]).toMatchObject({
      stale: true,
      observedAt: "2020-01-01T00:00:00.000Z",
    });
    adapter.status = vi.fn(async () => ({
      state: "waiting" as const,
      result: "cached projection",
      observedAt: new Date().toISOString(),
    }));
    await b.manager.tick();
    await a.manager.remote(b.id, { action: "status" });
    expect((await a.manager.overview()).tasks[0]?.stale).toBe(false);
  });
});
