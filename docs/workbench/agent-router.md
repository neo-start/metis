# Agent Router

Settings → Behavior → Follow-up behavior → **Auto** keeps ordinary conversation
outside the provider worker loop. It is the default for new settings; saved
Queue/Steer preferences remain intact. Enter and Send use Auto. Ctrl/Cmd+Enter
explicitly queues, and existing Queue/Steer controls retain their behavior.

## Admission and independent work

The owner websocket handler accepts eligible plain messages into a private durable
Router inbox, imports the user message, and returns `{sequence, routed: true}`.
This acknowledges storage, not task completion. The composer releases its send
state on this acknowledgement, without waiting for a provider turn to start.
Generation, worktree creation, and execution happen after acknowledgement.
Legacy receipts and ordinary execution retain the existing frontend lifecycle.

Router handles the first plain Auto message as well as follow-ups:

- Self-contained conversation is answered through isolated text generation without
  acquiring the worker's turn lock or starting a console provider turn.
- New work creates a standalone thread through the existing agent gateway creation
  coordinator. Each task has its own provider session, durable transcript, model,
  permissions, approvals, cancellation and recovery. It is linked with
  `creationSource: router` and `sourceThreadId`; it does not use the provider-native
  shared-runtime `parentThreadId` relation.
- Project workers receive separate managed Git worktrees, based on the selected
  source checkout and the coordinator's existing local-change copy policy. Worktree
  creation and compensation use its ownership proofs. Non-Git project isolation
  fails visibly instead of silently sharing the source directory. Chat-project
  workers receive separate working directories below the project's `work` directory.
  Directory isolation is not an OS sandbox for a full-access provider.
- Worker prompts include the original request plus a persisted, quoted source
  context: source conversation ID/title and up to twelve previous messages, each
  limited to 2,000 characters. The context cannot grant additional tool or approval
  authority. The original request is not truncated. Model, runtime mode, interaction
  mode and provider launch options are preserved, including runtime mode `auto`.
- A task link appears in the original conversation. Completion uses the existing
  gateway outbox and adds a passive result message and activity to that conversation;
  it does not start another console turn. Results remain in the worker transcript.

`新任务：…` or `new task: …` explicitly starts independent work without a classifier.
Untargeted plain requests longer than 16,000 characters also go directly to a worker. For
shorter unmarked requests, generation distinguishes conversation, status, task
correction and new work. A failed/unsupported/timed-out classifier reports that
nothing was handed to an executor; it does not guess that an ambiguous instruction
is permission to start new work. Explicit new-task and task-control commands remain
available without generation.

## Task progress and control

Whole-message status questions such as `现在做到哪了？` or `status` read durable state
for the console's associated tasks, including pending interactions, timestamps,
recent activity and output. Before a worker has started, the reply explicitly notes
that admitted messages may still be routing or creating a task. It never invents
progress percentages or treats silence as proof of a hang.

`任务 <task-id> 进度如何` and `任务 <task-id> 停止` target a particular associated task
without generation. A plain stop/pause request is accepted only when one running
task is unambiguous. With multiple running tasks, Router asks for a target. Stop
receipts say cancellation was requested, not that all tools have stopped. The
existing exact-turn cancellation fences reject replacement runs.

Unambiguous corrections select a task from the server-provided task list. Unknown
or unrelated IDs cannot become execution targets. `任务 <task-id> <correction>`
provides a deterministic target. Native Steer is bound to the observed turn and
validated both at admission and provider delivery. Unsupported steering queues the
correction on that worker. Completed tasks may receive explicit continuations.
The worker's saved model/settings are used; console provider launch overrides are
not applied to an existing worker. For approval/input responses, open the worker's
ordinary approval surface; Router cannot approve on the user's behalf.

## Ordering, persistence and recovery

Ordinary requests are classified concurrently so slow generation cannot hold later
chat replies. Task-changing effects retain a per-conversation arrival-order lane,
which ends at worker dispatch, never at worker completion. Status
and exact cancellation (including task-ID forms) bypass it. The composer remains
available after durable admission even while a previous classification or worktree
creation is pending. Router limits concurrent processing requests to 32; overload
is reported in the conversation rather than silently dropping accepted input.

Private `stateDir/router/inbox` files contain admitted commands until processing
settles; receipt files retain the fingerprint and acknowledged sequence. Reusing a
command ID with different content is rejected. Recovery scans unfinished inbox
records in receipt order. Router plans under `stateDir/router/receipts` freeze
classification, task target and quoted context before effects. Engine command
receipts and gateway operation IDs deduplicate dispatches and worker creation.
After successful processing, only receipt metadata remains in these files. Failed
plans may retain their saved input for recovery/diagnosis.

Gateway startup recovery preserves committed workers and conservatively compensates
unfinished creation operations. It never launches replacement workers or blindly
replays possibly completed external operations. Recovery retains the Router source
marker through caller-purge redaction. Existing provider recovery remains responsible
for running workers; Router does not promise that every provider resumes an
interrupted process. A failure after worker creation may only be a lost notification,
so the error message explicitly says the task may have been submitted.

The shared Router runtime owns an abort controller and scoped recovery loop. Shutdown
stops new admission and aborts host generation/dispatch/creation effects. Admitted
requests interrupted during shutdown remain available for restart recovery rather
than becoming false user-facing failures.

## Boundaries and supported paths

Attachments, skill/plugin mentions, review requests, plan implementation, async
input responses and computer-control requests retain the ordinary execution path.
The independent-worker path currently applies to eligible plain local web/desktop
Auto messages and authorized plain Feishu private-chat messages. Feishu slash
commands and attachments keep their existing handlers. Paired-device, automation
and agent-tool entrypoints retain their existing dispatch semantics. Explicit
Queue/Steer bypasses Auto. Simple greetings and status requests need no model call.

Feishu persists the original chat, sender, reply target and command before Router
admission. Its delivery loop sends Router acknowledgements and worker completion
messages without waiting for a provider turn. Recovery preserves the original
thread across controller resets and rechecks the sender allowlist. Confirmed sends
are deduplicated; a lost remote send acknowledgement may cause a duplicate reply.

Independent generation uses the conversation's provider/model, currently through
Codex (including secondary, tertiary and quaternary accounts), OpenCode, Cursor and Droid channels, with a 12-second budget including
startup. Unsupported providers never silently switch models. Generation runs in a
private empty directory. Codex copies only provider/auth configuration, disables
shell/apps/hooks/image viewing/web search and retains its read-only sandbox; ACP
permission requests are rejected and OpenCode retains its deny-all policy. These
are provider-specific controls, not claims of identical third-party enforcement.

Model output is schema checked and bounded. Quoted history and worker summaries are
untrusted data. A model may select only an allowed route and existing task ID; it
cannot invent commands, permissions, approval responses, models or cancellation.
Cancellation remains a narrow deterministic whole-message rule.

## Verification

`AgentRouter.test.ts` exercises the real in-memory orchestration engine with mocked
independent generation and worker creation, covering durable admission, immediate
ACK, first-task dispatch, concurrent status/chat, corrections, a second independent
task, scoped cancellation, restart replay, shutdown, failures and ID conflicts.
`agentGateway/Layers/AgentGateway.test.ts` exercises the real creation coordinator
with mocked Git/provider dependencies: distinct worktrees, settings and source
ownership, durable exact-request replay and conflicting settings.
`completionDelivery.test.ts` uses SQLite outbox persistence to verify passive Router
result delivery and replay after lost acknowledgement. Contract codec tests cover
`routed: true` and legacy receipts. Existing task-control/provider tests cover strict
turn fences and creation compensation.

The frontend browser harness uses isolated Chromium with a mocked websocket server
to cover first-message and busy-thread Auto, rapid sends, rejected/retried admission,
legacy ACK fallback, explicit Queue/Steer, and task-link navigation. These tests do
not establish live provider latency, live provider end-to-end execution, production
restart behavior or packaged platform behavior. No running user instance is changed
by this implementation or its verification.

Feishu bridge tests cover concurrent status during blocked classification, greetings,
redelivery after controller reset, durable transport retry and allowlist revocation.
