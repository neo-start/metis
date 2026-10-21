import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { ClaudeOpenRouterAdapter } from "../Services/ClaudeOpenRouterAdapter.ts";
import { makeClaudeAdapterLive, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";
import {
  configureClaudeOpenRouterQuery,
  makeClaudeOpenRouterAdapterLive,
} from "./ClaudeOpenRouterAdapter.ts";

const denyTool: NonNullable<Options["canUseTool"]> = async () => ({
  behavior: "deny",
  message: "Test approval boundary",
});

describe("configureClaudeOpenRouterQuery", () => {
  it("keeps native tools, MCP, approval hooks and streaming options intact", () => {
    const options: Options = {
      model: "z-ai/glm-5.3",
      permissionMode: "default",
      canUseTool: denyTool,
      hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
      mcpServers: { metis: { type: "http", url: "http://127.0.0.1:41199/mcp" } },
      includePartialMessages: true,
      forwardSubagentText: true,
      settingSources: ["user", "project"],
      additionalDirectories: ["/isolated/project"],
      settings: { effortLevel: "low", autoCompactEnabled: true },
      maxThinkingTokens: 1024,
    };
    const configured = configureClaudeOpenRouterQuery(options);
    assert.equal(configured.tools, undefined);
    assert.equal(configured.canUseTool, denyTool);
    assert.equal(configured.permissionMode, "default");
    assert.equal(configured.allowDangerouslySkipPermissions, undefined);
    assert.equal(configured.hooks, options.hooks);
    assert.equal(configured.mcpServers, options.mcpServers);
    assert.equal(configured.additionalDirectories, options.additionalDirectories);
    assert.equal(configured.includePartialMessages, true);
    assert.equal(configured.forwardSubagentText, true);
    assert.deepEqual(configured.settingSources, []);
    assert.deepEqual(configured.thinking, { type: "adaptive" });
    assert.equal(configured.maxThinkingTokens, undefined);
    assert.deepEqual(configured.settings, { effortLevel: "low", autoCompactEnabled: true });
    assert.deepEqual(options.settingSources, ["user", "project"]);
  });

  it("routes every built-in subagent model alias to the selected GLM model", () => {
    const selectedModel = "z-ai/glm-custom-test";
    const options: Options = {
      model: selectedModel,
      agents: {
        explore: {
          description: "Inspect files",
          prompt: "Read only",
          model: "haiku",
          tools: ["Read"],
        },
        build: { description: "Implement", prompt: "Build", model: "opus" },
      },
      env: {
        CLAUDE_CONFIG_DIR: "/isolated/claude",
        ANTHROPIC_MODEL: "z-ai/glm-5.3",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "z-ai/glm-5.3",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet",
        CLAUDE_CODE_SUBAGENT_MODEL: "z-ai/glm-5.3",
      },
    };
    const configured = configureClaudeOpenRouterQuery(options);
    assert.equal(configured.agents?.explore?.model, "inherit");
    assert.equal(configured.agents?.build?.model, "inherit");
    assert.deepEqual(configured.agents?.explore?.tools, ["Read"]);
    for (const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      assert.equal(configured.env?.[name], selectedModel);
    }
    assert.equal(configured.env?.CLAUDE_CONFIG_DIR, "/isolated/claude");
    assert.equal(options.agents?.explore?.model, "haiku");
  });

  it("defaults to high effort while retaining the spawn-only max override", () => {
    const defaultOptions = configureClaudeOpenRouterQuery({});
    assert.equal(defaultOptions.model, "z-ai/glm-5.3");
    assert.deepEqual(defaultOptions.settings, { effortLevel: "high", autoCompactEnabled: true });
    assert.equal(defaultOptions.effort, undefined);
    const maximum = configureClaudeOpenRouterQuery({ effort: "max" });
    assert.equal(maximum.effort, "max");
    assert.deepEqual(maximum.thinking, { type: "adaptive" });
  });
});

function makeQuery() {
  let closed = false;
  let finish: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  const flagChanges: Record<string, unknown>[] = [];
  const query: Awaited<ReturnType<NonNullable<ClaudeAdapterLiveOptions["createQuery"]>>> = {
    interrupt: async () => {},
    stopTask: async () => {},
    backgroundTasks: async () => true,
    setModel: async () => {},
    setPermissionMode: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async (settings) => {
      flagChanges.push(settings);
    },
    getContextUsage: async () => {
      throw new Error("No usage in test");
    },
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    close: () => {
      closed = true;
      finish?.({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]: () => ({
      next: () =>
        closed
          ? Promise.resolve({ done: true as const, value: undefined })
          : new Promise<IteratorResult<SDKMessage>>((resolve) => {
              finish = resolve;
            }),
    }),
  };
  return { query, flagChanges };
}

describe("ClaudeOpenRouterAdapter", () => {
  it("owns sessions independently of the ordinary Claude adapter", async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "metis-glm-isolation-"));
    const ordinary = makeQuery();
    const glm = makeQuery();
    const layer = Layer.mergeAll(
      makeClaudeAdapterLive({
        createQuery: () => ordinary.query,
        resolveEnvironment: async () => ({ CLAUDE_CONFIG_DIR: path.join(temp, "ordinary") }),
        readClaudeCliVersion: async () => "2.1.300",
      }),
      makeClaudeOpenRouterAdapterLive({
        createQuery: () => glm.query,
        resolveEnvironment: async () => ({ CLAUDE_CONFIG_DIR: path.join(temp, "glm") }),
        readClaudeCliVersion: async () => "2.1.300",
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(temp, temp)),
      Layer.provideMerge(NodeServices.layer),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const claude = yield* ClaudeAdapter;
          const openRouter = yield* ClaudeOpenRouterAdapter;
          const threadId = ThreadId.makeUnsafe("shared-id-isolation-test");
          yield* claude.startSession({
            threadId,
            provider: "claudeAgent",
            runtimeMode: "approval-required",
          });
          assert.equal(yield* openRouter.hasSession(threadId), false);
          yield* openRouter.startSession({
            threadId,
            provider: "claudeOpenRouter",
            runtimeMode: "approval-required",
          });
          assert.equal(yield* claude.hasSession(threadId), true);
          yield* openRouter.stopAll();
          assert.equal(yield* openRouter.hasSession(threadId), false);
          assert.equal(yield* claude.hasSession(threadId), true);
          yield* claude.stopAll();
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      ordinary.query.close();
      glm.query.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies the GLM high default on a later turn through the real Claude lifecycle", async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "metis-glm-adapter-"));
    const { query, flagChanges } = makeQuery();
    let configured: Options | undefined;
    const layer = makeClaudeOpenRouterAdapterLive({
      createQuery: (input) => {
        configured = input.options;
        return query;
      },
      resolveEnvironment: async () => ({ CLAUDE_CONFIG_DIR: path.join(temp, "claude") }),
      resolveConnectionOptions: async () => ({ binaryPath: "/test/claude" }),
      readClaudeCliVersion: async () => "2.1.300",
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(temp, temp)),
      Layer.provideMerge(NodeServices.layer),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* ClaudeOpenRouterAdapter;
          const threadId = ThreadId.makeUnsafe("glm-effort-lifecycle");
          const started = yield* adapter.startSession({
            threadId,
            provider: "claudeOpenRouter",
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "claudeOpenRouter",
              model: "z-ai/glm-5.3",
              options: { effort: "low" },
            },
            providerOptions: {
              claudeAgent: {
                enableArtifacts: true,
                maxThinkingTokens: 32,
                permissionMode: "bypassPermissions",
              },
            },
          });
          assert.equal(started.provider, "claudeOpenRouter");
          assert.equal(configured?.model, "z-ai/glm-5.3");
          assert.equal(configured?.pathToClaudeCodeExecutable, "/test/claude");
          assert.deepEqual(configured?.settings, { autoCompactEnabled: true, effortLevel: "low" });
          assert.deepEqual(configured?.settingSources, []);
          assert.equal(configured?.allowDangerouslySkipPermissions, undefined);
          assert.equal(configured?.maxThinkingTokens, undefined);
          assert.equal(configured?.env?.CLAUDE_CODE_ARTIFACT, undefined);
          assert.ok(configured?.canUseTool);
          assert.ok(configured?.hooks?.PreToolUse);
          assert.ok(configured?.hooks?.SessionStart);
          assert.equal(configured?.tools, undefined);
          yield* adapter.sendTurn({
            threadId,
            input: "Continue",
            attachments: [],
            modelSelection: { provider: "claudeOpenRouter", model: "z-ai/glm-5.3" },
          });
          assert.deepEqual(flagChanges, [{ effortLevel: "high" }]);
          yield* adapter.stopAll();
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      query.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
