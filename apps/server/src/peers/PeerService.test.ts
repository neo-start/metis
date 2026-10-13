import { CommandId, ProjectId, ThreadId, type PeerTask } from "@synara/contracts";
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
import { makePeerExecution } from "./PeerService.ts";

describe("Peer execution through the real orchestration engine", () => {
  it("inherits local permissions, isolates work, and recovers accepted dispatches without replaying turns", async () => {
    const layer = OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "metis-peer-execution-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const projectId = ProjectId.makeUnsafe("peer-project");
      const templateId = ThreadId.makeUnsafe("template");
      const createdAt = "2026-10-13T00:00:00.000Z";
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("project"),
          projectId,
          title: "Peer test",
          workspaceRoot: "/tmp/metis-peer-test-project",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("template"),
          threadId: templateId,
          projectId,
          title: "Existing configuration",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const adapter = await runtime.runPromise(makePeerExecution);
      const task: PeerTask = {
        id: "test-job",
        peerId: `metis-${"a".repeat(32)}`,
        direction: "incoming",
        text: "检查代码",
        threadId: "peer-worker",
        sourceThreadId: null,
        state: "queued",
        result: "",
        createdAt,
      };
      await adapter.submit(task, templateId);
      const first = await runtime.runPromise(engine.getReadModel());
      const worker = first.threads.find((thread) => thread.id === "peer-worker")!;
      expect(worker.runtimeMode).toBe("approval-required");
      expect(worker.modelSelection).toEqual({ provider: "codex", model: "gpt-5-codex" });
      expect(worker.projectId).toBe(projectId);
      expect(first.threads.find((thread) => thread.id === templateId)?.messages).toHaveLength(0);
      expect(worker.messages).toHaveLength(1);
      // Recreate the adapter as after a crash between engine commit and peer-state save.
      const recovered = await runtime.runPromise(makePeerExecution);
      await recovered.submit(task, templateId);
      const repeated = await runtime.runPromise(engine.getReadModel());
      expect(repeated.threads.find((thread) => thread.id === "peer-worker")?.messages).toHaveLength(
        1,
      );
      await recovered.notify({
        ...task,
        direction: "outgoing",
        sourceThreadId: templateId,
        state: "completed",
        result: "完成",
      });
      await recovered.notify({
        ...task,
        direction: "outgoing",
        sourceThreadId: templateId,
        state: "completed",
        result: "完成",
      });
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (thread) => thread.id === templateId,
        )?.messages,
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
