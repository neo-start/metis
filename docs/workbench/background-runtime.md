# Metis background runtime

On macOS and Linux, `npm run metis` now starts or attaches to the authenticated
shared backend before opening the desktop. Closing the final desktop window or
quitting detaches Electron; provider jobs, Gateway tools, memory, terminals and
the backend's durable event consumers continue in the same workspace. No provider
setting changes and no native-only persistent Codex mode are involved.

```sh
npm run metis -- --dry-run
npm run metis
npm run metis -- --stop-background
```

The desktop's **File → Stop Background Service and Quit…** action asks before
stopping jobs and disconnecting all attached clients. Ordinary Quit leaves the
service running. The CLI stop is explicit and needs no further confirmation.
It authenticates over a private Unix socket and waits for owned child processes
to exit. It never sends signals to a PID read from a state file. Shutdown gives
the backend's existing finalizers 30 seconds; if a child remains alive, shutdown
reports failure and retains ownership for inspection/retry instead of killing
the root and claiming its provider descendants have been cleaned up.

The backend uses `.agent-workbench` by default, the existing session cookie and
one-time pairing flow, and loopback port 4785. Use `METIS_HOME` and `METIS_PORT`
for an explicitly isolated instance; the desktop and background launcher receive
the same home. `npm run metis:serve` remains a foreground shared service and
supports `-- --background` to detach it explicitly. A remote service can likewise
use `npm run metis:remote -- --background` with its existing HTTPS tunnel
configuration. Normal desktop launch attaches to an already running local or
remote shared service without reconfiguring it. Stop either service with the
same home and `npm run metis -- --stop-background`.

`metis-background.log` holds redacted service output inside the private home.
`metis-background.json` is a private local control capability, not a backend API
credential. The launcher reuses Synara's tokenized lifecycle lock for concurrent
startup and proven-dead owner recovery, separately from the database's unchanged
authoritative lock. An older desktop-owned backend must exit before the first
background launch. Unknown/live owners are never displaced. Old foreground
services without the new controller can still be attached; stop those using
Ctrl+C in their original terminal.

The desktop continues to serve the existing capability-authenticated browser and
computer host sockets. Both macOS and Linux shared attachments now select the
service's fixed computer endpoint, and shared attachment restores the same secure
browser session as desktop-owned startup. Native computer/browser tools need an
attached desktop and the existing OS permissions/display session. Detaching
revokes those native hosts safely; background work that needs them will receive
the existing unavailable-host behavior until a desktop reconnects. This does not
provide unattended native computer access after Electron exits.

This is a detached process lifecycle, not an OS boot/login service or a guarantee
of automatic recovery from a backend crash or machine reboot. Reopen Metis to
start it again after a clean stop or recoverable stale owner. Windows retains the
explicit desktop-owned lifecycle; private shared-service ACL support remains
unfinished. Packaged release startup is unchanged; the default described here
is the supported source launcher, `npm run metis`. Development modes (`--dev`,
`--web`) keep their existing lifecycle.

Verification uses isolated fake processes and temporary homes only: launcher
exit, attachment, simultaneous startup, stale lock recovery, graceful drain,
authentication rejection, private-file checks and bounded shutdown failure.
No live provider success, Linux GUI behavior, packaged release behavior or
browser visual verification is implied by these tests.
