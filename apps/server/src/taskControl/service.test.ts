import {
  ApprovalRequestId,
  ProjectId,
  ThreadId,
  TurnId,
  type ExternalMcpCapability,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import type { OrchestrationCommandReceipt } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  makeTaskControlService,
  taskControlProgress,
  type TaskControlAuthority,
} from "./service.ts";

const THREAD = ThreadId.makeUnsafe("owned-task");
const RUN = TurnId.makeUnsafe("run-1");
const REQUEST = ApprovalRequestId.makeUnsafe("provider-request");
const SCOPES: ExternalMcpCapability[] = [
  "tasks:follow-up",
  "tasks:answer",
  "tasks:approve",
  "tasks:cancel",
  "runtime:local",
];

function fixture() {
  const now = new Date().toISOString();
  let thread = {
    id: THREAD,
    title: "Controlled task",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    createdAt: now,
    handoff: null,
    proposedPlans: [],
    checkpoints: [],
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
    pendingInteractions: [],
  } as unknown as OrchestrationThread;
  const receipts = new Map<string, OrchestrationCommandReceipt>();
  const commands: OrchestrationCommand[] = [];
  let active = true;
  const authority: TaskControlAuthority = {
    integrationId: "client",
    capabilities: new Set(SCOPES),
    assertActive: () =>
      active ? Effect.void : Effect.fail(new GatewayToolError("inactive", "revoked")),
    assertOwnedTask: () => Effect.void,
  };
  const make = (
    admit?: (command: OrchestrationCommand) => Effect.Effect<unknown, OrchestrationDispatchError>,
  ) =>
    Effect.runPromise(
      makeTaskControlService({
        snapshots: { getThreadDetailById: () => Effect.succeed(Option.some(thread)) },
        receipts: {
          getByCommandId: ({ commandId }) =>
            Effect.succeed(Option.fromNullishOr(receipts.get(commandId))),
        },
        engine: {
          dispatch: (command) =>
            Effect.gen(function* () {
              if (admit) yield* admit(command);
              commands.push(command);
              const fingerprint = fingerprintOrchestrationCommand(command);
              receipts.set(command.commandId, {
                commandId: command.commandId,
                aggregateKind: "thread",
                aggregateId: THREAD,
                acceptedAt: now,
                status: "accepted",
                error: null,
                resultSequence: commands.length,
                fingerprintVersion: fingerprint.version,
                commandFingerprint: fingerprint.value,
              });
              return { sequence: commands.length };
            }),
        },
      }),
    );
  const base = { requestId: "operation", threadId: THREAD, requestedAt: now };
  const followUp = {
    ...base,
    expectedUpdatedAt: now,
    expectedRuntimeMode: "approval-required" as const,
    expectedInteractionMode: "default" as const,
    prompt: "Continue",
  };
  const interaction = { ...base, interactionId: REQUEST, lifecycleGeneration: "generation-1" };
  const pending = (kind: "approval" | "userInput") => {
    thread = {
      ...thread,
      pendingInteractions: [
        {
          interactionKind: kind,
          requestId: REQUEST,
          threadId: THREAD,
          turnId: RUN,
          lifecycleGeneration: "generation-1",
          status: "pending",
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: now,
          resolvedAt: null,
        },
      ],
    };
  };
  return {
    now,
    make,
    commands,
    receipts,
    authority,
    base,
    followUp,
    interaction,
    pending,
    revoke: () => {
      active = false;
    },
    patch: (patch: Partial<OrchestrationThread>) => {
      thread = { ...thread, ...patch };
    },
    thread: () => thread,
  };
}

const rejected = async (effect: Effect.Effect<unknown, unknown>, code: string) => {
  const result = await Effect.runPromise(Effect.result(effect));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code } });
};

describe("task control service", () => {
  it("dispatches a follow-up with an atomic idle precondition and preserves settings", async () => {
    const f = fixture();
    const service = await f.make();
    expect(await Effect.runPromise(service.followUp(f.authority, f.followUp))).toMatchObject({
      accepted: true,
      replayed: false,
    });
    expect(f.commands[0]).toMatchObject({
      type: "thread.turn.start",
      runtimeMode: "approval-required",
      interactionMode: "default",
      followUpPrecondition: { expectedThreadUpdatedAt: f.now },
      message: { text: "Continue", attachments: [] },
    });
    expect(f.commands[0]).not.toHaveProperty("modelSelection");
  });

  it("continues intentional plan feedback through the real decider without approving implementation", async () => {
    const f = fixture();
    f.patch({
      hasActionableProposedPlan: true,
      interactionMode: "plan",
      proposedPlans: [
        {
          id: "plan",
          turnId: null,
          planMarkdown: "Plan awaiting review",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: f.now,
          updatedAt: f.now,
        },
      ],
    });
    const service = await f.make((command) =>
      decideOrchestrationCommand({
        command,
        readModel: {
          snapshotSequence: 1,
          updatedAt: f.now,
          projects: [],
          spaces: [],
          threads: [f.thread()],
        },
      }),
    );
    await Effect.runPromise(
      service.followUp(f.authority, {
        ...f.followUp,
        expectedInteractionMode: "plan",
        prompt: "Revise the plan.",
      }),
    );
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).not.toHaveProperty("sourceProposedPlan");
    expect(f.commands[0]).not.toHaveProperty("deliveryPrecondition");
  });

  it("rejects a plan follow-up if state changes after the adapter check but before admission", async () => {
    const f = fixture();
    f.patch({ hasActionableProposedPlan: true });
    const service = await f.make((command) => {
      f.patch({ updatedAt: new Date(Date.parse(f.now) + 1).toISOString() });
      return decideOrchestrationCommand({
        command,
        readModel: {
          snapshotSequence: 1,
          updatedAt: f.now,
          projects: [],
          spaces: [],
          threads: [f.thread()],
        },
      });
    });
    const result = await Effect.runPromise(
      Effect.result(service.followUp(f.authority, f.followUp)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OrchestrationCommandInvariantError" },
    });
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
  });

  it("rejects a cancel if a replacement run starts between adapter validation and serialized admission", async () => {
    const f = fixture();
    f.patch({
      goal: "Keep working",
      goalPausedAt: null,
      latestTurn: {
        turnId: RUN,
        state: "running",
        requestedAt: f.now,
        startedAt: f.now,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const service = await f.make((command) => {
      f.patch({
        latestTurn: { ...f.thread().latestTurn!, turnId: TurnId.makeUnsafe("replacement") },
      });
      return decideOrchestrationCommand({
        command,
        readModel: {
          snapshotSequence: 1,
          updatedAt: f.now,
          projects: [],
          spaces: [],
          threads: [f.thread()],
        },
      });
    });
    const result = await Effect.runPromise(
      Effect.result(service.cancel(f.authority, { ...f.base, runId: RUN })),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OrchestrationCommandInvariantError" },
    });
    expect(f.commands).toHaveLength(0);
    expect(f.thread().goalPausedAt).toBeNull();
  });

  it("replays stable requests after service recreation and task progress changes", async () => {
    const f = fixture();
    const first = await f.make();
    const result = await Effect.runPromise(first.followUp(f.authority, f.followUp));
    f.patch({ updatedAt: "changed", runtimeMode: "full-access" });
    const restarted = await f.make();
    expect(await Effect.runPromise(restarted.followUp(f.authority, f.followUp))).toMatchObject({
      ...result,
      replayed: true,
    });
    expect(f.commands).toHaveLength(1);
    await rejected(
      restarted.followUp(f.authority, { ...f.followUp, prompt: "Changed intent" }),
      "idempotency_conflict",
    );
    await rejected(
      restarted.cancel(f.authority, { ...f.base, runId: RUN }),
      "idempotency_conflict",
    );
  });

  it("serializes concurrent stable retries into one dispatched turn", async () => {
    const f = fixture();
    const service = await f.make();
    await Effect.runPromise(
      Effect.all(
        [service.followUp(f.authority, f.followUp), service.followUp(f.authority, f.followUp)],
        { concurrency: "unbounded" },
      ),
    );
    expect(f.commands).toHaveLength(1);
  });

  it("rechecks revocation and scopes before returning a receipt", async () => {
    const f = fixture();
    const service = await f.make();
    await Effect.runPromise(service.followUp(f.authority, f.followUp));
    await rejected(
      service.followUp({ ...f.authority, capabilities: new Set() }, f.followUp),
      "capability_denied",
    );
    f.revoke();
    await rejected(service.followUp(f.authority, f.followUp), "inactive");
    expect(f.commands).toHaveLength(1);
  });

  it("rejects old requests, stale progress and permission changes", async () => {
    const f = fixture();
    const service = await f.make();
    await rejected(
      service.followUp(f.authority, { ...f.followUp, requestedAt: "2000-01-01T00:00:00Z" }),
      "stale_task_state",
    );
    await rejected(
      service.followUp(f.authority, { ...f.followUp, expectedUpdatedAt: "stale" }),
      "stale_task_state",
    );
    await rejected(
      service.followUp(f.authority, { ...f.followUp, expectedRuntimeMode: "full-access" }),
      "stale_task_state",
    );
    expect(f.commands).toHaveLength(0);
  });

  it("cannot continue full-access execution without its explicit runtime grant", async () => {
    const f = fixture();
    f.patch({ runtimeMode: "full-access" });
    const service = await f.make();
    await rejected(
      service.followUp(f.authority, { ...f.followUp, expectedRuntimeMode: "full-access" }),
      "capability_denied",
    );
    expect(f.commands).toHaveLength(0);
  });

  it("requires explicit answer and approval scopes", async () => {
    const f = fixture();
    f.pending("userInput");
    const service = await f.make();
    const reader = {
      ...f.authority,
      capabilities: new Set<ExternalMcpCapability>(["tasks:read-project"]),
    };
    await rejected(
      service.answer(reader, { ...f.interaction, answers: { q: "answer" } }),
      "capability_denied",
    );
    await rejected(
      service.approve(reader, { ...f.interaction, decision: "accept" }),
      "capability_denied",
    );
    expect(f.commands).toHaveLength(0);
  });

  it("answers a lifecycle-bound input once and rejects stale generations", async () => {
    const f = fixture();
    f.pending("userInput");
    const service = await f.make();
    await rejected(
      service.answer(f.authority, {
        ...f.interaction,
        lifecycleGeneration: "old",
        answers: { q: "answer" },
      }),
      "stale_task_state",
    );
    const input = { ...f.interaction, answers: { q: ["answer"] } };
    await Effect.runPromise(service.answer(f.authority, input));
    f.patch({ pendingInteractions: [] });
    expect(await Effect.runPromise(service.answer(f.authority, input))).toMatchObject({
      replayed: true,
    });
    await rejected(
      service.answer(f.authority, { ...input, requestId: "new-request" }),
      "stale_task_state",
    );
    expect(f.commands).toHaveLength(1);
  });

  it("requires the additional session-wide approval grant", async () => {
    const f = fixture();
    f.pending("approval");
    const service = await f.make();
    const input = { ...f.interaction, decision: "acceptForSession" as const };
    await rejected(service.approve(f.authority, input), "capability_denied");
    await Effect.runPromise(
      service.approve(
        { ...f.authority, capabilities: new Set([...SCOPES, "tasks:approve-session"]) },
        input,
      ),
    );
    expect(f.commands[0]).toMatchObject({
      type: "thread.approval.respond",
      decision: "acceptForSession",
      lifecycleGeneration: "generation-1",
    });
  });

  it("rejects stale, resolved and already-responding callbacks", async () => {
    for (const status of ["responding", "confirmed", "uncertain"] as const) {
      const f = fixture();
      f.pending("approval");
      f.patch({
        pendingInteractions: [{ ...f.thread().pendingInteractions![0]!, status }],
      });
      const service = await f.make();
      await rejected(
        service.approve(f.authority, { ...f.interaction, decision: "accept" }),
        "stale_task_state",
      );
      expect(f.commands).toHaveLength(0);
    }
  });

  it("cancels the requested run and replays without interrupting a newer run", async () => {
    const f = fixture();
    f.patch({ latestTurn: { turnId: RUN, state: "running" } as OrchestrationThread["latestTurn"] });
    const service = await f.make();
    const input = { ...f.base, runId: RUN };
    await rejected(
      service.cancel(f.authority, { ...input, runId: TurnId.makeUnsafe("old") }),
      "stale_task_state",
    );
    await Effect.runPromise(service.cancel(f.authority, input));
    f.patch({
      latestTurn: {
        turnId: TurnId.makeUnsafe("new"),
        state: "running",
      } as OrchestrationThread["latestTurn"],
    });
    expect(await Effect.runPromise(service.cancel(f.authority, input))).toMatchObject({
      replayed: true,
    });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ type: "thread.turn.interrupt", turnId: RUN });
  });

  it("publishes actionable pending identity in progress", () => {
    const f = fixture();
    f.pending("userInput");
    expect(taskControlProgress(f.thread()).pendingInteractions[0]).toMatchObject({
      interactionId: REQUEST,
      lifecycleGeneration: "generation-1",
      request: null,
    });
  });
});
