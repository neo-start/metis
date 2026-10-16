# Metis project update conversations

In **Settings → My devices**, enable **Automatically update this device** for a
paired machine and select the source machine's Metis repository root. Pairing
and collaboration must already be enabled. This setting is local and owner-only;
neither remote agents nor a pairing request can enable it.

The backend checks the source checkout about every 15 seconds while collaboration
is active. It requires a source-launchable Metis checkout, a named branch with a
network upstream, and HEAD equal to its upstream tracking commit. A successful
normal push updates that tracking ref. Unsaved edits and unpublished commits do
not trigger a notification; the monitor does not commit, push, fetch or modify the
source checkout. Enabling it also offers the current published commit.

Each published commit creates one dedicated remote controller conversation. The
message asks the receiving Metis to locate its own running checkout, match the
repository and branch, use fast-forward-only pull, verify the target commit,
build, and restart using its existing local launcher. Paths and Git credentials
are never forwarded. The receiving controller uses its own provider and approval
settings. Dirty checkouts, divergent branches and failed builds are reported in
the conversation instead of being overwritten. This is an agent request, not a
new privileged remote shell or a guarantee of unattended deployment.

The pending event is saved before sending. Stable open/send IDs reuse the paired
chat outbox and orchestration receipts across reconnects and backend restarts.
The next update waits while the previous conversation is queued, running, or
waiting for approval. Once it finishes, newer source commits are coalesced to the
current published HEAD. Pausing removes unsent update requests; it does not
cancel a turn already accepted by the remote machine. Revoking pairing removes
the rule and that peer's existing outbox.

The settings row links to the latest update conversation and displays its last
assistant response. “Conversation finished” means the remote turn ended; inspect
the response for the actual pull/build/restart result. Remote output never starts
a local agent turn. Restarting the receiver temporarily interrupts observation;
the sender retries reading the same conversation after reconnecting. Both source
and receiver need the existing remote controller chat protocol.

An interrupted turn remains waiting so a receiver restarting itself cannot admit
another update while recovering. Continue or resolve that remote conversation if
it does not resume automatically. Observation also continues after a terminal
turn, since a delayed restart continuation can change its status and result.

The remote chat layout uses the shared transcript/composer horizontal gutter and
a flex-sized route surface, with bottom space for the composer. No browser or
visual verification was performed. Per the user's instruction, tests were not
run for this change; static checks and a source build are the verification scope.
