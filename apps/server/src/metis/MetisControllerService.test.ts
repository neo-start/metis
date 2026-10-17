import path from "node:path";
import fs from "node:fs/promises";
import { PEER_ATTACHMENT_CHUNK_BYTES } from "@synara/contracts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { Option } from "effect";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { QueuedTurnPromotionRepositoryLive } from "../persistence/Layers/QueuedTurnPromotions.ts";
import { CommandId, MessageId, ThreadId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makePeerChatExecution } from "../peers/PeerChatExecution.ts";
import { PeerManager, type PeerExecution } from "../peers/PeerManager.ts";
import { MetisControllerService, makeMetisControllerHost } from "./MetisControllerService.ts";
import { MetisMemoryLive } from "../metisMemory/Layers/MetisMemory.ts";
import { MetisMemory } from "../metisMemory/Services/MetisMemory.ts";
import { createHash } from "node:crypto";
import { MetisController } from "./MetisController.ts";

function createTestRuntime() {
  const runtimeLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return {
            ...config,
            homeDir: config.baseDir,
            chatWorkspaceRoot: path.join(config.baseDir, "chats"),
          };
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "metis-controller-execution-test-" }),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return ManagedRuntime.make(MetisMemoryLive.pipe(Layer.provideMerge(runtimeLayer)));
}

describe("Metis controller with the real orchestration engine", () => {
  it("keeps multiple remote conversations on one identity, with independent history, durable ownership and idempotent commands", async () => {
    const runtime = createTestRuntime();
    try {
      const config = await runtime.runPromise(Effect.service(ServerConfig));
      const host = await runtime.runPromise(makeMetisControllerHost);
      const controller = new MetisController(path.join(config.stateDir, "remote-controller"), host);
      await controller.initialize();
      const main = await controller.control({
        action: "open",
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
      });
      const execution = await runtime.runPromise(
        makePeerChatExecution.pipe(Effect.provideService(MetisControllerService, controller)),
      );
      const peer = `metis-${"a".repeat(32)}`;
      const other = `metis-${"b".repeat(32)}`;
      const first = await execution.handle(peer, { action: "chat.open", id: "one", title: "设计" });
      const second = await execution.handle(peer, {
        action: "chat.open",
        id: "two",
        title: "开发",
      });
      await execution.handle(peer, { action: "chat.open", id: "one", title: "设计" });
      expect(first.controllerId).toBe(main.id);
      expect(second.controllerId).toBe(main.id);
      expect(second.chats).toHaveLength(2);
      const send = {
        action: "chat.send",
        chatId: "one",
        id: "hello",
        text: "只属于设计对话",
      } as const;
      await execution.handle(peer, send);
      await execution.handle(peer, send);
      const one = await execution.handle(peer, { action: "chat.read", chatId: "one" });
      const two = await execution.handle(peer, { action: "chat.read", chatId: "two" });
      expect(one.thread?.messages).toHaveLength(1);
      expect(one.thread?.messages[0]?.text).toBe(send.text);
      expect(two.thread?.messages).toHaveLength(0);
      expect(one.thread?.id).not.toBe(two.thread?.id);
      expect(one.thread?.runtimeMode).toBe("approval-required");
      expect(one.thread?.modelSelection).toEqual({ provider: "codex", model: "test-model" });
      expect(await controller.isController(one.thread!.id)).toBe(true);
      expect(await controller.isController(two.thread!.id)).toBe(true);
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (t) => t.id === main.threadId,
        )?.messages,
      ).toHaveLength(0);
      expect(
        (
          await execution.handle(peer, {
            action: "chat.read",
            chatId: "one",
            revision: one.revision!,
          })
        ).thread,
      ).toBeUndefined();
      await expect(execution.handle(other, { action: "chat.read", chatId: "one" })).rejects.toThrow(
        "不属于",
      );
      await expect(
        execution.handle(peer, {
          action: "chat.stop",
          chatId: "one",
          id: "wrong-stop",
          turnId: "old-turn",
        }),
      ).rejects.toThrow("已经结束");
      await expect(
        execution.handle(peer, {
          action: "chat.approval",
          chatId: "one",
          id: "wrong-approval",
          requestId: "foreign",
          decision: "accept",
        }),
      ).rejects.toThrow("失效");
      await execution.handle(peer, {
        action: "chat.rename",
        chatId: "two",
        id: "rename",
        title: "实现计划",
      });
      expect((await execution.handle(peer, { action: "chat.list" })).chats[1]?.title).toBe(
        "实现计划",
      );
      const recovered = new MetisController(path.join(config.stateDir, "remote-controller"), host);
      await recovered.initialize();
      expect(await recovered.isController(one.thread!.id)).toBe(true);
      expect(await recovered.peerChats(peer)).toHaveLength(2);
      const recoveredExecution = await runtime.runPromise(
        makePeerChatExecution.pipe(Effect.provideService(MetisControllerService, recovered)),
      );
      const archive = { action: "chat.archive", chatId: "two", id: "archive" } as const;
      await recoveredExecution.handle(peer, archive);
      await recoveredExecution.handle(peer, archive);
      expect(await recovered.isController(two.thread!.id)).toBe(false);
      await recovered.revokePeer(peer);
      expect(await recovered.isController(one.thread!.id)).toBe(false);
      await expect(
        recoveredExecution.handle(peer, { action: "chat.read", chatId: "one" }),
      ).rejects.toThrow("不属于");
      await expect(
        recoveredExecution.handle(peer, { action: "chat.open", id: "one", title: "设计" }),
      ).rejects.toThrow("撤销");
      expect(await recovered.isController(main.threadId!)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
  it("routes controller chats over paired mutual TLS without task templates and revokes access", async () => {
    const runtime = createTestRuntime();
    const managers: PeerManager[] = [];
    try {
      const config = await runtime.runPromise(Effect.service(ServerConfig));
      const host = await runtime.runPromise(makeMetisControllerHost);
      const controller = new MetisController(path.join(config.stateDir, "tls-controller"), host);
      await controller.initialize();
      await controller.control({
        action: "open",
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
      });
      const chats = await runtime.runPromise(
        makePeerChatExecution.pipe(Effect.provideService(MetisControllerService, controller)),
      );
      const taskAdapter: PeerExecution = {
        templates: async () => [],
        project: async () => null,
        submit: async () => {
          throw new Error("must not delegate tasks");
        },
        status: async () => ({ state: "completed", result: "" }),
        cancel: async () => {},
        notify: async () => {},
        deliver: async () => {},
      };
      const a = new PeerManager(path.join(config.stateDir, "a"), taskAdapter, {
        host: "127.0.0.1",
        discovery: false,
        autoTick: false,
      });
      const b = new PeerManager(path.join(config.stateDir, "b"), taskAdapter, {
        host: "127.0.0.1",
        discovery: false,
        autoTick: false,
        chats,
      });
      managers.push(a, b);
      for (const [index, manager] of managers.entries()) {
        await manager.initialize();
        await manager.control({
          action: "configure",
          enabled: true,
          name: `Device ${index}`,
          templateThreadId: null,
        });
      }
      const av = await a.overview();
      const bv = await b.overview();
      await a.control({
        action: "pair",
        peerId: bv.instanceId,
        address: `https://127.0.0.1:${bv.listeningPort}`,
      });
      await b.control({ action: "approve", requestId: (await b.overview()).pending[0]!.id });
      await a.tick();
      await b.tick();
      await expect(b.remote(av.instanceId, { action: "chat.list" })).rejects.toThrow("更新 Metis");
      const open = { action: "chat.open", id: "chat", title: "主控通信" } as const;
      expect((await a.remote(bv.instanceId, open)).chat?.chats).toHaveLength(1);
      await a.remote(bv.instanceId, open);
      const send = { action: "chat.send", chatId: "chat", id: "send", text: "你好，主控" } as const;
      await a.remote(bv.instanceId, send);
      await a.remote(bv.instanceId, send);
      const reply = await a.remote(bv.instanceId, { action: "chat.read", chatId: "chat" });
      expect(reply.chat?.thread?.messages).toHaveLength(1);
      await expect(
        a.remote(bv.instanceId, { ...send, text: "不允许用同一 ID 改写内容" }),
      ).rejects.toThrow("其他内容");
      expect((await b.overview()).tasks).toHaveLength(0);
      // Binary data larger than the peer JSON limit crosses bounded chunks and
      // is claimed by the real engine under the sending peer's principal.
      await a.remote(bv.instanceId, { action: "chat.open", id: "uploads", title: "新对话" });
      const bytes = Buffer.alloc(300_000, 42);
      const begun = await a.remote(bv.instanceId, {
        action: "chat.attachment.begin",
        chatId: "uploads",
        type: "file",
        name: "report.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.length,
      });
      const attachmentId = begun.chat!.attachment!.id;
      for (let offset = 0; offset < bytes.length; offset += PEER_ATTACHMENT_CHUNK_BYTES) {
        const chunk = {
          action: "chat.attachment.chunk",
          chatId: "uploads",
          attachmentId,
          offset,
          data: bytes.subarray(offset, offset + PEER_ATTACHMENT_CHUNK_BYTES).toString("base64"),
        } as const;
        await a.remote(bv.instanceId, chunk);
        await a.remote(bv.instanceId, chunk);
      }
      const finish = {
        action: "chat.attachment.finish",
        chatId: "uploads",
        attachmentId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      } as const;
      const uploaded = (await a.remote(bv.instanceId, finish)).chat!.attachment!;
      expect((await a.remote(bv.instanceId, finish)).chat!.attachment).toEqual(uploaded);
      await expect(a.remote(bv.instanceId, { ...finish, chatId: "chat" })).rejects.toThrow(
        "不属于",
      );
      const attachmentSend = {
        action: "chat.send",
        chatId: "uploads",
        id: "attachment-only",
        text: "",
        attachments: [uploaded],
      } as const;
      await a.remote(bv.instanceId, attachmentSend);
      await a.remote(bv.instanceId, attachmentSend);
      const uploadedChat = (
        await a.remote(bv.instanceId, { action: "chat.read", chatId: "uploads" })
      ).chat!;
      expect(uploadedChat.thread!.messages).toHaveLength(1);
      expect(uploadedChat.thread!.messages[0]!.attachments).toEqual([uploaded]);
      expect(uploadedChat.thread!.title).toBe("Remote · report.bin");
      const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
      const blob = Option.getOrThrow(
        await runtime.runPromise(repository.findClaimedById({ attachmentId })),
      );
      expect(blob.ownerId).toBe(`peer-chat:${av.instanceId}`);
      expect(await fs.readFile(path.join(config.attachmentsDir, blob.relativePath))).toEqual(bytes);
      await expect(
        b.remote(av.instanceId, {
          action: "chat.attachment.begin",
          chatId: "chat",
          type: "file",
          name: "old.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        }),
      ).rejects.toThrow("更新并重启");
      await b.stop();
      await expect(
        a.remote(bv.instanceId, {
          action: "chat.send",
          chatId: "chat",
          id: "offline-send",
          text: "断线中的追问",
        }),
      ).rejects.toThrow();
      await b.start();
      await a.tick();
      const resumed = await a.remote(bv.instanceId, { action: "chat.read", chatId: "chat" });
      expect(resumed.chat?.thread?.messages.map((message) => message.text)).toEqual([
        "你好，主控",
        "断线中的追问",
      ]);
      await a.remote(bv.instanceId, {
        action: "chat.send",
        chatId: "chat",
        id: "offline-send",
        text: "断线中的追问",
      });
      expect(
        (await a.remote(bv.instanceId, { action: "chat.read", chatId: "chat" })).chat?.thread
          ?.messages,
      ).toHaveLength(2);
      await b.control({ action: "revoke", peerId: av.instanceId });
      await expect(
        a.remote(bv.instanceId, { action: "chat.read", chatId: "chat" }),
      ).rejects.toThrow("未配对");
      expect(await controller.isController(reply.chat!.thread!.id)).toBe(false);
    } finally {
      await Promise.all(managers.map((manager) => manager.stop()));
      await runtime.dispose();
    }
  });
  it("pages conversation history and returns streamed replies with stable revisions", async () => {
    const runtime = createTestRuntime();
    try {
      const config = await runtime.runPromise(Effect.service(ServerConfig));
      const host = await runtime.runPromise(makeMetisControllerHost);
      const controller = new MetisController(path.join(config.stateDir, "paged-controller"), host);
      await controller.initialize();
      await controller.control({
        action: "open",
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
      });
      const execution = await runtime.runPromise(
        makePeerChatExecution.pipe(Effect.provideService(MetisControllerService, controller)),
      );
      const peer = `metis-${"c".repeat(32)}`;
      await execution.handle(peer, { action: "chat.open", id: "pages", title: "新对话" });
      for (let index = 0; index < 63; index++)
        await execution.handle(peer, {
          action: "chat.send",
          chatId: "pages",
          id: `message-${index}`,
          text: `消息 ${index}`,
        });
      const latest = await execution.handle(peer, { action: "chat.read", chatId: "pages" });
      expect(latest.thread?.messages).toHaveLength(60);
      expect(latest.thread?.title).toBe("Remote · 消息 0");
      const older = await execution.handle(peer, {
        action: "chat.read",
        chatId: "pages",
        before: latest.before!,
      });
      expect(older.thread?.messages).toHaveLength(3);
      expect(older.before).toBeNull();
      expect(
        new Set(
          [...older.thread!.messages, ...latest.thread!.messages].map((message) => message.id),
        ).size,
      ).toBe(63);
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const common = {
        threadId: latest.thread!.id,
        messageId: MessageId.makeUnsafe("remote-reply"),
        createdAt: new Date().toISOString(),
      };
      await runtime.runPromise(
        engine.dispatch({
          ...common,
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("delta"),
          delta: "正在回答",
        }),
      );
      const streaming = await execution.handle(peer, {
        action: "chat.read",
        chatId: "pages",
        revision: latest.revision!,
      });
      expect(streaming.thread?.messages.at(-1)?.text).toBe("正在回答");
      expect(streaming.thread?.messages.at(-1)?.streaming).toBe(true);
      await runtime.runPromise(
        engine.dispatch({
          ...common,
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("complete"),
        }),
      );
      const complete = await execution.handle(peer, {
        action: "chat.read",
        chatId: "pages",
        revision: streaming.revision!,
      });
      expect(complete.thread?.messages.at(-1)?.streaming).toBe(false);
      expect(complete.revision).not.toBe(streaming.revision);
    } finally {
      await runtime.dispose();
    }
  });
  it("creates one ordinary chat, preserves its model/permissions, deduplicates reflection and protects soul edits", async () => {
    const runtime = createTestRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const host = await runtime.runPromise(makeMetisControllerHost);
      const memory = await runtime.runPromise(Effect.service(MetisMemory));
      await host.initializeSoul();
      const soul = await runtime.runPromise(memory.readSoul());
      expect(soul.content).toContain("Metis");
      await runtime.runPromise(memory.writeSoul("Owner soul"));
      await host.initializeSoul();
      expect((await runtime.runPromise(memory.readSoul())).content).toBe("Owner soul");
      await expect(
        runtime.runPromise(
          memory.writeSoul(
            "Stale agent update",
            createHash("sha256").update(soul.content).digest("hex"),
          ),
        ),
      ).rejects.toThrow("changed");
      const revision = createHash("sha256").update("Owner soul").digest("hex");
      const simultaneous = await Promise.allSettled([
        runtime.runPromise(memory.writeSoul("First edit", revision)),
        runtime.runPromise(memory.writeSoul("Second edit", revision)),
      ]);
      expect(simultaneous.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      const model = { provider: "codex", model: "test-model" } as const;
      await host.createThread("metis-controller-test", model, "approval-required");
      await host.createThread("metis-controller-test", model, "full-access");
      const snapshot = await runtime.runPromise(engine.getReadModel());
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.modelSelection).toEqual(model);
      expect(snapshot.threads[0]?.runtimeMode).toBe("approval-required");
      expect(await host.resolveThread(null)).toBe("metis-controller-test");
      expect(await host.isIdle("metis-controller-test")).toBe(true);
      await host.dispatchReflection("metis-controller-test", "batch-1", [
        { threadId: "work", turnId: "turn-1", title: "Work" },
      ]);
      await host.dispatchReflection("metis-controller-test", "batch-1", [
        { threadId: "work", turnId: "turn-1", title: "Work" },
      ]);
      expect(await host.reflectionState("metis-controller-test", "batch-1")).toBe("working");
      expect(await host.isIdle("metis-controller-test")).toBe(false);
      const after = await runtime.runPromise(engine.getReadModel());
      expect(after.threads[0]?.messages).toHaveLength(1);
      expect(after.threads[0]?.messages[0]?.text).toContain("batch-1");
      await engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("archive"),
          threadId: ThreadId.makeUnsafe("metis-controller-test"),
        })
        .pipe(runtime.runPromise);
      expect(await host.resolveThread("metis-controller-test")).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
  it("opens an empty controller after clear and keeps that binding across retries and restart", async () => {
    const runtime = createTestRuntime();
    try {
      const config = await runtime.runPromise(Effect.service(ServerConfig));
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const host = await runtime.runPromise(makeMetisControllerHost);
      const memory = await runtime.runPromise(Effect.service(MetisMemory));
      const controller = new MetisController(path.join(config.stateDir, "metis"), host);
      await controller.initialize();
      const open = {
        action: "open",
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
      } as const;
      const old = await controller.control(open);
      await runtime.runPromise(memory.writeSoul("Keep the owner's soul"));
      await host.dispatchReflection(old.threadId!, "old-batch", [
        { threadId: "work", turnId: "turn-1", title: "Old report" },
      ]);
      const clear = {
        ...open,
        action: "clear",
        sourceThreadId: ThreadId.makeUnsafe(old.threadId!),
      } as const;
      const [fresh, duplicate] = await Promise.all([
        controller.control(clear),
        controller.control(clear),
      ]);
      expect(fresh.id).toBe(old.id);
      expect(fresh.threadId).not.toBe(old.threadId);
      expect(duplicate.threadId).toBe(fresh.threadId);
      expect((await controller.control(open)).threadId).toBe(fresh.threadId);
      const snapshot = await runtime.runPromise(engine.getReadModel());
      expect(snapshot.threads).toHaveLength(2);
      const newThread = snapshot.threads.find((thread) => thread.id === fresh.threadId)!;
      const oldThread = snapshot.threads.find((thread) => thread.id === old.threadId)!;
      expect(oldThread.messages).toHaveLength(1);
      expect(oldThread.deletedAt).toBeNull();
      expect(newThread.messages).toEqual([]);
      expect(newThread.modelSelection).toEqual(open.modelSelection);
      expect(newThread.runtimeMode).toBe(open.runtimeMode);
      expect((await runtime.runPromise(memory.readSoul())).content).toBe("Keep the owner's soul");
      expect(await controller.isController(old.threadId!)).toBe(false);
      expect(await controller.isController(fresh.threadId!)).toBe(true);
      const restarted = new MetisController(path.join(config.stateDir, "metis"), host);
      await restarted.initialize();
      expect((await restarted.control(open)).threadId).toBe(fresh.threadId);
      expect((await restarted.control(clear)).threadId).toBe(fresh.threadId);
      expect((await runtime.runPromise(engine.getReadModel())).threads).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });
});
