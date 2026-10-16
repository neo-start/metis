import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { fingerprintOrchestrationCommand } from "./commandFingerprint.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-10-14T00:00:00.000Z";
const THREAD = ThreadId.makeUnsafe("control-thread");
const RUN_A = TurnId.makeUnsafe("run-a");
const RUN_B = TurnId.makeUnsafe("run-b");
const PLAN = {
  id: "plan-1",
  turnId: RUN_A,
  planMarkdown: "Review before implementation",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const latest = (
  turnId: TurnId,
  state: OrchestrationLatestTurn["state"] = "running",
): OrchestrationLatestTurn => ({
  turnId,
  state,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: state === "running" ? null : NOW,
  assistantMessageId: null,
});
const session = (
  activeTurnId: TurnId | null,
  status: OrchestrationSession["status"] = "running",
): OrchestrationSession => ({
  threadId: THREAD,
  activeTurnId,
  status,
  providerName: "codex",
  runtimeMode: "approval-required",
  lastError: null,
  updatedAt: NOW,
});
function model(patch: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Task",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: latest(RUN_A, "completed"),
        session: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [PLAN],
        hasActionableProposedPlan: true,
        checkpoints: [],
        deletedAt: null,
        ...patch,
      },
    ],
  };
}
const followUp = (): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("follow-up"),
  threadId: THREAD,
  message: {
    messageId: MessageId.makeUnsafe("feedback"),
    role: "user",
    text: "Revise the plan's validation section.",
    attachments: [],
  },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  dispatchMode: "queue",
  followUpPrecondition: { expectedThreadUpdatedAt: NOW },
  createdAt: NOW,
});
const interrupt = (
  turnId?: TurnId,
): Extract<OrchestrationCommand, { type: "thread.turn.interrupt" }> => ({
  type: "thread.turn.interrupt",
  commandId: CommandId.makeUnsafe("external_task_control_cancel"),
  threadId: THREAD,
  ...(turnId ? { turnId } : {}),
  createdAt: NOW,
});

describe("intentional follow-up admission", () => {
  it("allows feedback on an actionable plan without approving implementation or leaving plan mode", async () => {
    let readModel = model();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: followUp(), readModel }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const started = events.find((event) => event.type === "thread.turn-start-requested")!;
    expect(started.payload).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(started.payload).not.toHaveProperty("sourceProposedPlan");
    for (const [index, event] of events.entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: index + 2 }),
      );
    }
    expect(readModel.threads[0]!.proposedPlans).toEqual([PLAN]);
    expect(readModel.threads[0]!.interactionMode).toBe("plan");
  });

  it.each([
    { updatedAt: "2026-10-14T00:00:01.000Z" },
    { archivedAt: NOW },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { latestTurn: latest(RUN_B) },
    { session: session(null, "starting") },
    { session: session(RUN_B, "ready") },
    { runtimeMode: "full-access" as const },
    { interactionMode: "default" as const },
  ])("rejects changed or busy state atomically even with an actionable plan: %j", async (patch) => {
    const error = await Effect.runPromise(
      Effect.flip(decideOrchestrationCommand({ command: followUp(), readModel: model(patch) })),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.start",
    });
  });

  it("cannot combine plan feedback with implementation authorization", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: { ...followUp(), sourceProposedPlan: { threadId: THREAD, planId: PLAN.id } },
          readModel: model(),
        }),
      ),
    );
    expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
  });

  it("preserves the separate existing plan implementation command path", async () => {
    const { followUpPrecondition: _guard, ...command } = followUp();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          ...command,
          interactionMode: "default",
          sourceProposedPlan: { threadId: THREAD, planId: PLAN.id },
        },
        readModel: model(),
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(
      events.find((event) => event.type === "thread.turn-start-requested")!.payload,
    ).toMatchObject({
      interactionMode: "default",
      runtimeMode: "approval-required",
      sourceProposedPlan: { threadId: THREAD, planId: PLAN.id },
    });
  });

  it("does not relax the existing background precondition even when both guards are supplied", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...followUp(),
            deliveryPrecondition: { expectedThreadUpdatedAt: NOW },
            dispatchOrigin: "automation",
          },
          readModel: model(),
        }),
      ),
    );
    expect(error).toMatchObject({
      detail: "PR feedback deferred because the thread changed or requires attention.",
    });
  });

  it("keeps the guard server-only and binds its expected version into durable command identity", () => {
    const command = followUp();
    expect(Schema.decodeUnknownSync(ClientOrchestrationCommand)(command)).not.toHaveProperty(
      "followUpPrecondition",
    );
    expect(fingerprintOrchestrationCommand(command)).not.toEqual(
      fingerprintOrchestrationCommand({
        ...command,
        followUpPrecondition: { expectedThreadUpdatedAt: "2026-10-14T00:00:01.000Z" },
      }),
    );
  });
});

describe("interrupt serialized run admission", () => {
  it.each([
    { latestTurn: latest(RUN_B), session: session(RUN_B) },
    { latestTurn: latest(RUN_A), session: session(RUN_B) },
    { latestTurn: latest(RUN_B), session: session(RUN_A) },
    { latestTurn: latest(RUN_A, "completed"), session: null },
    { latestTurn: latest(RUN_A, "error"), session: session(RUN_A, "error") },
    { latestTurn: latest(RUN_A, "interrupted"), session: session(RUN_A, "stopped") },
    { latestTurn: null, session: session(null, "starting") },
  ])(
    "rejects stale/settled explicit runs before emitting pause or interrupt events: %j",
    async (patch) => {
      const readModel = model({ ...patch, goal: "Finish the task", goalPausedAt: null });
      const result = await Effect.runPromise(
        Effect.result(decideOrchestrationCommand({ command: interrupt(RUN_A), readModel })),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.turn.interrupt",
        },
      });
      expect(readModel.threads[0]!.goalPausedAt).toBeNull();
    },
  );

  it.each([
    { latestTurn: latest(RUN_A), session: session(RUN_A) },
    { latestTurn: latest(RUN_A), session: null },
    { latestTurn: latest(RUN_B, "completed"), session: session(RUN_A) },
  ])("accepts an unambiguous active run and pauses its goal first: %j", async (patch) => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: interrupt(RUN_A),
        readModel: model({ ...patch, goal: "Finish the task", goalPausedAt: null }),
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.turn-interrupt-requested",
    ]);
    expect(events[1]!.payload).toMatchObject({ turnId: RUN_A });
    expect(events[1]!.causationEventId).toBe(events[0]!.eventId);
  });

  it("preserves untargeted interrupt behavior for legacy and startup callers", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: interrupt(),
        readModel: model({
          latestTurn: null,
          session: session(null, "starting"),
          goal: "Finish",
          goalPausedAt: null,
        }),
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.turn-interrupt-requested",
    ]);
    expect(events[1]!.payload).not.toHaveProperty("turnId");
  });
});
