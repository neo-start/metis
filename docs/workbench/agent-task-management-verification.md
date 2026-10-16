# Agent task management verification

Integration date: 2026-10-14. Tests use temporary homes, fake providers and local
fixtures. The user's running Metis service and production data were not restarted
or modified. Node 24.21.0 and the repository's Bun toolchain were used.

## Checks

- Workspace formatting, lint, typecheck and `build:desktop` passed. Lint reports
  730 existing warnings and zero errors.
- Windows process-boundary static check passed across 279 source files; this is
  not execution on Windows or validation of a packaged release.
- Launcher and explicit stop dry-runs passed without starting/stopping services.
- Full non-frontend workspace run: contracts 258 passed; shared 855 passed,
  1 skipped; scripts 279 passed; desktop 1,230 passed, 6 skipped; server 7,256
  passed, 21 skipped, 1 failed. The failing pre-existing model-cache test uses
  a zero-delay flush while expecting detached refresh completion. Its complete
  14-test file passed on isolated rerun without code changes. The full run is
  therefore recorded as having a timing-dependent failure, not an all-green run.
- Final full ProviderService and ProviderCommandReactor regression suites passed
  485 tests after adding exact-target cancellation at the provider boundary.
- Combined task-control, decider, external MCP and reactor regression passed
  624 tests; peer regression passed 14 tests with 1 optional mDNS case skipped.
- Existing stale development-home and migration-109 test expectations were
  updated; all 19 migration tests passed. No migration implementation changed.
  The lineage checker skipped because no release tag is reachable in this checkout.

## Reviewed boundaries

Scoped cancellations retain their requested run through serialized admission,
reactor delivery and the provider interruption fence. They cannot substitute a
newer live run, clear its chat-wide computer-control intent, or stop its startup.
Legacy desktop Stop retains its current-work semantics.

Answer-only external/peer commands cannot be converted into new turns when a
callback expires. Plan feedback keeps version/busy/mode checks while preserving
separate plan-implementation authorization. Peer approval controls match engine
admission, and uncertain/responding approvals show local recovery guidance.
Execution observation freshness is independent of HTTP receipt time. Old peers
retain cancellation while stale/unknown observations disable approval responses.

## Not exercised

Per repository instructions, no frontend tests, browser automation, screenshots
or visual QA were run. Real model calls, physical two-machine networking/mDNS,
Linux GUI behavior, packaged installers and Windows shared-background execution
remain unverified. Source-launcher persistence is not OS login/boot supervision.

Usage: [Agent task management](agent-task-management.md).
