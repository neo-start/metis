# Persistent native Codex host

For ordinary desktop-window independence, the macOS/Linux `npm run metis`
launcher now uses the [shared background runtime](workbench/background-runtime.md)
by default. That path retains Gateway and other Metis capabilities. The optional
native Codex host described below has a separate backend-restart boundary and
keeps its existing native-only restrictions.

Metis includes an independent local host for **native Codex app-server sessions on
macOS and Linux**. It owns the existing `CodexAppServerManager`, its stdio child,
request registry, active turn, approval and user-input responders. A controller
can disconnect or exit and attach again without initializing Codex again,
resuming its thread, or sending another prompt. Explicit termination verifies
provider-tree teardown before releasing host ownership.

The default application path keeps the backend-owned Codex lifecycle. Independent
hosting is an explicit option for the primary Codex provider. Native resume after
host loss is a separate recovery operation, not in-flight adoption.

## Enable in Metis

In **Settings → Providers → Codex**, turn on **Persistent native Codex host**.
The option applies to new or explicitly restarted sessions. The default is off;
secondary Codex instances and ACP providers keep their existing lifecycle.

This mode uses native Codex capabilities. Metis cross-thread tools, memory-context
injection, browser/device/computer tools and Gateway credentials are unavailable.
Disable computer control before enabling it; the backend also rejects conflicting
configuration. Native fork/review and child-thread interruption are not supported
in this mode. It currently supports macOS and Linux.

Metis adopts the authenticated host and its existing lifecycle generation before
startup recovery consumes commands. Retained events then pass through the normal
canonical event pipeline and are acknowledged only after durable processing.
Backend shutdown detaches, preserving the Codex process and pending approvals or
questions. Explicit session stop exits its provider; the last session stop also
retires the idle host. Interrupting a turn retains the session as usual.

A running or approval-blocked session must settle before switching host mode or
replacing its runtime. A ready session is retired before a replacement starts.
If a host is missing, incompatible or has uncertain ownership, its affected threads
are fenced with a recovery warning instead of receiving an automatic continuation
or a second provider process. Other providers can still start. Changing this
setting does not recover an already lost host.

## Using the backend API

The dedicated source entry is `apps/server/src/persistentProviderHostMain.ts`
(run with Bun). The server build also includes `persistentProviderHostMain.mjs`
(run with Node). Use the actual installed entry path; do not launch the normal
HTTP server as a provider host. One private directory identifies one host, which
can hold up to 32 native Codex sessions.

```ts
import {
  launchOrConnectCodexHost,
  projectPersistentHostEvents,
} from "./provider/persistentHost/client.ts";

const client = await launchOrConnectCodexHost({
  directory: absolutePrivateHostDirectory,
  executable: process.execPath, // Node for the built .mjs entry
  args: [absoluteBuiltHostEntry],
});
const snapshot = await client.snapshot();
// Rebind snapshot.sessions to existing durable thread/turn/lifecycle ownership
// BEFORE running orphan recovery or consuming events. Never send a continuation
// just because the previous controller disappeared.

// Only for a new native session, not for an adopted session:
await client.call(
  "startSession",
  [
    {
      threadId,
      cwd,
      runtimeMode: "approval-required",
      gatewayMode: "native-only",
      providerOptions: { codex: { binaryPath, homePath } },
    },
  ],
  durableStartOperationId,
);

await client.call("sendTurn", [{ threadId, input }], durableTurnOperationId);
await projectPersistentHostEvents(client, async ({ event }) => {
  // Commit all derived events idempotently under their stable event IDs.
  await persistProviderEvent(event);
});
await client.detach(); // Host, provider, pending requests and approvals survive.
```

The caller must deliberately select native-only operation. Omitting
`gatewayMode`, or passing gateway/computer-control fields, fails validation.
The host never serializes a backend-owned gateway lease or silently drops one.
Model selection, account home and execution/approval policy remain inputs to the
existing Codex manager. Adoption keeps the existing process environment and
policy; changed launch arguments do not replace a live process.

`snapshot()` reports authenticated host identity, actual provider PIDs, session
attempt UUIDs, lifecycle generation, active turns, routability and pending-human
state. `call()` supports session start/stop, send/steer/interrupt, approvals,
user-input answers, stalled-turn cleanup (`abandonTurn`), thread read/rollback and compaction. An existing session
must be explicitly stopped before replacement. A pending/active turn rejects a
second ordinary send; steering remains an explicit operation.

## Delivery and ownership rules

- `operationId` is a durable caller-owned idempotency key. Persist it before
  submitting a command. After any timeout/disconnect, use the **same ID and
  arguments** to retrieve the original pending or completed result. Different
  arguments under that ID are rejected. Do not retry a paid prompt with a new ID.
- Acceptance is written before provider dispatch. Results and errors stay in a
  bounded receipt ledger. `acknowledgeOperation(id)` removes result data but
  retains a tombstone, so a late retry cannot execute the command again.
- `events()` returns a bounded batch from the last acknowledged sequence.
  Reading events does not acknowledge them. `acknowledge(sequence)` commits a
  contiguous delivered prefix. A newly attached controller replays any
  unacknowledged entries with unchanged event/request IDs.
- `projectPersistentHostEvents` handles **one** bounded batch. Its callback must
  commit idempotently before resolving. Failure leaves the prefix unacknowledged;
  a commit followed by lost ACK can replay the same IDs. This is at-least-once
  delivery plus idempotent projection, not an exactly-once TCP guarantee.
- Only one authenticated socket holds the writer lease. A second live owner is
  rejected. Every attachment gets a fresh lease; stale commands are fenced.
  Adoption never takes ownership away from a still-connected controller.
- `detach()` and abrupt client disconnect preserve the host. `terminate()`
  settles/stops provider sessions, proves owned process-tree exit, then closes the
  host and removes its launch fence. `stopSession` and `stopAll` stop providers
  but leave the host available to retrieve events/receipts. Teardown failures
  retain ownership instead of claiming success.

## Bounds, privacy and failure behavior

The host binds an ephemeral port on `127.0.0.1`. A random 256-bit capability and
host-instance identity in owner-only files authenticate the connection; a PID
alone grants no authority. The directory must be mode `0700`, files `0600`, owned
by the current user and not symlinks. No secret travels in process arguments.
The wire version and manager ABI must match before attachment. Never print the
private descriptor/token or add the directory to source control.

The limits are 4 MiB per wire frame, 8 MiB queued socket output, 8 connections,
64 outstanding operations, 32 sessions, a 32 MiB durable event journal (1 MiB per
event), 16 MiB receipt data and 8,192 operation IDs. Journal exhaustion or a
receipt persistence failure exposes a host failure and stops the provider;
events are not silently evicted. A full operation-ID ledger rejects new commands;
explicitly terminate the idle host before creating a fresh one. Atomic rewrites
can temporarily require a second copy of the bounded file. Files contain private
conversation data and remain on disk after explicit termination for inspection.
A deliberate subsequent fresh launch in that directory starts new journal state.

Launch and host-process locks use exclusive file creation. An ambiguous, dead or
incompatible host fails closed. The launcher does not remove stale fences based
on a PID check and does not spawn a replacement provider. A host-process or OS
crash is outside the continuity guarantee: protocol promises cannot be restored
from the event journal. Verify process loss separately and use deliberate native
history recovery in a new private directory; never label it active-turn adoption.

## Gateway-enabled rollout prerequisites

Gateway-backed continuity still requires a durable, revocation-preserving
AgentGateway credential/turn-authority adoption path and a memory-context handoff.
The integrated native mode deliberately rejects those backend-owned capabilities.
It does not establish Gateway continuity or continuity after an OS/host crash.

## Verification and provenance

`apps/server/src/provider/persistentHost/persistentHost.test.ts` uses real local
host, backend-controller and fake stdio provider processes in temporary homes.
It covers pending-turn adoption with unchanged PIDs, one initialize/start/prompt,
retained approval/input responders, lost ACK replay, operation tombstones,
stale-owner rejection, privacy, overflow, ambiguous launches and explicit process
exit. It makes no real model calls and does not touch the user's running backend.

`persistentCodexIntegration.test.ts` additionally uses the real Codex adapter,
ProviderService and file-backed SQLite across three backend ManagedRuntime
instances. A fake stdio Codex process retains the same PID, session attempt and
active turn, receives one initialize/start/prompt, retains approvals and user-input
requests, deduplicates replayed delivery IDs, and exits on explicit stop. The
replacement case proves old provider/host exit before a fresh runtime opens;
dead-host recovery is isolated to its affected thread. Facade and startup recovery
tests cover event fan-out ACK, deferred replay and replacement guards.

No authenticated model call, running Metis service restart, production database
mutation, frontend test or browser validation was used. Source and bundled host
process tests do not establish packaged Windows or desktop installer support.

The implementation reuses Metis/Synara's Codex manager, JSONL framer/writer and
platform spawn/tree-teardown boundaries. AO's read-only `persistenthost` package
and research document at `e06b1a824e64ab882c041da4d58ec7c0c24cc188` informed the
ownership, receipt and ACK design; no Go code was copied. T3 provider lifecycles
were inspected at `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`; no compatible independent
host was found.
