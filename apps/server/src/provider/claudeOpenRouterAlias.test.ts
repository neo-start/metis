import assert from "node:assert/strict";

import {
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, it } from "vitest";

import { aliasClaudeAdapterAsOpenRouter } from "./claudeOpenRouterAlias.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "./Errors.ts";
import type { ClaudeAdapterShape } from "./Services/ClaudeAdapter.ts";

const threadId = ThreadId.makeUnsafe("glm-test-thread");
const nativeCursor = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  turnCount: 2,
  claudeCache: { status: "warm" },
};
const startInput: ProviderSessionStartInput = {
  threadId,
  provider: "claudeOpenRouter",
  runtimeMode: "full-access",
};

function makeBase(overrides: Partial<ClaudeAdapterShape> = {}): ClaudeAdapterShape {
  const unused = () => Effect.die("Unexpected adapter operation");
  const session: ProviderSession = {
    provider: "claudeAgent",
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    resumeCursor: nativeCursor,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
  return {
    provider: "claudeAgent",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: () => Effect.succeed(session),
    sendTurn: unused,
    steerTurn: unused,
    stopTask: unused,
    backgroundTask: unused,
    steerSubagent: unused,
    interruptTurn: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    stopSession: unused,
    listSessions: () => Effect.succeed([session]),
    hasSession: () => Effect.succeed(true),
    readThread: unused,
    rollbackThread: unused,
    stopAll: () => Effect.void,
    forkThread: unused,
    getClaudeCacheObservation: unused,
    startClaudeCompaction: unused,
    getComposerCapabilities: () =>
      Effect.succeed({
        provider: "claudeAgent",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: true,
      }),
    streamEvents: Stream.make({
      provider: "claudeAgent",
      type: "session.configured",
      payload: { resumeCursor: nativeCursor },
    } as unknown as ProviderRuntimeEvent),
    ...overrides,
  };
}

describe("claudeOpenRouterAlias", () => {
  it("isolates provider settings and returns the effective high default after a low turn", async () => {
    const calls: unknown[] = [];
    const base = makeBase({
      startSession: (input) => {
        calls.push(input);
        return makeBase().startSession(input);
      },
      sendTurn: (input) => {
        calls.push(input);
        return Effect.succeed({ threadId, turnId: "turn-1" as never });
      },
    });
    const adapter = aliasClaudeAdapterAsOpenRouter(base, async () => ({
      binaryPath: "/glm/claude",
    }));
    await Effect.runPromise(
      adapter.startSession({
        ...startInput,
        providerOptions: {
          claudeAgent: {
            binaryPath: "/primary/claude",
            enableArtifacts: true,
            maxThinkingTokens: 20,
          },
        },
        modelSelection: {
          provider: "claudeOpenRouter",
          model: "z-ai/glm-5.3",
          options: { effort: "low" },
        },
      }),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Continue",
        attachments: [],
        modelSelection: { provider: "claudeOpenRouter", model: "z-ai/glm-5.3" },
      }),
    );
    assert.equal(adapter.provider, "claudeOpenRouter");
    assert.deepEqual((calls[0] as ProviderSessionStartInput).providerOptions?.claudeAgent, {
      binaryPath: "/glm/claude",
    });
    assert.deepEqual((calls[0] as ProviderSessionStartInput).modelSelection, {
      provider: "claudeAgent",
      model: "z-ai/glm-5.3",
      options: { effort: "low" },
    });
    assert.deepEqual((calls[1] as ProviderSessionStartInput).modelSelection, {
      provider: "claudeAgent",
      model: "z-ai/glm-5.3",
      options: { effort: "high" },
    });
  });

  it("namespaces persisted and streamed cursors while dropping Claude cache observations", async () => {
    const adapter = aliasClaudeAdapterAsOpenRouter(makeBase(), async () => ({}));
    const started = await Effect.runPromise(adapter.startSession(startInput));
    const sessions = await Effect.runPromise(adapter.listSessions());
    const events = await Effect.runPromise(Stream.runCollect(adapter.streamEvents));
    const expectedCursor = {
      sessionId: nativeCursor.sessionId,
      turnCount: 2,
      provider: "claudeOpenRouter",
    };
    assert.equal(started.provider, "claudeOpenRouter");
    assert.deepEqual(started.resumeCursor, expectedCursor);
    assert.deepEqual(sessions[0]?.resumeCursor, expectedCursor);
    assert.equal(events[0]?.provider, "claudeOpenRouter");
    assert.deepEqual(events[0]?.payload, { resumeCursor: expectedCursor });
    assert.equal(nativeCursor.claudeCache.status, "warm");
  });

  it("keeps GLM token usage without publishing the SDK's unknown-price Claude fallback", async () => {
    const usage = { input_tokens: 125, output_tokens: 29, cache_read_input_tokens: 64 };
    const modelTokens = {
      inputTokens: 125,
      outputTokens: 29,
      cacheReadInputTokens: 64,
      cacheCreationInputTokens: 0,
      contextWindow: 1_048_576,
      costBasis: "unknown",
    };
    const event = {
      provider: "claudeAgent",
      type: "turn.completed",
      payload: {
        state: "completed",
        usage,
        modelUsage: { "z-ai/glm-5.3": { ...modelTokens, costUSD: 0.41 } },
        totalCostUsd: 0.41,
        cumulativeCostUsd: 0.82,
      },
    } as unknown as ProviderRuntimeEvent;
    const adapter = aliasClaudeAdapterAsOpenRouter(
      makeBase({ streamEvents: Stream.make(event) }),
      async () => ({}),
    );
    const events = await Effect.runPromise(Stream.runCollect(adapter.streamEvents));
    assert.deepEqual(events[0]?.payload, {
      state: "completed",
      usage,
      modelUsage: { "z-ai/glm-5.3": modelTokens },
    });
    assert.equal((event.payload as { totalCostUsd: number }).totalCostUsd, 0.41);
  });

  it("rejects foreign and untagged native cursors before touching the runtime", async () => {
    let starts = 0;
    const adapter = aliasClaudeAdapterAsOpenRouter(
      makeBase({
        startSession: (input) => {
          starts += 1;
          return makeBase().startSession(input);
        },
      }),
      async () => ({}),
    );
    for (const resumeCursor of [nativeCursor, { ...nativeCursor, provider: "claudeAgent" }]) {
      const result = await Effect.runPromise(
        adapter.startSession({ ...startInput, resumeCursor }).pipe(Effect.result),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(result.failure instanceof ProviderAdapterValidationError);
        assert.equal(result.failure.provider, "claudeOpenRouter");
        assert.match(result.failure.message, /different provider/u);
      }
    }
    assert.equal(starts, 0);
    await Effect.runPromise(
      adapter.startSession({
        ...startInput,
        resumeCursor: { ...nativeCursor, provider: "claudeOpenRouter" },
      }),
    );
    assert.equal(starts, 1);
  });

  it("preserves tagged failure classification with the GLM provider identity", async () => {
    const nativeError = new ProviderAdapterRequestError({
      provider: "claudeAgent",
      method: "turn/interrupt",
      detail: "Transport closed",
    });
    const adapter = aliasClaudeAdapterAsOpenRouter(
      makeBase({
        interruptTurn: () => Effect.fail(nativeError),
      }),
      async () => ({}),
    );
    const result = await Effect.runPromise(adapter.interruptTurn(threadId).pipe(Effect.result));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof ProviderAdapterRequestError);
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      assert.equal(result.failure.provider, "claudeOpenRouter");
      assert.match(result.failure.message, /claudeOpenRouter/u);
    }
    assert.equal(nativeError.provider, "claudeAgent");
  });

  it("does not expose native Claude imports, forks, paid cache maintenance or Auto mode", async () => {
    const adapter = aliasClaudeAdapterAsOpenRouter(makeBase(), async () => ({}));
    assert.equal(adapter.forkThread, undefined);
    assert.equal(adapter.getClaudeCacheObservation, undefined);
    assert.equal(adapter.startClaudeCompaction, undefined);
    const caps = await Effect.runPromise(adapter.getComposerCapabilities!());
    assert.equal(caps.provider, "claudeOpenRouter");
    assert.equal(caps.supportsThreadImport, false);
    const result = await Effect.runPromise(
      adapter.startSession({ ...startInput, runtimeMode: "auto" }).pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
  });

  it("returns the OpenRouter model catalog without invoking Claude discovery", async () => {
    const adapter = aliasClaudeAdapterAsOpenRouter(
      makeBase({
        listModels: () => Effect.die("Claude discovery must not run"),
      }),
      async () => ({}),
    );
    const result = await Effect.runPromise(adapter.listModels!({ provider: "claudeOpenRouter" }));
    assert.equal(result.source, "configured");
    assert.deepEqual(
      result.models.map((model) => model.slug),
      ["z-ai/glm-5.3"],
    );
    assert.equal(result.models[0]?.supportsAutoMode, false);
  });

  it("uses the configured binary for cold command discovery and keeps artifacts disabled", async () => {
    let forwarded: unknown;
    const adapter = aliasClaudeAdapterAsOpenRouter(
      makeBase({
        listCommands: (input) => {
          forwarded = input;
          return Effect.succeed({ commands: [], source: "sdk", cached: false });
        },
      }),
      async () => ({ binaryPath: "/custom/claude" }),
    );
    await Effect.runPromise(
      adapter.listCommands!({
        provider: "claudeOpenRouter",
        cwd: "/isolated/project",
        enableArtifacts: true,
      }),
    );
    assert.equal((forwarded as { binaryPath?: string }).binaryPath, "/custom/claude");
    assert.equal((forwarded as { enableArtifacts?: boolean }).enableArtifacts, false);
    assert.equal((forwarded as { provider: string }).provider, "claudeAgent");
  });
});
