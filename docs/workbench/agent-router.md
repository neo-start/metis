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
- The original conversation acknowledges the user's request in natural language.
  Worker identity remains in structured receipts and task details. Completion uses
  the existing gateway outbox and adds a passive result message and activity to
  that conversation without starting another console turn. Router receives the exact
  run's final answer and generates the result report, preserving evidence and limitations.

The user-facing flow has two cases. Simple questions receive a complete Router answer
and create no worker or later completion report. Work requests receive one brief,
request-specific acknowledgement, followed by a substantive report after the worker
finishes. That report preserves the result, supporting details, verification and known
limitations, while respecting requests for a short answer. Both messages are generated;
"brief" describes the first reply's content, not a guaranteed low-latency response.

Every eligible plain Auto message passes through the isolated Router model before
publishing its conversational reply. Explicit `新任务：…`, quoted/task-ID follow-ups,
recognized progress/cancel commands and long inputs may have a server-selected action,
but Router still writes their acknowledgement from the request and validated facts.
Free-form messages use one classification call that also writes the reply. Neither
path substitutes a canned answer when generation fails. Permission, ownership and
turn checks remain server-owned. Rich/approval-bearing commands keep their typed
execution protocol; this does not grant the conversational model approval authority.

## Task progress and control

Whole-message status questions such as `现在做到哪了？`, `优化进展如何？`,
`当前任务进展怎么样？`, `查好了吗`, `当前任务完成了吗？` or `status` read durable state
for the console's associated tasks, including pending interactions, timestamps,
recent activity and output. Recognized status queries return a factual snapshot
as evidence for Router to write a contextual reply, even when another request
is still being classified. They no longer bypass model generation. Before a worker has started, the reply explicitly notes
that admitted messages may still be routing or creating a task. It never invents
progress percentages or treats silence as proof of a hang.

`任务 <task-id> 进度如何` and `任务 <task-id> 停止` target a particular associated task
with Router-generated wording. A plain stop/pause request is accepted only when one running
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

Whole-message instance queries such as `现在有进行中的 Metis 会话吗`,
`当前 Metis 有哪些运行中的任务？` and
`list active sessions` read the instance snapshot for an authorized Metis controller
conversation. They include running/starting sessions and pending approvals or input,
exclude deleted, archived and expired conversations, and show at most 20 entries
with the full count. Ordinary conversations receive an explicit scope limitation.
Compound queries containing additional actions continue through normal routing.

Assistant reply timestamps reflect response production, rather than copying the
user's timestamp. Saved plans preserve these timestamps across retries. Router logs
include command/thread IDs, total dispatch time, planning time, queue wait and
execution time; provider generation logs include elapsed time on success and failure.
These measure backend stages, not external transport delivery or frontend paint.

### End-to-end verification

Run `bun scripts/router-conversation-e2e.mjs` for isolated owner-RPC coverage of greeting,
status, global state, chat, stop and invalid-target replies. A deterministic provider
process writes unique text and records every invocation: all six requests must invoke
Router, and replay/restart must not regenerate or duplicate messages. This proves
process wiring and persistence, not model quality.

Run `ROUTER_E2E_CODEX_HOME=<selected-account-home> bun scripts/router-conversation-e2e.mjs
--live --model <selected-model>` for real model generation, independent worker execution
and generated completion delivery. It uses a fresh home, unused IPv4/IPv6 port and the
existing authenticated owner RPC; no production state or messaging transport is used.
Both modes save `results.json` and redacted logs in the printed temporary directory.
The old `router-status-e2e.mjs` and its 130–227ms evidence describe the retired
no-generation shortcut implementation and do not validate the current behavior.

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
Queue/Steer bypasses Auto. Greetings and status during pending classification/creation
also call the Router; independent generation does not wait on the worker's turn lock.

Feishu persists the original chat, sender, reply target and command before Router
admission. Its delivery loop sends Router acknowledgements and worker completion
messages without waiting for a console provider turn. Follow-up acknowledgements retain
the worker binding and deliver the result of the exact queued or steered input after
provider output settles. Results are frozen before transport retry; later worker
turns cannot replace them. Recovery preserves the original
thread across controller resets and rechecks the sender allowlist. Confirmed sends
are deduplicated; a lost remote send acknowledgement may cause a duplicate reply.

Native steering now persists the provider-acknowledged turn on the user message,
using the existing bind-turn command after successful delivery. It retains
`startsNewTurn: false`; the association is to the existing turn, not a new transcript
boundary. Without that association, a running correction could affect the result
while its Feishu reply remained pending forever. This fixes future accepted steers;
legacy unbound corrections are not inferred from the worker's latest turn.

Independent generation uses the conversation's provider/model, currently through
Codex (including secondary, tertiary and quaternary accounts), OpenCode, Cursor and Droid channels, with a 30-second budget including
startup. Codex routing uses low reasoning effort independently of worker settings;
this does not guarantee low latency. Unsupported providers never silently switch models. Generation runs in a
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

## Task association

Router snapshots earlier in-flight requests before classifying each message. The
classifier sees pending request IDs/text plus each worker's original and latest
user input. A clear supplement may select an exact pending request; it waits for
that predecessor to settle and resolves its durable worker binding. It never
creates a replacement worker when the predecessor has no confirmed worker.
Dependencies only point backwards, so chat replies remain concurrent.

Receipts retain worker ID and source conversation ID after text redaction. Feishu
records the original input and sent reply/chunk IDs. Quoting either resolves the
original Router request within the same chat and authorized sender; Router then
rechecks source conversation and worker ownership. This survives restart. Unknown,
legacy unbound, deleted, archived or cross-conversation targets produce clarification.
Explicit `新任务：` overrides a quoted context. Web clients cannot inject the
server-only transport binding. No web quotation UI is added.

When multiple tasks or pending requests exist, the classifier can select an exact
owned target using topic, task names and recent conversational focus. Candidate
count alone does not override that selection. Ambiguous supplements ask for
clarification; missing, invented and unowned targets cannot dispatch. Quoted
references retain their verified binding. Task associations inferred from text
remain model decisions, not a guarantee of semantic correctness. Pending requests
are recovered through the existing ordered durable inbox, not a second task store.

## Conversation ownership and presentation

Metis speaks as one assistant throughout the conversation. The same classification
call returns both the validated route and a concise acknowledgement for ordinary
new work and supplements. It describes the user's goal and next step in future
tense; it cannot claim execution, applied changes or successful verification.
The server persists that wording in the dispatch plan and publishes it only after
worker creation or correction admission succeeds. Explicit quoted/task-ID targets
remain server-selected; Router generates their wording without changing their target.
New-task commands and oversized requests also receive a generated acknowledgement.
All normal replies are finalized before the durable dispatch plan is saved. Publication
follows successful worker creation or correction/cancellation admission. Failure to
generate valid prose never silently becomes permission to execute a request.

Recognized status queries send authoritative, permission-filtered observations to
Router rather than sending a fixed status template to the user. Global observations
remain restricted to the authorized controller. Operational errors still report a
failed request; they are not a substitute conversational success response.

Initial Router results and Feishu follow-up results are presented by Router using
the exact bound turn. The complete final answer is supplied up to the presentation
context limit, with an explicit truncation flag; the 2,000-character tool summary does
not replace that evidence. Generation failure leaves result delivery pending for retry,
not a canned fallback. Successful prose is frozen before transport retry. Legacy
saved results/plans retain their original wording and fingerprints on replay.

Codex requests log preparation, environment setup, process spawn, process runtime,
total elapsed time and prompt character count without prompt text or credentials.
Process runtime includes CLI initialization, network/model waiting and generation;
it is not a measurement of model inference alone. This instrumentation is separate
from Router plan/queue/execution timings. Ordinary chat, new work, explicit follow-up
and final result delivery must be measured separately; do not extrapolate shortcut
status-query timings to all of them.

New Router receipts carry a presentation version and source-scoped worker/follow-up
binding, persisted before the conversational acknowledgement. Feishu reads those
receipts rather than parsing generated prose. Only legacy receipts without this
metadata use the old template parser, including earlier Router-prefixed messages.
Internal IDs and execution statuses are not ordinary conversation copy. Task details
and the existing approval surfaces remain available; presentation grants no new
execution or approval authority.

Focused backend tests cover generated acknowledgements after successful dispatch,
failed creation without false acceptance, binding visibility before publication,
explicit-target immutability, status fallbacks, full exact-run result delivery and
frozen retries, and both structured and legacy Feishu delivery. No live-model or
frontend verification is implied by these tests.
