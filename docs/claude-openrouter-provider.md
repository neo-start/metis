# GLM through Claude SDK and OpenRouter

`GLM (Claude SDK)` is an experimental, independent Metis provider with the internal identity
`claudeOpenRouter`. Select it in a new conversation to compare Claude Code's agent loop with
the existing Pi provider using the same OpenRouter model. Its default model is `z-ai/glm-5.3`,
with `high` reasoning effort; `low` and `max` are also available.

## Setup

Install the Claude Code executable and configure an OpenRouter credential through the existing
Pi setup. This provider reuses Pi's configured agent directory and credential resolution,
including its environment fallback. It does not require a Claude subscription or a separate
copy of the key in Metis settings. Settings → Providers → GLM (Claude SDK) accepts a custom
Claude executable path when `claude` is not available on PATH.

The health indicator checks the executable and credential availability. It does not make a
paid model request or verify the OpenRouter account balance. Changing Pi's agent directory
refreshes this provider's authentication status as well.

## Runtime behavior

Metis creates a separate instance of its existing Claude adapter, rather than copying its
agent loop. Claude SDK still owns native tools, permissions, streaming, cancellation and
multi-turn execution. Metis MCP tools and approval callbacks remain attached through the
existing gateway. Model inference uses OpenRouter's Anthropic-compatible Messages endpoint
at `https://openrouter.ai/api/v1/messages`.

Child-process credentials and model aliases are set in memory. The SDK uses an isolated
`providers/claude-openrouter` directory under the instance's state directory, excludes
inherited Claude settings and auto-memory, and routes built-in subagents to the selected
model. It does not borrow the normal Claude adapter's processes, transcript directory or
OAuth login. Resume cursors retain the independent provider identity.

`low` and `high` effort can change in a live session. Entering or leaving `max` restarts and
resumes the SDK session because that option is fixed at process creation. Thinking remains
enabled for GLM. Changing the model also restarts and resumes, so subagent aliases follow the
new model. Claude Auto mode, Artifacts, Claude account usage and native Claude transcript
import/fork are not exposed. Existing retained-message replay remains available to orchestration.
The SDK's token accounting is retained, but its fallback dollar estimates for an unrecognized
model are omitted; OpenRouter is authoritative for charges. Context limits reported here are
the Claude SDK runtime's limits, not a promise to expose the full upstream model window.

## Validation and boundaries

On 2026-10-21, a local probe with Claude Code 2.1.284 and Agent SDK 0.3.259 verified streamed
OpenRouter GLM 5.3 responses, a native Read tool call and a second conversation turn. A local
wire observer confirmed `thinking: {type: "adaptive"}` and `output_config.effort: "high"` in
the actual requests. A second probe through the real Metis adapter stopped its SDK process,
resumed the saved session, and verified recall of the previous turn and the independent
provider identity. Unit tests cover independent sessions, cursor rejection, settings,
approvals, subagent model inheritance, effort changes and health refresh. These checks are
not a comparative performance benchmark or a guarantee of support for every Claude feature.

The integration follows [OpenRouter's Agent SDK guide](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk)
and [Claude Code integration guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).
Anthropic does not guarantee its agent runtime's behavior with third-party models, so this
provider remains experimental.

Implementation reuse: the existing Synara-based `Layers/ClaudeAdapter.ts` and Metis's
`codexSecondaryAlias.ts` composition pattern at baseline `5e302f244` were reused. The read-only
T3 provider contract was inspected; no new upstream source was copied or dependency added.
