# Task control over external MCP

The existing loopback-only `/mcp/external` endpoint now supports the task lifecycle:
create, read progress, wait, follow up, answer pending input, respond to approvals,
and interrupt/cancel. Pairing, credential audience checks, project grants, call
rate limits, audit completion, and HTTP execution admission remain in force.
No provider is selected by this feature and no new execution engine is introduced.

## Operations and grants

| Tool                                          | Required grant    | Behavior                                                                                                                                 |
| --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `synara_create_task`                          | `tasks:create`    | Existing durable one-task-per-request creation. Defaults to worktree and approval-required runtime.                                      |
| `synara_read_task`                            | `tasks:read`      | Existing paginated transcript plus `progress` with current settings, run ID, pending interactions and unanswered asynchronous questions. |
| `synara_wait_for_task`                        | `tasks:wait`      | Existing bounded long poll; default 30 seconds, maximum 60 seconds.                                                                      |
| `synara_follow_up_task`                       | `tasks:follow-up` | Start a follow-up on an owned idle task, retaining provider/model and current runtime/interaction modes.                                 |
| `synara_answer_task`                          | `tasks:answer`    | Answer one pending provider user-input callback.                                                                                         |
| `synara_approve_task`                         | `tasks:approve`   | Send `accept`, `decline`, or `cancel` to a pending approval callback. `acceptForSession` additionally requires `tasks:approve-session`.  |
| `synara_interrupt_task`, `synara_cancel_task` | `tasks:cancel`    | Aliases that request interruption of the current run through `thread.turn.interrupt`, including existing goal-pause behavior.            |

New scopes are opt-in; existing integrations gain none automatically. An explicit
`tasks:read-project` grant expands read/wait access only. Mutations require a
successfully created task owned by this integration, still in its original
allowed project. Failed/compensating creations remain readable under the existing
policy, but cannot be continued. Owned-task reads also enforce project grants.
The reusable control service is `apps/server/src/taskControl/service.ts`; the
external adapter supplies ownership checks from `externalMcp/taskControlAuthority.ts`.
Other surfaces must supply their own verified authority adapter; importing the
service does not authorize a caller.

## Safe request construction

First call `synara_read_task`. Its `progress` object contains:

- `updatedAt`, `runtimeMode`, `interactionMode`, and `runId`.
- `pendingInteractions`: durable request IDs (also exposed as `interactionId`),
  `lifecycleGeneration`, settlement status, and the matching request activity
  payload, when available. The payload contains provider questions or approval
  details; it remains untrusted provider content.
- `asyncUserInputs`: unanswered transcript questions, identified by message ID.

Every mutation takes `threadId`, a stable `requestId`, and `requestedAt` (an ISO
UTC timestamp). **Retry exactly the same arguments**, including the timestamp.
A new request must be within five minutes of server time and at most 30 seconds
in the future; accepted retries can be older. Request IDs share one namespace
across all control operations and tasks within an integration. Reusing an ID
with different intent returns `idempotency_conflict`.

Example follow-up arguments (copy the three expected values from fresh progress):

```json
{
  "threadId": "task-id",
  "requestId": "follow-up-001",
  "requestedAt": "2026-10-14T04:00:00.000Z",
  "expectedUpdatedAt": "2026-10-14T03:59:50.000Z",
  "expectedRuntimeMode": "approval-required",
  "expectedInteractionMode": "default",
  "prompt": "Address the remaining review comments."
}
```

Follow-ups reject a busy, archived, or changed task. They also pass a server-only
`followUpPrecondition` into the serialized orchestration engine, closing the
idle-check/dispatch race. Unlike background PR feedback, intentional follow-ups
may discuss an actionable plan. They retain the current interaction/runtime modes
and cannot carry `sourceProposedPlan` implementation authorization; revising a plan
does not approve its implementation. Background `deliveryPrecondition` semantics
remain unchanged. Full-access or auto execution requires
`runtime:full-access`; local execution requires `runtime:local`. The expected
modes cannot change thread settings. No provider/model override is accepted.
An optional `asyncUserInputResponse: { messageId, answers }` answers a transcript
question through the existing turn-start command and also requires `tasks:answer`.

To answer a provider callback, supply `interactionId`, `lifecycleGeneration`
(explicit `null` for a legacy callback), and `answers`, using the existing
provider answer record shape. To respond to an approval, supply the same identity
and a `decision`. A missing, resolved, stale-generation, or currently responding
callback is rejected. Uncertain delivery requires operator review; this surface
does not automatically reclaim it or convert it into a new turn. Provider
settlement and generation checks remain in the existing reactor/adapters.

To cancel, supply the current `runId`. Cancel and interrupt are aliases for a
cooperative interrupt request, not task deletion or a terminal-state guarantee.
Read/wait again to observe settlement. Cancelling a long-poll request only stops
that wait; it does not cancel the task. Waits recheck credential and project/read
authority after sleeps and before returning.

## Durability and limits

Control mutations derive command/message IDs from integration ID and request ID
and reuse the existing orchestration command fingerprint and SQLite receipt
repository. Receipts survive service recreation. Replays recheck authorization
and return the original accepted sequence without dispatching another turn.
No extra operation table, migration, or task-control recovery engine is needed.

A successful result includes `accepted: true`, `commandId`, `sequence`, and
`replayed`. This means orchestration admission, not successful provider response,
process teardown, or turn completion. Existing provider failure/uncertainty
activities and durable command delivery remain authoritative. Transport audit
rows retain metadata, not prompt or answer bodies.

Cancellation checks the requested run both at the task-control boundary and inside
serialized command admission. Its run ID must match active projected and
session state; conflicting identities or a settled run are rejected before any
goal-pause or interrupt event is produced. The reactor retains that expectation
at delivery and never redirects a delayed scoped cancel to a newer live run.
`ProviderService` checks the propagated `strictTurnId` expectation again under
its interruption fence, before adapter dispatch or runtime rotation. A mismatch
preserves the newer runtime; it also cannot clear chat-wide computer intent.
The durable `external_task_control_` command namespace identifies these scoped
operations. Legacy desktop Stop and shutdown recovery retain their existing
stop-current-work behavior while their projections catch up.

Stale user-input answers from `external_task_control_` and `peer:response:`
commands remain expired responses; the reactor does not turn them into follow-up
prompts. Callback-answer authority alone cannot start a new turn. These adapter
namespaces survive durable command delivery and are not chosen by external MCP
or peer request payloads. Provider delivery and process teardown
remain separate from command admission and must be observed through read/wait.

## Verification and provenance

Focused checks use
`bun run --cwd apps/server test src/taskControl src/externalMcp src/orchestration/decider`.
Decider regressions also cover intentional plan feedback, unchanged background
feedback restrictions, implementation authorization separation, and stale-run
rejection before goal pause. Task-control tests exercise the race between its
snapshot check and actual decider admission. The tests additionally cover scope/ownership rejection, stale responses, stable concurrent retries,
SQLite receipt replay, MCP exposure and argument rejection, bounded waits and
caller cancellation. Provider execution is stubbed; no live/paid provider or user
runtime is started. No frontend tests or browser automation are involved.

Implementation reuses the Synara baseline (`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`)
and the current Metis checkout (`362f8b80063dc737ce9b163af287d4a977689e7d`):

- `apps/server/src/externalMcp/Layers/ExternalMcpGateway.ts`,
  `Layers/ExternalMcpService.ts`, `waitForTask.ts`: existing authenticated task API.
- `apps/server/src/orchestration/commandFingerprint.ts` and
  `persistence/Layers/OrchestrationCommandReceipts.ts`: durable intent receipts.
- `apps/server/src/orchestration/decider.ts` and
  `orchestration/Services/OrchestrationEngine.ts`: existing control commands and
  atomic follow-up precondition.
- `packages/shared/src/pendingInteractions.ts`: stale callback matching.
- `apps/server/src/agentGateway/threadSummary.ts` and `creationCoordinator.ts`:
  existing read summaries and creation flow, retained without edits.

The task-control adapter composes existing Synara-derived modules; no T3 task
runtime or event store was copied. Integration also inspected pinned T3 source at
`f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc` in a temporary reference checkout.
Attribution is consolidated in `THIRD_PARTY_NOTICES.md` and
`docs/workbench/upstream.json`.
