import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudeOpenRouterEnvironment,
  hasClaudeOpenRouterCredentials,
  resolveClaudeOpenRouterApiKey,
} from "./claudeOpenRouter.ts";

const directories: string[] = [];
function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "metis-claude-openrouter-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude OpenRouter credentials", () => {
  it("uses Pi's saved key before its environment fallback without loading models or making requests", async () => {
    const dir = directory();
    const auth = JSON.stringify({ openrouter: { type: "api_key", key: "test-only-saved-key" } });
    writeFileSync(path.join(dir, "auth.json"), auth);
    // A model override must not affect credentials or route this provider elsewhere.
    writeFileSync(path.join(dir, "models.json"), "invalid model configuration");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-environment-key");
    const network = vi.fn(() => Promise.reject(new Error("Unexpected network request")));
    vi.stubGlobal("fetch", network);
    const create = vi.spyOn(ModelRuntime, "create");

    expect(await resolveClaudeOpenRouterApiKey(` ${dir} `)).toBe("test-only-saved-key");
    expect(create).toHaveBeenCalledWith({
      authPath: path.join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(network).not.toHaveBeenCalled();
    expect(readFileSync(path.join(dir, "auth.json"), "utf8")).toBe(auth);
  });

  it("supports the existing OpenRouter environment key and Pi's default agent directory", async () => {
    const dir = directory();
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-environment-key");
    const create = vi.spyOn(ModelRuntime, "create");

    expect(await resolveClaudeOpenRouterApiKey()).toBe("test-only-environment-key");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ authPath: path.join(dir, "auth.json") }),
    );
    expect(await hasClaudeOpenRouterCredentials(dir)).toBe(true);
  });

  it("reports absent credentials without catalog or model requests", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const network = vi.fn(() => Promise.reject(new Error("Unexpected network request")));
    vi.stubGlobal("fetch", network);
    expect(await hasClaudeOpenRouterCredentials(directory())).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it("expands configured Pi directories relative to the operator home", async () => {
    const dir = directory();
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "test-only-tilde-key" } }),
    );
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const configured = `~/${path.relative(homedir(), dir)}`;

    expect(await resolveClaudeOpenRouterApiKey(configured)).toBe("test-only-tilde-key");
  });
});

describe("Claude OpenRouter child environment", () => {
  it("isolates Claude routing, credentials and host control capabilities while retaining process basics", () => {
    const inherited: NodeJS.ProcessEnv = {
      HOME: "/operator",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ANTHROPIC_AUTH_TOKEN: "test-only-wrong-token",
      ANTHROPIC_API_KEY: "test-only-wrong-key",
      anthropic_base_url: "https://wrong.example",
      CLAUDE_CODE_OAUTH_TOKEN: "test-only-oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_EXTRA_BODY: '{"model":"wrong-model"}',
      CLAUDE_CODE_SUBAGENT_MODEL: "wrong-model",
      CLAUDE_CONFIG_DIR: "/operator/.claude",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "wrong-model",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: test-only-wrong-token",
      OPENROUTER_API_KEY: "test-only-source-key",
      AWS_PROFILE: "operator-profile",
      AWS_ACCESS_KEY_ID: "test-only-aws",
      GOOGLE_APPLICATION_CREDENTIALS: "/operator/google.json",
      OPENAI_API_KEY: "test-only-unrelated-key",
      API_TIMEOUT_MS: "1",
      SYNARA_AUTH_TOKEN: "test-only-control-key",
      NODE_OPTIONS: "--require=/tmp/operator.js",
      ENABLE_TOOL_SEARCH: "true",
    };
    const env = buildClaudeOpenRouterEnvironment({
      apiKey: "test-only-selected-key",
      configDir: "/isolated/claude",
      homeDir: "/isolated/home",
      env: inherited,
    });

    expect(env).toEqual({
      HOME: "/isolated/home",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ANTHROPIC_AUTH_TOKEN: "test-only-selected-key",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_MODEL: "z-ai/glm-5.3",
      ANTHROPIC_SMALL_FAST_MODEL: "z-ai/glm-5.3",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "z-ai/glm-5.3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "z-ai/glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "z-ai/glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "z-ai/glm-5.3",
      CLAUDE_CODE_SUBAGENT_MODEL: "z-ai/glm-5.3",
      CLAUDE_CONFIG_DIR: "/isolated/claude",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      ENABLE_TOOL_SEARCH: "false",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
    expect(inherited.ANTHROPIC_AUTH_TOKEN).toBe("test-only-wrong-token");
    expect(inherited.HOME).toBe("/operator");
  });
});
