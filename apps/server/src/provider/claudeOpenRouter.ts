import path from "node:path";

import { expandHomePath } from "@synara/shared/synaraHome";

import {
  buildProviderChildEnvironment,
  isProviderCredentialKey,
} from "../providerChildEnvironment.ts";

/** Reuse Pi's saved OpenRouter credential and environment fallback without catalog I/O. */
export async function resolveClaudeOpenRouterApiKey(
  agentDir?: string,
): Promise<string | undefined> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const resolvedAgentDir = path.resolve(expandHomePath(agentDir?.trim() || sdk.getAgentDir()));
  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(resolvedAgentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const apiKey = await new sdk.ModelRegistry(runtime).getApiKeyForProvider("openrouter");
  return apiKey?.trim() || undefined;
}

export async function hasClaudeOpenRouterCredentials(agentDir?: string): Promise<boolean> {
  return Boolean(await resolveClaudeOpenRouterApiKey(agentDir));
}

/** Keep the Claude SDK process independent of the operator's Claude login and routing settings. */
export function buildClaudeOpenRouterEnvironment(input: {
  readonly apiKey: string;
  readonly configDir: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = buildProviderChildEnvironment({
    provider: "claude",
    ...(input.env ? { baseEnv: input.env } : {}),
  });
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      isProviderCredentialKey(normalized) ||
      /(?:^|_)API_KEY$/u.test(normalized) ||
      /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|SYNARA_|AWS_|GOOGLE_|CLOUD_ML_)/u.test(normalized) ||
      normalized === "ENABLE_TOOL_SEARCH" ||
      normalized === "ENABLE_CLAUDEAI_MCP_SERVERS" ||
      normalized === "API_TIMEOUT_MS"
    ) {
      delete env[key];
    }
  }

  const model = "z-ai/glm-5.3";
  return {
    ...env,
    ...(input.homeDir ? { HOME: expandHomePath(input.homeDir) } : {}),
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CONFIG_DIR: expandHomePath(input.configDir),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    ENABLE_TOOL_SEARCH: "false",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}
