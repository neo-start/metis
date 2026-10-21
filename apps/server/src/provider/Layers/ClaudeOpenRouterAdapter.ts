import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer } from "effect";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "../../config.ts";
import { loadClaudeAgentSdk } from "../claudeAgentSdk.ts";
import { aliasClaudeAdapterAsOpenRouter } from "../claudeOpenRouterAlias.ts";
import {
  buildClaudeOpenRouterEnvironment,
  resolveClaudeOpenRouterApiKey,
} from "../claudeOpenRouter.ts";
import { ClaudeOpenRouterAdapter } from "../Services/ClaudeOpenRouterAdapter.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";

/** Keep native SDK tools, approvals, streaming and gateway hooks; replace only inference settings. */
export function configureClaudeOpenRouterQuery(options: Options): Options {
  const model = options.model ?? "z-ai/glm-5.3";
  const settings = typeof options.settings === "object" ? options.settings : {};
  const { maxThinkingTokens: _legacyBudget, effort: _effort, ...rest } = options;
  return {
    ...rest,
    model,
    settingSources: [],
    thinking: { type: "adaptive" },
    // low/high remain live flag settings; only max is fixed when spawning.
    ...(options.effort === "max" ? { effort: "max" } : {}),
    settings: { autoCompactEnabled: true, effortLevel: "high", ...settings },
    ...(options.agents
      ? {
          agents: Object.fromEntries(
            Object.entries(options.agents).map(([name, agent]) => [
              name,
              { ...agent, model: "inherit" as const },
            ]),
          ),
        }
      : {}),
    env: {
      ...options.env,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    },
  };
}

export function makeClaudeOpenRouterAdapterLive(
  options: ClaudeAdapterLiveOptions & {
    readonly resolveConnectionOptions?: () => Promise<{ binaryPath?: string; agentDir?: string }>;
  } = {},
) {
  return Layer.effect(
    ClaudeOpenRouterAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const resolveConnectionOptions: NonNullable<typeof options.resolveConnectionOptions> =
        options.resolveConnectionOptions ?? (async () => ({}));
      const configDir = path.join(serverConfig.stateDir, "providers", "claude-openrouter");
      const base = yield* makeClaudeAdapter({
        ...options,
        gatewayProvider: "claudeOpenRouter",
        modelCapabilitiesProvider: "claudeOpenRouter",
        resolveEnvironment:
          options.resolveEnvironment ??
          (async () => {
            const connection = await resolveConnectionOptions();
            const apiKey = await resolveClaudeOpenRouterApiKey(connection.agentDir);
            if (!apiKey) throw new Error("OpenRouter credentials are missing.");
            await mkdir(configDir, { recursive: true, mode: 0o700 });
            return buildClaudeOpenRouterEnvironment({
              apiKey,
              configDir,
              homeDir: serverConfig.homeDir,
            });
          }),
        createQuery: async (input) => {
          const configured = { ...input, options: configureClaudeOpenRouterQuery(input.options) };
          if (options.createQuery) return options.createQuery(configured);
          return (await loadClaudeAgentSdk()).query(configured) as Awaited<
            ReturnType<NonNullable<ClaudeAdapterLiveOptions["createQuery"]>>
          >;
        },
      });
      return aliasClaudeAdapterAsOpenRouter(base, resolveConnectionOptions);
    }),
  );
}
