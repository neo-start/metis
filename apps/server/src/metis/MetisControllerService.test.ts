import path from "node:path";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { QueuedTurnPromotionRepositoryLive } from "../persistence/Layers/QueuedTurnPromotions.ts";
import { CommandId, ThreadId } from "@synara/contracts";
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
import { makeMetisControllerHost } from "./MetisControllerService.ts";
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
