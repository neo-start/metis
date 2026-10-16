# Source attribution

Metis is a local development fork of [Synara](https://github.com/Emanuele-web04/synara), based on commit `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`. The root LICENSE retains upstream copyright notices and MIT terms. Upstream package names and protocol identifiers remain for compatibility.

The following modules are adapted directly from [T3 Code](https://github.com/pingdotgg/t3code), commit `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`:

| Local file                                        | Upstream source                                 | Adaptation                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/shared/src/workbenchThreadSort.ts        | packages/client-runtime/src/state/threadSort.ts | Extract timestamp and stable sorting functions; local structural sort-order type; omit unused pin/reorder functions; use non-mutating toSorted for local lint policy |
| apps/web/src/components/HighlightedSearchText.tsx | apps/web/src/components/ThreadSearchMatch.tsx   | Export existing highlighter; omit unused excerpt wrapper                                                                                                             |

`packages/shared/src/workbenchRemote.ts` reuses `packages/shared/src/relayUrl.ts` and the fragment-token setter from `packages/shared/src/remote.ts` at the same T3 commit; the pairing pathname is adapted to Synara `/pair`. `scripts/workbench-remote.ts` follows the connector invocation in T3 `apps/server/src/cloud/ManagedEndpointRuntime.ts` (token in environment, `cloudflared tunnel run`); it uses Synara process boundaries and intentionally does not include T3 provisioning or its supervisor service.

The standalone mobile proposal uses Tabler icons from the installed `@tabler/icons-react` package. The icon MIT license is retained at `docs/workbench/mobile-preview/TABLER-LICENSE`. No Termany source is included.

The Metis desktop shared-service attachment reuses the existing Synara Electron window/preload and `/pair` cookie bootstrap. `apps/desktop/src/metisSharedService.ts` adapts the private-file ownership/no-follow checks from Synara `apps/server/src/externalMcp/bridge.ts` at the commit above; Windows ACL handling is intentionally not duplicated and shared attachment fails closed on Windows. T3 `apps/desktop/src/backend/DesktopBackendPool.ts` and `DesktopBackendConfiguration.ts` were reviewed as references; their multi-process backend ownership and incompatible environment registry were not copied. This attachment adds only the missing Metis launcher-state glue, not a second authentication protocol.

`apps/web/src/pairingBootstrap.ts` adapts the manual token entry, auto-submit-then-strip ordering and per-failure messages of T3 `apps/web/src/components/auth/PairingRouteSurface.tsx` at the T3 commit above. It remains a plain-DOM page ahead of the Synara app bundle and calls the existing Synara `/api/auth/bootstrap`; T3's hosted pairing, environment registry and React surface were not copied.

The Workbench overview supplies the shared sorter with its latest execution/activity timestamp, and uses the original search highlighter for titles. Source checkouts under .upstream are references only and are not bundled.

## Agent Orchestrator design reference

The delivery summary, automatic PR/CI feedback and persistent provider host changes were informed by [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator), commit `e06b1a824e64ab882c041da4d58ec7c0c24cc188` (Apache-2.0). References: `backend/pkg/contract/kanban.go`, `backend/internal/lifecycle/reactions.go`, and `backend/internal/adapters/chatdriver/persistenthost`. No Go source was copied. The implementation extends the existing Synara Kanban components, GitHub/PullRequest services, orchestration receipts, `CodexAppServerManager`, event journal and shared process/JSONL boundaries. T3's provider lifecycle was reviewed at the commit above; its incompatible runtime was not transplanted. File-level provenance and adaptations are recorded in `docs/workbench/upstream.json`.

The instance controller (2026-10-14) reuses the existing Synara orchestration engine, command receipts and ChatView, plus this fork's Metis memory service. T3 `docs/internals/connection-runtime.md` and `packages/client-runtime/src/connection/registry.ts` at the T3 commit above informed the separation of instance identity and conversation lifetime; no T3 runtime code was copied. Paths and adaptations are recorded in `docs/workbench/upstream.json`.

The controller `/clear` fix reuses Synara's `apps/web/src/components/ChatView.tsx` clear-command entrypoint (reviewed at `ec3b1f6ef`) and this fork's persisted controller and navigation hook. T3's `ChatView.tsx` fresh-thread handler at the T3 commit above was also reviewed; no T3 code was copied. Only controller conversations rotate the persistent identity binding; ordinary clear behavior is retained.

## T3 Code license

The Agent task management additions reuse Synara's existing Activity rows,
terminal drawer/PTY manager, orchestration command receipts, pending interaction
rules, private-file checks and lifecycle locks. Local adaptation started at
`362f8b80063dc737ce9b163af287d4a977689e7d`. T3's `Sidebar.tsx`, `Sidebar.logic.ts`,
`ThreadTerminalDrawer.tsx`, terminal `Manager.ts` and `ManagedEndpointRuntime.ts`
were inspected at `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`; the actionable and
failed-state priority design is adapted to Synara's session and settlement model.
No T3 runtime/event store or Herdr source was transplanted. Source paths, targets
and adaptations are recorded in `docs/workbench/upstream.json`. Existing license
notices remain in force.

Peer task machine labels additionally reference T3 `apps/web/src/components/Sidebar.tsx`
at `6002c5c68c637de2cd2557bd6c40e46c153e39b1`; no code was copied from that revision.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
