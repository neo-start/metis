import { createHash } from "node:crypto";

import {
  CommandId,
  MessageId,
  type ExternalMcpCapability,
  type ExternalMcpFollowUpTaskInput,
  type ExternalMcpAnswerTaskInput,
  type ExternalMcpApproveTaskInput,
  type ExternalMcpCancelTaskInput,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ThreadId,
} from "@synara/contracts";
import { createStalePendingInteractionMatcher } from "@synara/shared/pendingInteractions";
import { Effect, Option, Semaphore } from "effect";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";

/** Transport adapters supply authority, never a boolean "trusted" shortcut. */
export interface TaskControlAuthority {
  readonly integrationId: string;
  readonly capabilities: ReadonlySet<ExternalMcpCapability>;
  readonly assertActive: () => Effect.Effect<void, GatewayToolError>;
  readonly assertOwnedTask: (threadId: ThreadId) => Effect.Effect<void, GatewayToolError>;
}

export interface TaskControlDependencies {
  readonly snapshots: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly receipts: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">;
}

type TaskControlCommand = Extract<
  OrchestrationCommand,
  {
    readonly type:
      | "thread.turn.start"
      | "thread.approval.respond"
      | "thread.user-input.respond"
      | "thread.turn.interrupt";
  }
>;

const denied = (message: string) => new GatewayToolError("capability_denied", message);
const stale = (message: string) => new GatewayToolError("stale_task_state", message);
const requireCapability = (authority: TaskControlAuthority, scope: ExternalMcpCapability) =>
  authority.capabilities.has(scope)
    ? Effect.void
    : Effect.fail(denied(`This operation requires the explicit "${scope}" scope.`));

export function taskControlCommandId(integrationId: string, requestId: string) {
  // One namespace across every mutation and task: reusing a key for another
  // action is a conflict, not a second command. No caller can choose raw IDs.
  const hash = createHash("sha256")
    .update(JSON.stringify([integrationId, requestId]))
    .digest("hex");
  return CommandId.makeUnsafe(`external_task_control_${hash}`);
}

export function taskControlProgress(thread: OrchestrationThread) {
  const isStale = createStalePendingInteractionMatcher(thread.activities);
  return {
    updatedAt: thread.updatedAt,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    runId: thread.latestTurn?.turnId ?? null,
    pendingInteractions: (thread.pendingInteractions ?? [])
      .filter(
        (entry) => entry.resolvedAt === null && entry.status !== "confirmed" && !isStale(entry),
      )
      .map((entry) =>
        Object.assign({}, entry, {
          interactionId: entry.requestId,
          request:
            thread.activities.findLast((activity) => {
              if (
                activity.kind !==
                  (entry.interactionKind === "approval"
                    ? "approval.requested"
                    : "user-input.requested") ||
                activity.payload === null ||
                typeof activity.payload !== "object"
              )
                return false;
              const payload = activity.payload as Record<string, unknown>;
              return (
                payload.requestId === entry.requestId &&
                (payload.lifecycleGeneration ?? null) === entry.lifecycleGeneration
              );
            })?.payload ?? null,
        }),
      ),
    asyncUserInputs: thread.messages
      .filter((message) => message.asyncUserInput && !message.asyncUserInput.response)
      .map((message) => ({
        messageId: message.id,
        questions: message.asyncUserInput!.questions,
        responseSequence: message.asyncUserInput!.responseSequence,
      })),
  };
}

/** Reuse command receipts, projection state and the provider command reactor. */
export const makeTaskControlService = Effect.fn(function* (dependencies: TaskControlDependencies) {
  // Serialize validation with other controls on this surface, including replies
  // with different request IDs. The engine remains the global command arbiter.
  const lock = yield* Semaphore.make(1);

  const mutate = (
    authority: TaskControlAuthority,
    scope: ExternalMcpCapability,
    command: TaskControlCommand,
    validate: (thread: OrchestrationThread) => Effect.Effect<void, GatewayToolError>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* requireCapability(authority, scope);
        yield* authority.assertActive();
        yield* authority.assertOwnedTask(command.threadId);
        const receipt = yield* dependencies.receipts.getByCommandId({
          commandId: command.commandId,
        });
        if (Option.isSome(receipt)) {
          const fingerprint = fingerprintOrchestrationCommand(command);
          if (
            receipt.value.fingerprintVersion !== fingerprint.version ||
            receipt.value.commandFingerprint !== fingerprint.value
          ) {
            return yield* Effect.fail(
              new GatewayToolError(
                "idempotency_conflict",
                "requestId is already bound to different command content.",
              ),
            );
          }
          if (receipt.value.status !== "accepted") {
            return yield* Effect.fail(
              new GatewayToolError(
                "command_rejected",
                "This request was previously rejected. Read progress and use a new requestId.",
              ),
            );
          }
          yield* authority.assertActive();
          return {
            threadId: command.threadId,
            commandId: command.commandId,
            sequence: receipt.value.resultSequence,
            accepted: true as const,
            replayed: true,
          };
        }
        const requestedAt = Date.parse(command.createdAt);
        if (
          !Number.isFinite(requestedAt) ||
          requestedAt < Date.now() - 5 * 60_000 ||
          requestedAt > Date.now() + 30_000
        ) {
          return yield* Effect.fail(
            stale(
              "requestedAt must be a current ISO timestamp for a new request (within five minutes, at most 30 seconds ahead).",
            ),
          );
        }
        const detail = yield* dependencies.snapshots.getThreadDetailById(command.threadId);
        if (Option.isNone(detail) || detail.value.deletedAt !== null) {
          return yield* Effect.fail(new GatewayToolError("task_not_found", "Task was not found."));
        }
        yield* validate(detail.value);
        yield* authority.assertActive();
        const result = yield* dependencies.engine.dispatch(command);
        return {
          threadId: command.threadId,
          commandId: command.commandId,
          sequence: result.sequence,
          accepted: true as const,
          replayed: false,
        };
      }),
    );

  const followUp = (authority: TaskControlAuthority, input: ExternalMcpFollowUpTaskInput) => {
    const commandId = taskControlCommandId(authority.integrationId, input.requestId);
    return mutate(
      authority,
      "tasks:follow-up",
      {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        createdAt: input.requestedAt,
        message: {
          messageId: MessageId.makeUnsafe(`${commandId}_message`),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        runtimeMode: input.expectedRuntimeMode,
        interactionMode: input.expectedInteractionMode,
        dispatchMode: "queue",
        followUpPrecondition: { expectedThreadUpdatedAt: input.expectedUpdatedAt },
        ...(input.asyncUserInputResponse
          ? { asyncUserInputResponse: input.asyncUserInputResponse }
          : {}),
      },
      (thread) =>
        Effect.gen(function* () {
          if (
            thread.updatedAt !== input.expectedUpdatedAt ||
            thread.runtimeMode !== input.expectedRuntimeMode ||
            thread.interactionMode !== input.expectedInteractionMode ||
            thread.archivedAt !== null
          ) {
            return yield* Effect.fail(
              stale("Task settings or progress changed. Read the task again before following up."),
            );
          }
          if (
            thread.latestTurn?.state === "running" ||
            thread.session?.status === "running" ||
            thread.session?.status === "starting" ||
            thread.hasPendingApprovals ||
            thread.hasPendingUserInput
          ) {
            return yield* Effect.fail(
              stale(
                "Wait for the current turn or answer its pending interaction before following up.",
              ),
            );
          }
          if (thread.runtimeMode !== "approval-required")
            yield* requireCapability(authority, "runtime:full-access");
          if (thread.envMode === "local") yield* requireCapability(authority, "runtime:local");
          if (input.asyncUserInputResponse) yield* requireCapability(authority, "tasks:answer");
        }),
    );
  };

  const respond = (
    authority: TaskControlAuthority,
    input: ExternalMcpAnswerTaskInput | ExternalMcpApproveTaskInput,
    kind: "approval" | "userInput",
  ) => {
    const common = {
      commandId: taskControlCommandId(authority.integrationId, input.requestId),
      threadId: input.threadId,
      requestId: input.interactionId,
      createdAt: input.requestedAt,
      ...(input.lifecycleGeneration !== null
        ? { lifecycleGeneration: input.lifecycleGeneration }
        : {}),
    };
    const command: OrchestrationCommand =
      "decision" in input
        ? { ...common, type: "thread.approval.respond", decision: input.decision }
        : { ...common, type: "thread.user-input.respond", answers: input.answers };
    return Effect.gen(function* () {
      if ("decision" in input && input.decision === "acceptForSession") {
        yield* requireCapability(authority, "tasks:approve-session");
      }
      return yield* mutate(
        authority,
        kind === "approval" ? "tasks:approve" : "tasks:answer",
        command,
        (thread) =>
          Effect.gen(function* () {
            const entry = taskControlProgress(thread).pendingInteractions.find(
              (candidate) =>
                candidate.interactionKind === kind &&
                candidate.requestId === input.interactionId &&
                candidate.lifecycleGeneration === input.lifecycleGeneration,
            );
            if (!entry || (entry.status !== "pending" && entry.status !== "retryable")) {
              return yield* Effect.fail(
                stale("This interaction is no longer pending in the requested provider lifecycle."),
              );
            }
          }),
      );
    });
  };

  const cancel = (authority: TaskControlAuthority, input: ExternalMcpCancelTaskInput) =>
    mutate(
      authority,
      "tasks:cancel",
      {
        type: "thread.turn.interrupt",
        commandId: taskControlCommandId(authority.integrationId, input.requestId),
        threadId: input.threadId,
        turnId: input.runId,
        createdAt: input.requestedAt,
      },
      (thread) =>
        thread.latestTurn?.turnId === input.runId && thread.latestTurn.state === "running"
          ? Effect.void
          : Effect.fail(
              stale("The requested run is no longer active. Read progress before cancelling."),
            ),
    );

  return {
    followUp,
    answer: (authority: TaskControlAuthority, input: ExternalMcpAnswerTaskInput) =>
      respond(authority, input, "userInput"),
    approve: (authority: TaskControlAuthority, input: ExternalMcpApproveTaskInput) =>
      respond(authority, input, "approval"),
    cancel,
  };
});
