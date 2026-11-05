# Agent Router

Metis can handle plain follow-up messages outside the active provider turn. In
Settings → Behavior → Follow-up behavior, **Auto** enables this routing. It is the
default for new settings; previously saved Queue/Steer preferences are preserved.
Enter and the send button use Auto; Ctrl/Cmd+Enter explicitly queues a message.
Existing Queue and Steer controls retain their behavior.

## Runtime

The websocket command handler invokes `router/AgentRouter.ts` before provider
orchestration. It does not acquire a provider turn lock or wait for the current
agent loop. The original worker and its durable event stream continue unchanged.

- Whole-message progress questions (for example `现在做到哪了？` or `status`) read
  durable thread state without a model call. The response includes the recorded
  update time, pending-interaction state and recent worker output, not invented
  progress percentages or a claim that missing output proves a hang.
- Simple independent questions use the existing isolated text-generation channel
  with the conversation's model. Replies are imported into the same transcript
  without starting a turn or changing the running turn's identity.
- Unambiguous task corrections use native Steer, bound to the observed turn ID.
  Both command admission and provider delivery check that identity. Providers
  without native steering queue the correction rather than interrupting work.
- Exact stop/pause requests target only the observed active turn. A receipt says
  the stop was requested, not that a tool has already stopped. Existing strict
  task-control cancellation fences protect replacement runs.
- New work, ambiguous/mixed requests, questions requiring investigation and
  unsupported/failed/timed-out generation go to the existing durable task queue.
  This version does not automatically spawn another worker or worktree.

The generation budget is 12 seconds, including provider startup. Router generation
currently uses the existing Codex, OpenCode, Cursor and Droid channels. Unsupported
providers do not silently switch to another provider/model. Status and exact stop
requests remain available without generation. A cold provider may exceed the
budget and cause an explicit queue fallback.

Attachments, skill/plugin mentions, review requests, plan implementation, async
input responses and computer-control requests use the ordinary execution path.
Router is enabled for local web/desktop composer follow-ups; paired-device,
Feishu, automation and agent-tool entrypoints retain their existing dispatch
semantics. A client deliberately selecting Queue/Steer bypasses Auto.

## Ordering, retries and boundaries

Non-status requests are serialized per thread independently of the provider.
Progress and exact stop requests bypass this lane. The server bounds concurrent
Router requests to 32. Generation is separate from the worker, but a single chat
composer still waits for its current send to be acknowledged; this is not an
unrestricted parallel conversation UI.

Before dispatch, Router atomically saves the exact planned commands under private
`stateDir/router/receipts/<hash-of-command-id>.json`. Retries replay that plan using
the existing orchestration command receipts. A reused command ID with different
content is rejected. After successful delivery, the file retains only the input
fingerprint and result sequence, not chat text. An unacknowledged interrupted
request may retain its plan until retried; it is never automatically executed on
restart. The client must retry with the same command ID to recover that receipt.
A fresh manual send with a different ID is a new request.

Generation uses a private empty directory instead of the project checkout. Codex
copies only provider/auth configuration to its ephemeral home and disables shell,
apps, hooks, image viewing and web search; it retains a read-only sandbox. ACP
permission requests are rejected; OpenCode uses its existing deny-all permission
policy. These controls reuse each provider's existing execution boundary and do
not imply that every third-party provider enforces identical tool isolation.
Configuration keys follow the [official Codex reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Router outputs are schema-checked and bounded. Historical messages and activities
are supplied as quoted data; they cannot grant tool or approval authority. The
model only chooses reply/status/steer/queue; it cannot supply arbitrary commands,
change permissions, approve a pending action, choose another thread, or cancel a
run. Cancellation is a narrow whole-message rule with exact run validation.

## Verification

`apps/server/src/router/AgentRouter.test.ts` runs against the real in-memory
orchestration engine and command receipts with mocked independent generation. It
covers parallel status/stop handling, unchanged worker identity, retries after
partial delivery and restart, command-ID conflicts, stale corrections and
cancellation, fallback and server-only field stripping. Router configuration tests
cover credential-routing preservation and removal of tools/hooks/instructions.
No live provider latency or frontend/browser behavior is implied by these tests.
