import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider";

const NOW = "2026-10-12T00:00:00.000Z";
const THREAD = ThreadId.makeUnsafe("delivery-thread");
function fixture(patch: Partial<OrchestrationReadModel["threads"][number]> = {}) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [],
    spaces: [],
    threads: [
      {
        id: THREAD,
        projectId: ProjectId.makeUnsafe("project"),
        title: "PR delivery",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "feature",
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        session: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        ...patch,
      },
    ],
  };
  const command: OrchestrationCommand = {
    type: "thread.turn.start",
    threadId: THREAD,
    commandId: CommandId.makeUnsafe("delivery-command"),
    message: {
      messageId: MessageId.makeUnsafe("delivery-message"),
      role: "user",
      text: "Inspect CI failure",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    dispatchMode: "queue",
    dispatchOrigin: "automation",
    deliveryPrecondition: { expectedThreadUpdatedAt: NOW },
    createdAt: NOW,
  };
  return { command, readModel };
}

describe("PR feedback serialized admission", () => {
  it("accepts an unchanged idle thread through normal approval-required orchestration", async () => {
    const result = await Effect.runPromise(decideOrchestrationCommand(fixture()));
    const events = Array.isArray(result) ? result : [result];
    expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
  });

  it.each([
    { updatedAt: "2026-10-12T00:00:01.000Z" },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { hasActionableProposedPlan: true },
    { archivedAt: NOW },
  ])(
    "defers when state changes between observation and serialized admission: %j",
    async (patch) => {
      const error = await Effect.runPromise(
        Effect.flip(decideOrchestrationCommand(fixture(patch))),
      );
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "PR feedback deferred because the thread changed or requires attention.",
      });
    },
  );
});
