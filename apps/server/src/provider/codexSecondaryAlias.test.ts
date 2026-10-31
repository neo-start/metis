import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import type { ProviderRuntimeEvent, ProviderSession } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, it } from "vitest";

import { aliasCodexAdapterAsAccount, resolveCodexAccountOptions } from "./codexSecondaryAlias.ts";
import type { CodexAdapterShape } from "./Services/CodexAdapter.ts";

const session = (provider: string) =>
  ({
    provider,
    status: "ready",
    runtimeMode: "full-access",
    threadId: "thread-1",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  }) as unknown as ProviderSession;

function makeBase(calls: unknown[]): CodexAdapterShape {
  const unused = () => Effect.die("unused");
  return {
    provider: "codex",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) => {
      calls.push(input);
      return Effect.succeed(session("codex"));
    },
    sendTurn: unused,
    interruptTurn: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    stopSession: unused,
    listSessions: () => Effect.succeed([session("codex")]),
    hasSession: () => Effect.succeed(true),
    readThread: unused,
    rollbackThread: unused,
    stopAll: () => Effect.void,
    streamEvents: Stream.make({ provider: "codex", type: "turn.started" } as ProviderRuntimeEvent),
    listModels: (input) => {
      calls.push(input);
      return Effect.succeed({ models: [], source: "codex-app-server", cached: false });
    },
  } as CodexAdapterShape;
}

describe.each([
  ["codexSecondary", ".codex-secondary"],
  ["codexTertiary", ".codex-tertiary"],
  ["codexQuaternary", ".codex-quaternary"],
] as const)("Codex account alias %s", (provider, defaultHome) => {
  const aliasCodexAdapterAsSecondary = (
    base: CodexAdapterShape,
    options: () => Promise<{ homePath?: string }>,
  ) => aliasCodexAdapterAsAccount(base, options, provider);
  const resolveCodexSecondaryAccountOptions = (options?: {
    homePath?: string;
    binaryPath?: string;
  }) => resolveCodexAccountOptions(options, provider);
  it("never lets the independent account fall back to ~/.codex", () => {
    assert.deepEqual(resolveCodexSecondaryAccountOptions(undefined), {
      homePath: path.join(homedir(), defaultHome),
    });
    assert.deepEqual(resolveCodexSecondaryAccountOptions({ homePath: "  " }), {
      homePath: path.join(homedir(), defaultHome),
    });
    assert.deepEqual(
      resolveCodexSecondaryAccountOptions({ binaryPath: "/bin/codex", homePath: "/h/two" }),
      { binaryPath: "/bin/codex", homePath: "/h/two" },
    );
  });

  it("translates inputs to the Codex shape with the account's own home", async () => {
    const calls: unknown[] = [];
    const adapter = aliasCodexAdapterAsSecondary(makeBase(calls), async () => ({
      homePath: "/settings/home",
    }));

    const started = await Effect.runPromise(
      adapter.startSession({
        threadId: "thread-1" as never,
        provider: provider,
        modelSelection: { provider: provider, model: "gpt-6-astra" },
        providerOptions: {
          codex: { homePath: "/primary/home" },
          [provider]: { homePath: "/secondary/home" },
        },
        runtimeMode: "full-access",
      }),
    );

    assert.equal(adapter.provider, provider);
    assert.equal(started.provider, provider);
    const forwarded = calls[0] as Record<string, any>;
    assert.equal(forwarded.provider, "codex");
    assert.equal(forwarded.modelSelection.provider, "codex");
    assert.deepEqual(forwarded.providerOptions.codex, { homePath: "/secondary/home" });
  });

  it("falls back to the settings account, not the primary Codex options", async () => {
    const calls: unknown[] = [];
    const adapter = aliasCodexAdapterAsSecondary(makeBase(calls), async () => ({
      homePath: "/settings/home",
    }));

    await Effect.runPromise(
      adapter.startSession({
        threadId: "thread-1" as never,
        providerOptions: { codex: { homePath: "/primary/home" } },
        runtimeMode: "full-access",
      }),
    );
    await Effect.runPromise(adapter.listModels!({ provider: provider } as never));

    for (const call of calls as Array<Record<string, any>>) {
      assert.deepEqual(call.providerOptions.codex, { homePath: "/settings/home" });
    }
    assert.equal((calls[1] as Record<string, unknown>).provider, "codex");
  });

  it("relabels sessions and runtime events", async () => {
    const adapter = aliasCodexAdapterAsSecondary(makeBase([]), async () => ({}));
    const sessions = await Effect.runPromise(adapter.listSessions());
    const events = await Effect.runPromise(Stream.runCollect(adapter.streamEvents));
    assert.deepEqual(
      sessions.map((entry) => entry.provider),
      [provider],
    );
    assert.deepEqual(
      Array.from(events).map((event) => event.provider),
      [provider],
    );
    assert.equal(adapter.steerTurn, undefined);
  });
});
