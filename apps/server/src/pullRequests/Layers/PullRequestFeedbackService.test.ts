import { it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationThread,
  type PullRequestDetail,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";

import { decideOrchestrationCommand } from "../../orchestration/decider";
import { OrchestrationCommandTimeoutError } from "../../orchestration/Errors";
import { runMigrations } from "../../persistence/Migrations";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient";
import {
  makePullRequestFeedbackService,
  type PullRequestFeedbackDependencies,
} from "./PullRequestFeedbackService";

type ThreadTurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const initialNow = Date.parse("2026-10-12T12:00:00.000Z");
const earlier = "2026-10-12T10:00:00.000Z";
const threadId = ThreadId.makeUnsafe("feedback-thread");
const projectId = ProjectId.makeUnsafe("feedback-project");

function makeHarness(sqlClient?: SqlClient.SqlClient) {
  const state = {
    now: initialNow,
    thread: {
      id: threadId,
      projectId,
      branch: "feature",
      worktreePath: "/tmp/feedback-worktree",
      workingDirectory: null,
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      updatedAt: earlier,
      latestHumanMessageAt: earlier,
      latestTurn: null,
      session: null,
      archivedAt: null,
      sidechatExpiredAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      lastKnownPr: {
        number: 42,
        title: "Feedback",
        url: "https://github.com/acme/widgets/pull/42",
        headBranch: "feature",
        baseBranch: "main",
        state: "open",
      },
    } as OrchestrationThreadShell,
    detail: {
      projectId,
      projectTitle: "Feedback project",
      body: "",
      author: null,
      baseBranch: "main",
      mergeable: "MERGEABLE",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      createdAt: earlier,
      updatedAt: earlier,
      mergedAt: null,
      closedAt: null,
      maintainerCanModify: false,
      reviewers: [],
      labels: [],
      commentsIncomplete: false,
      commentsTruncated: false,
      commits: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true, deleteBranchOnMerge: false },
      stack: null,
      stackMetadataIncomplete: false,
      workspaceRoot: "/tmp/feedback",
      repository: "acme/widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      title: "Feedback",
      state: "open",
      isDraft: false,
      headBranch: "feature",
      headSha: "head-1",
      mergeability: "mergeable",
      mergeStateStatus: "BLOCKED",
      reviewDecision: null,
      checks: [
        {
          name: "unit",
          status: "failure",
          description: null,
          url: "https://github.com/acme/widgets/actions/runs/1",
          startedAt: earlier,
          completedAt: earlier,
        },
      ],
      comments: [],
    } as PullRequestDetail,
    branch: "feature",
    localHead: "head-1",
    dirty: "",
    failuresLeft: 0,
    admissionRacesLeft: 0,
    detailReads: 0,
    detailForRead: null as ((read: number, detail: PullRequestDetail) => PullRequestDetail) | null,
    commands: [] as ThreadTurnStart[],
  };
  const dependencies: PullRequestFeedbackDependencies = {
    now: () => state.now,
    pullRequests: {
      detail: () =>
        Effect.sync(() => {
          state.detailReads += 1;
          return state.detailForRead?.(state.detailReads, state.detail) ?? state.detail;
        }),
    },
    snapshots: {
      getThreadShellById: (id) =>
        Effect.sync(() => (id === threadId ? Option.some(state.thread) : Option.none())),
      getShellSnapshot: () =>
        Effect.sync(() => ({
          snapshotSequence: 0,
          projects: [],
          spaces: [],
          threads: [state.thread],
          updatedAt: earlier,
        })),
    },
    git: {
      readBranchContext: () =>
        Effect.sync(() => ({ isRepo: true, branch: state.branch, upstreamRef: null })),
      execute: (input) =>
        Effect.sync(() => ({
          stdout: input.args[0] === "rev-parse" ? state.localHead : state.dirty,
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })),
    },
    engine: {
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.turn.start") throw new Error("Expected a feedback turn");
          state.commands.push(structuredClone(command));
          if (state.admissionRacesLeft > 0) {
            state.admissionRacesLeft -= 1;
            // A pin/rename/user-state update happens after the service's final idle gate.
            state.thread = {
              ...state.thread,
              updatedAt: new Date(state.now + state.commands.length * 1000).toISOString(),
            };
            const thread: OrchestrationThread = {
              ...state.thread,
              title: "Updated title",
              createdAt: earlier,
              deletedAt: null,
              messages: [],
              activities: [],
              proposedPlans: [],
              checkpoints: [],
              handoff: null,
            };
            const decision = yield* decideOrchestrationCommand({
              command,
              readModel: {
                snapshotSequence: 1,
                updatedAt: state.thread.updatedAt,
                spaces: [],
                projects: [],
                threads: [thread],
              },
            }).pipe(Effect.result);
            if (decision._tag !== "Failure")
              throw new Error("Expected stale admission to be rejected");
            const rejection = decision.failure;
            if (!sqlClient) throw new Error("Admission race test requires SQLite");
            yield* sqlClient`INSERT INTO orchestration_command_receipts(command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
              VALUES (${command.commandId}, 'thread', ${threadId}, ${new Date(state.now).toISOString()}, 1, 'rejected', ${rejection.message})`.pipe(
              Effect.orDie,
            );
            return yield* Effect.fail(rejection);
          }
          if (state.failuresLeft > 0) {
            state.failuresLeft -= 1;
            return yield* Effect.fail(
              new OrchestrationCommandTimeoutError({
                commandId: command.commandId,
                commandType: command.type,
                timeoutMs: 1,
              }),
            );
          }
          return { sequence: 1 };
        }),
    },
  };
  return { state, create: () => makePullRequestFeedbackService(dependencies) };
}

const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* runMigrations();
    return yield* effect;
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

describe("PullRequestFeedbackService durable admission", () => {
  it.effect("observes delivery while disabled and dispatches once across service recreation", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness();
        const service = yield* harness.create();
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.enabled).toBe(false);
        yield* service.poll;
        expect(harness.state.commands).toHaveLength(0);
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.status).toBe(
          "checks-failed",
        );

        yield* service.setEnabled({ threadId, enabled: true });
        yield* service.poll;
        yield* service.poll;
        const recreated = yield* harness.create();
        yield* recreated.poll;
        expect(harness.state.commands).toHaveLength(1);
        expect(harness.state.commands[0]?.runtimeMode).toBe("approval-required");
        expect(harness.state.commands[0]?.dispatchOrigin).toBe("automation");
        expect(yield* sql`SELECT state, attempts FROM pull_request_feedback_deliveries`).toEqual([
          { state: "delivered", attempts: 1 },
        ]);
      }),
    ),
  );

  it.effect("defers busy, approval, input and queued work without consuming the observation", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness();
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        const baseline = harness.state.thread;
        const gates: Array<{ patch: Partial<OrchestrationThreadShell>; reason: string }> = [
          {
            patch: { latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"] },
            reason: "active turn",
          },
          { patch: { hasPendingApprovals: true }, reason: "approval" },
          { patch: { hasPendingUserInput: true }, reason: "user input" },
          { patch: { hasActionableProposedPlan: true }, reason: "plan" },
        ];
        for (const gate of gates) {
          harness.state.thread = { ...baseline, ...gate.patch };
          yield* service.poll;
          const result = (yield* service.delivery({ threadIds: [threadId] })).items[0];
          expect(result?.feedbackStatus).toBe("deferred");
          expect(result?.deferredReason).toContain(gate.reason);
          expect(harness.state.commands).toHaveLength(0);
          expect(yield* sql`SELECT command_id FROM pull_request_feedback_deliveries`).toHaveLength(
            0,
          );
        }
        harness.state.thread = baseline;
        yield* sql`INSERT INTO orchestration_events(sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES (1, 'queued-event', 'thread', ${threadId}, 1, 'thread.message-queued', ${earlier}, 'user', '{}', '{}')`;
        yield* sql`INSERT INTO queued_turn_promotions(queued_event_sequence, thread_id, message_id, dispatch_mode, state, created_at, updated_at)
        VALUES (1, ${threadId}, 'queued-message', 'queue', 'queued', ${earlier}, ${earlier})`;
        yield* service.poll;
        expect(
          (yield* service.delivery({ threadIds: [threadId] })).items[0]?.deferredReason,
        ).toContain("queued work");
        expect(yield* sql`SELECT command_id FROM pull_request_feedback_deliveries`).toHaveLength(0);
        yield* sql`UPDATE queued_turn_promotions SET state = 'cancelled'`;
        yield* service.poll;
        expect(harness.state.commands).toHaveLength(1);
      }),
    ),
  );

  it.effect("rechecks the remote head immediately before admission", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness();
        harness.state.detailForRead = (read, detail) =>
          read === 2 ? { ...detail, headSha: "new-head" } : detail;
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        yield* service.poll;
        expect(harness.state.detailReads).toBe(2);
        expect(harness.state.commands).toHaveLength(0);
        expect(yield* sql`SELECT command_id FROM pull_request_feedback_deliveries`).toHaveLength(0);
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.headSha).toBe(
          "new-head",
        );
      }),
    ),
  );

  it.effect("retries a dispatch failure using the frozen command identity and body", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness();
        harness.state.failuresLeft = 1;
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        yield* service.poll;
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.feedbackStatus).toBe(
          "error",
        );
        expect(yield* sql`SELECT state, attempts FROM pull_request_feedback_deliveries`).toEqual([
          { state: "pending", attempts: 1 },
        ]);
        harness.state.now += 60_000;
        const recreated = yield* harness.create();
        yield* recreated.poll;
        expect(harness.state.commands).toHaveLength(2);
        expect(harness.state.commands[1]?.commandId).toBe(harness.state.commands[0]?.commandId);
        expect(harness.state.commands[1]?.message).toEqual(harness.state.commands[0]?.message);
        expect(harness.state.commands[1]?.createdAt).toBe(harness.state.commands[0]?.createdAt);
        expect(yield* sql`SELECT state, attempts FROM pull_request_feedback_deliveries`).toEqual([
          { state: "delivered", attempts: 2 },
        ]);
      }),
    ),
  );

  it.effect(
    "charges accepted receipts to the daily limit even when heads change after an ambiguous failure",
    () =>
      database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const harness = makeHarness();
          harness.state.failuresLeft = 3;
          const service = yield* harness.create();
          yield* service.setEnabled({ threadId, enabled: true });
          for (let index = 0; index < 3; index += 1) {
            harness.state.detail = { ...harness.state.detail, headSha: `head-${index + 1}` };
            harness.state.localHead = `head-${index + 1}`;
            yield* service.poll;
            const command = harness.state.commands[index]!;
            expect(command).toBeDefined();
            // The engine accepted the command but the caller died/timed out before recording it.
            yield* sql`INSERT INTO orchestration_command_receipts(command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
          VALUES (${command.commandId}, 'thread', ${threadId}, ${new Date(harness.state.now).toISOString()}, 1, 'accepted')`;
          }
          // Delivery time determines the rolling budget even for commands planned yesterday.
          yield* sql`UPDATE pull_request_feedback_deliveries SET created_at = ${new Date(harness.state.now - 172_800_000).toISOString()}`;
          harness.state.detail = { ...harness.state.detail, headSha: "head-4" };
          harness.state.localHead = "head-4";
          const recreated = yield* harness.create();
          yield* recreated.poll;
          expect(harness.state.commands).toHaveLength(3);
          expect(yield* sql`SELECT state FROM pull_request_feedback_deliveries`).toEqual([
            { state: "delivered" },
            { state: "delivered" },
            { state: "delivered" },
          ]);
          const result = (yield* recreated.delivery({ threadIds: [threadId] })).items[0];
          expect(result?.feedbackStatus).toBe("exhausted");
          expect(result?.deferredReason).toContain("three turns");
        }),
      ),
  );

  it.effect(
    "retries a durable stale-admission rejection with a new frozen identity after the thread becomes idle",
    () =>
      database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const harness = makeHarness(sql);
          harness.state.admissionRacesLeft = 1;
          const service = yield* harness.create();
          yield* service.setEnabled({ threadId, enabled: true });
          yield* service.poll;
          expect(harness.state.commands).toHaveLength(1);
          expect(
            (yield* service.delivery({ threadIds: [threadId] })).items[0]?.feedbackStatus,
          ).toBe("deferred");
          const rejectedId = harness.state.commands[0]!.commandId;
          expect(
            yield* sql`SELECT status FROM orchestration_command_receipts WHERE command_id = ${rejectedId}`,
          ).toEqual([{ status: "rejected" }]);
          harness.state.thread = { ...harness.state.thread, hasPendingUserInput: true };
          const restarted = yield* harness.create();
          yield* restarted.poll;
          expect(harness.state.commands).toHaveLength(1);
          harness.state.thread = { ...harness.state.thread, hasPendingUserInput: false };
          yield* restarted.poll;
          expect(harness.state.commands).toHaveLength(2);
          const accepted = harness.state.commands[1]!;
          expect(accepted.commandId).not.toBe(rejectedId);
          expect(accepted.deliveryPrecondition?.expectedThreadUpdatedAt).toBe(
            harness.state.thread.updatedAt,
          );
          yield* restarted.poll;
          expect(harness.state.commands).toHaveLength(2);
          expect(
            yield* sql`SELECT state, attempts, command_id FROM pull_request_feedback_deliveries`,
          ).toEqual([{ state: "delivered", attempts: 2, command_id: accepted.commandId }]);
        }),
      ),
  );

  it.effect("does not revive a retired rejected observation when the old signal reappears", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness(sql);
        harness.state.admissionRacesLeft = 1;
        const original = harness.state.detail;
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        yield* service.poll;
        harness.state.detail = { ...original, headSha: "head-2", checks: [] };
        yield* service.poll;
        harness.state.detail = original;
        yield* service.poll;
        yield* service.poll;
        expect(harness.state.commands).toHaveLength(1);
        expect(yield* sql`SELECT state FROM pull_request_feedback_deliveries`).toEqual([
          { state: "superseded" },
        ]);
      }),
    ),
  );

  it.effect("bounds repeated authoritative admission rejections to three attempts", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness(sql);
        harness.state.admissionRacesLeft = 10;
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        for (let index = 0; index < 5; index++) yield* service.poll;
        expect(harness.state.commands).toHaveLength(3);
        expect(new Set(harness.state.commands.map((command) => command.commandId)).size).toBe(3);
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.feedbackStatus).toBe(
          "exhausted",
        );
        expect(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE status = 'rejected'`,
        ).toEqual([{ count: 3 }]);
      }),
    ),
  );

  it.effect("skips removed threads and recovers a corrupt persisted snapshot", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = makeHarness();
        const service = yield* harness.create();
        yield* service.delivery({ threadIds: [threadId] });
        yield* sql`UPDATE pull_request_feedback_threads SET snapshot_json = '{invalid-json' WHERE thread_id = ${threadId}`;
        const result = yield* service.delivery({
          threadIds: [threadId, ThreadId.makeUnsafe("deleted")],
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.status).toBe("unknown");
        expect(result.items[0]?.enabled).toBe(false);
      }),
    ),
  );

  it.effect("does not dispatch deferred feedback after the user disables it", () =>
    database(
      Effect.gen(function* () {
        const harness = makeHarness();
        harness.state.thread = { ...harness.state.thread, hasPendingApprovals: true };
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        yield* service.poll;
        yield* service.setEnabled({ threadId, enabled: false });
        harness.state.thread = { ...harness.state.thread, hasPendingApprovals: false };
        yield* service.poll;
        expect(harness.state.commands).toHaveLength(0);
        expect((yield* service.delivery({ threadIds: [threadId] })).items[0]?.feedbackStatus).toBe(
          "disabled",
        );
      }),
    ),
  );

  it.effect("requires the matching clean checkout and activity cooldown", () =>
    database(
      Effect.gen(function* () {
        const harness = makeHarness();
        const service = yield* harness.create();
        yield* service.setEnabled({ threadId, enabled: true });
        harness.state.branch = "other-branch";
        yield* service.poll;
        expect(
          (yield* service.delivery({ threadIds: [threadId] })).items[0]?.deferredReason,
        ).toContain("PR branch");
        harness.state.branch = "feature";
        harness.state.localHead = "unpublished-head";
        yield* service.poll;
        expect(
          (yield* service.delivery({ threadIds: [threadId] })).items[0]?.deferredReason,
        ).toContain("differs");
        harness.state.localHead = "head-1";
        harness.state.dirty = " M src/index.ts\n";
        yield* service.poll;
        expect(
          (yield* service.delivery({ threadIds: [threadId] })).items[0]?.deferredReason,
        ).toContain("local changes");
        harness.state.dirty = "";
        harness.state.thread = {
          ...harness.state.thread,
          latestHumanMessageAt: new Date(harness.state.now).toISOString(),
        };
        yield* service.poll;
        expect(
          (yield* service.delivery({ threadIds: [threadId] })).items[0]?.deferredReason,
        ).toContain("cooldown");
        expect(harness.state.commands).toHaveLength(0);
        harness.state.now += 300_000;
        yield* service.poll;
        expect(harness.state.commands).toHaveLength(1);
      }),
    ),
  );
});
