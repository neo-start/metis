# Native Agent terminal

Open a task’s terminal drawer or terminal workspace and choose **Agent terminal**.
Enter an optional terminal name and the complete CLI command, then choose
**Launch in new terminal**. No CLI or model is preselected. The executable must
already be installed on the connected server; sign-in and configuration belong
to the CLI. A successful terminal write does not confirm that the CLI is installed,
authenticated, or ready; inspect the terminal output.

The new PTY uses the drawer’s task ID, working directory, and terminal environment.
The command is sent once, after the shell opens, as entered plus a carriage return.
It is not assembled from task text, paths, environment values, or model settings.
Use the connected shell’s quoting syntax for arguments and paths with spaces;
POSIX quoting is not substituted into PowerShell or cmd. Shell operators are
allowed only as part of the command the user explicitly enters. Multiline input,
terminal control characters, and commands over 8,000 characters are rejected.
The launch form does not persist commands, although terminal and shell history
can contain them.

## Reattach and stop

The dialog lists this task’s native Agent terminals from the existing terminal
layout store. **Reattach** selects the same terminal ID; it sends no command and
does not restart a live CLI. Ordinary terminal tabs remain available alongside
these terminals. A live PTY retains its original directory and environment on
reattach, even if task configuration has changed. Launch a new terminal when the
new directory/environment is required.

**Stop…** always asks for confirmation, then awaits the existing terminal close
API before removing the tab. It requests termination of that PTY and its process
tree; it does not send a guessed `exit` command to an arbitrary interactive CLI.
Errors stay visible. The underlying process-tree cleanup and escalation rules
are unchanged, and an accepted close request is not proof that every external or
daemonized process has exited. The stop action retains server-side terminal
history, though its tab is removed and this dialog has no stopped-session archive.
The ordinary terminal close controls retain their existing history-deletion
behavior. The CLI’s own saved sessions are not deleted by either action.

Hiding the drawer/dialog or switching tasks does not stop a native CLI. Renderer
reconnect uses the existing PTY reattachment path. Server shutdown ends that
runtime; after restart an ordinary shell may reopen with history, but the native
Agent command is never automatically replayed. Use an explicit CLI resume command
if the CLI supports saved sessions. If command delivery fails during disconnect,
inspect the reserved terminal before launching again: delivery can be ambiguous,
and the application deliberately does not retry it.

## Boundaries

- This is an interactive terminal, not a provider adapter. It creates no provider
  records, turns, model selections, structured approvals, usage data, or chat handoffs.
- Native terminals skip Metis’s managed CLI wrapper injection and terminal
  provider-identity/hook heuristics. Subprocess activity means only that a child
  process exists; terminal text is not evidence of agent state or approval requests.
- CLI permission prompts, credentials, configuration, and resume formats remain
  native to the selected CLI. The terminal runs with the existing connected-server
  terminal permissions, not the chat adapter’s approval workflow.
- Existing authenticated terminal APIs, directory validation, environment handling,
  platform shell selection, PTY adapters, history, and process teardown are reused.
  No new endpoint, wire schema, process-spawning path, or automatic command runner
  was introduced.
- IDs prefixed with `native-agent-` select this presentation behavior. The prefix
  is not an authorization boundary. Its two small web/server predicates are kept
  local to this feature; they must remain synchronized.

## Reuse and verification

The implementation extends Synara’s `ThreadTerminalDrawer.tsx`,
`terminalStateStore.ts`, `terminalRuntimeRegistry.ts`, `terminalIds.ts`, shared UI
`button`, `input`, and `dialog`, plus server `terminal/Layers/Manager.ts`.
The new dialog is feature-specific orchestration over those existing components;
there was no existing native CLI launcher to reuse.

Synara source baseline recorded in `upstream.json`:
`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`; this work started from Metis
`362f8b80063dc737ce9b163af287d4a977689e7d`.
T3 Code’s `apps/web/src/components/ThreadTerminalDrawer.tsx` at
`f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc` was inspected for terminal launch and
reattachment reuse. The `.upstream/t3code` checkout was absent, so the immutable
upstream file was read instead. Its environment-scoped launch model differs from
the current Synara baseline; no T3 code was copied. Existing licenses are unchanged.

Focused server tests cover exact command forwarding, empty initial/reopen writes,
live reattachment with directory/environment drift, task ownership, ignored
provider-looking output/hooks, wrapper exclusion, and scoped stop/history retention.
The existing Manager, NodePTY, and process-tree-killer suites pass (67 tests).
These use test PTYs/process doubles and do not establish live CLI or packaged
Windows behavior. No frontend tests, browser automation, screenshots, visual QA,
live services, or paid model calls were used. Workspace checks were run during integration.

Formatting and lint checks pass with existing repository warnings. The Windows
runtime boundary checker passes with the required Node 24 runtime. This is a
static check, not Windows runtime execution or packaged-release verification.
