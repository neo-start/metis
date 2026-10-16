import { ProjectId, ThreadId, type OrchestrationThread } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { expect, it } from "vitest";

import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeTaskControlService, type TaskControlAuthority } from "./service.ts";

it("uses persisted SQL command receipts across task-control service instances", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("durable-task");
      const thread = {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        deletedAt: null,
        archivedAt: null,
        updatedAt: now,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "worktree",
        latestTurn: null,
        session: null,
        messages: [],
        activities: [],
      } as unknown as OrchestrationThread;
      const authority: TaskControlAuthority = {
        integrationId: "client",
        capabilities: new Set(["tasks:follow-up"]),
        assertActive: () => Effect.void,
        assertOwnedTask: () => Effect.void,
      };
      let dispatchCount = 0;
      const dependencies = {
        receipts,
        snapshots: { getThreadDetailById: () => Effect.succeed(Option.some(thread)) },
        engine: {
          dispatch: (command: Parameters<typeof fingerprintOrchestrationCommand>[0]) =>
            Effect.gen(function* () {
              dispatchCount += 1;
              const fingerprint = fingerprintOrchestrationCommand(command);
              yield* receipts.insert({
                commandId: command.commandId,
                aggregateId: threadId,
                aggregateKind: "thread",
                acceptedAt: now,
                status: "accepted",
                resultSequence: 7,
                error: null,
                fingerprintVersion: fingerprint.version,
                commandFingerprint: fingerprint.value,
              });
              return { sequence: 7 };
            }),
        },
      };
      // The stub only persists admission; it does not claim provider execution.
      const first = yield* makeTaskControlService(dependencies);
      const input = {
        threadId,
        requestId: "stable-request",
        requestedAt: now,
        expectedUpdatedAt: now,
        expectedRuntimeMode: "approval-required" as const,
        expectedInteractionMode: "default" as const,
        prompt: "continue",
      };
      yield* first.followUp(authority, input);
      const recreated = yield* makeTaskControlService(dependencies);
      expect(yield* recreated.followUp(authority, input)).toMatchObject({
        sequence: 7,
        replayed: true,
      });
      expect(dispatchCount).toBe(1);
    }).pipe(
      Effect.provide(
        OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
    ),
  );
});
