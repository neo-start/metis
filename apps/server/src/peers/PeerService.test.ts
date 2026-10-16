import {
  ApprovalRequestId,
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type PeerTask,
  type PeerTaskResponse,
} from "@synara/contracts";
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
      // Real durable projection/engine, without invoking a provider or paid model.
      const appendRequest = async (kind: "approval" | "userInput", generation: string) => {
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`request-${kind}-${generation}`),
            threadId: worker.id,
            createdAt,
            activity: {
              id: EventId.makeUnsafe(`activity-${kind}-${generation}`),
              tone: "approval",
              kind: kind === "approval" ? "approval.requested" : "user-input.requested",
              summary: "Needs owner input",
              turnId: null,
              createdAt,
              payload: {
                requestId: `${kind}-request`,
                lifecycleGeneration: generation,
                ...(kind === "approval"
                  ? { requestKind: "command", detail: "Run isolated check" }
                  : {
                      questions: [
                        {
                          id: "choice",
                          header: "Choose",
                          question: "Which option?",
                          options: [{ label: "A", description: "First" }],
                        },
                      ],
                    }),
              },
            },
          }),
        );
      };
      await appendRequest("approval", "one");
      const waiting = await recovered.status(worker.id);
      expect(waiting.state).toBe("waiting");
      expect(waiting.attention?.[0]).toMatchObject({
        kind: "approval",
        requestId: "approval-request",
        lifecycleGeneration: "one",
      });
      const response: PeerTaskResponse = {
        action: "respond",
        taskId: task.id,
        requestId: "approval-request",
        lifecycleGeneration: "one",
        responseAttemptId: null,
        createdAt,
        response: { kind: "approval", decision: "accept" },
      };
      await expect(
        recovered.respond(worker.id, { ...response, lifecycleGeneration: "wrong" }),
      ).rejects.toThrow("失效");
      await expect(
        recovered.respond(worker.id, { ...response, responseAttemptId: "old-attempt" }),
      ).rejects.toThrow("失效");
      await expect(
        recovered.respond(worker.id, { ...response, createdAt: "2026-10-12T00:00:00.000Z" }),
      ).rejects.toThrow("失效");
      await expect(recovered.respond(templateId, response)).rejects.toThrow("失效");
      await recovered.respond(worker.id, response);
      await expect(recovered.respond(worker.id, response)).rejects.toThrow("失效");
      await appendRequest("approval", "two");
      await expect(recovered.respond(worker.id, response)).rejects.toThrow("失效");
      await recovered.respond(worker.id, {
        ...response,
        lifecycleGeneration: "two",
        response: { kind: "approval", decision: "decline" },
      });
      // Engine admission only permits pending/retryable approvals. In particular,
      // the provider claim grace period must not resurrect responding buttons.
      for (const settlement of ["uncertain", "retryable"] as const) {
        const generation = `recovery-${settlement}`;
        const commandId = CommandId.makeUnsafe(`respond-${generation}`);
        await appendRequest("approval", generation);
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.approval.respond",
            commandId,
            threadId: worker.id,
            requestId: ApprovalRequestId.makeUnsafe("approval-request"),
            lifecycleGeneration: generation,
            decision: "accept",
            createdAt: "2020-01-01T00:00:00.000Z",
          }),
        );
        const responding = await recovered.status(worker.id);
        expect(responding.state).toBe("waiting");
        expect(responding.attention).toEqual([]);
        expect(responding.localRecovery).toEqual([
          { requestId: "approval-request", status: "responding" },
        ]);
        const retryResponse = {
          ...response,
          lifecycleGeneration: generation,
          responseAttemptId: commandId,
        };
        await expect(recovered.respond(worker.id, retryResponse)).rejects.toThrow("失效");
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`failed-${generation}`),
            threadId: worker.id,
            createdAt,
            activity: {
              id: EventId.makeUnsafe(`failed-${generation}`),
              kind: "provider.approval.respond.failed",
              tone: "error",
              summary: "Delivery failed",
              turnId: null,
              createdAt,
              payload: {
                requestId: "approval-request",
                lifecycleGeneration: generation,
                responseCommandId: commandId,
                settlementStatus: settlement,
                detail: "Ambiguous delivery",
              },
            },
          }),
        );
        const afterFailure = await recovered.status(worker.id);
        if (settlement === "uncertain") {
          expect(afterFailure.state).toBe("waiting");
          expect(afterFailure.attention).toEqual([]);
          expect(afterFailure.localRecovery).toEqual([
            { requestId: "approval-request", status: "uncertain" },
          ]);
          await expect(recovered.respond(worker.id, retryResponse)).rejects.toThrow("失效");
        } else {
          expect(afterFailure.localRecovery).toEqual([]);
          expect(afterFailure.attention?.[0]?.responseAttemptId).toBe(commandId);
          await recovered.respond(worker.id, retryResponse);
        }
      }
      await appendRequest("userInput", "one");
      const answer: PeerTaskResponse = {
        ...response,
        requestId: "userInput-request",
        response: { kind: "userInput", answers: { foreign: "A" } },
      };
      await expect(recovered.respond(worker.id, answer)).rejects.toThrow("所有问题");
      await recovered.respond(worker.id, {
        ...answer,
        response: { kind: "userInput", answers: { choice: "A" } },
      });
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (entry) => entry.id === worker.id,
        )?.runtimeMode,
      ).toBe("approval-required");
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
