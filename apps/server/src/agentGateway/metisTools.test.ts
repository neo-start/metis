import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MetisController } from "../metis/MetisController.ts";
import { makeMetisMemoryShape } from "../metisMemory/Layers/MetisMemory.ts";
import { makeMetisTools } from "./metisTools.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metis-self-tools-"));
  roots.push(root);
  const memory = makeMetisMemoryShape({
    rootDir: path.join(root, "memory"),
    readModel: () => null,
  });
  await Effect.runPromise(memory.writeSoul("Original soul"));
  const controller = new MetisController(path.join(root, "metis"), {
    initializeSoul: async () => {},
    resolveThread: async () => "controller",
    createThread: async () => "controller",
    sources: async () => [],
    isIdle: async () => true,
    dispatchReflection: async () => {},
    reflectionState: async () => "settled",
    isReflectionTurn: async () => false,
  });
  await controller.initialize();
  const tool = makeMetisTools(controller, memory)[0]!;
  const context: ToolContext = {
    principal: {
      kind: "provider-session",
      sessionKey: "session",
      threadId: "controller",
      provider: "codex",
      turnId: "turn",
    },
    callerThreadId: "controller",
    callerThreadLabel: null,
    callerSessionKey: "session",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
  const call = (args: Record<string, unknown>, override: Partial<ToolContext> = {}) =>
    Effect.runPromise(tool.handler(args, { ...context, ...override }));
  return { memory, call, revision: createHash("sha256").update("Original soul").digest("hex") };
}

it("limits cross-project memory and soul evolution to the designated controller", async () => {
  const f = await fixture();
  expect((await f.call({ action: "overview" }, { callerThreadId: "worker" })).isError).not.toBe(
    true,
  );
  expect((await f.call({ action: "memories" }, { callerThreadId: "worker" })).isError).toBe(true);
  expect(
    (
      await f.call(
        {
          action: "evolve_soul",
          content: "Changed",
          expectedRevision: f.revision,
          reason: "Owner feedback",
        },
        { callerThreadId: "worker" },
      )
    ).isError,
  ).toBe(true);
  expect((await Effect.runPromise(f.memory.readSoul())).content).toBe("Original soul");
});

it("requires active write authority and rejects secrets and stale revisions", async () => {
  const f = await fixture();
  const input = {
    action: "evolve_soul",
    content: "Be concise",
    expectedRevision: f.revision,
    reason: "Repeated user feedback in this conversation",
  };
  expect((await f.call(input, { callerCapabilities: new Set(["thread:read"]) })).isError).toBe(
    true,
  );
  expect(
    (
      await f.call(input, {
        assertCallerTurnActive: () =>
          Effect.fail(new GatewayToolError("inactive", "Inactive turn")),
      })
    ).isError,
  ).toBe(true);
  expect(
    (await f.call({ ...input, content: "sk-abcdefghijklmnopqrstuvwxyz0123456789" })).isError,
  ).toBe(true);
  expect((await f.call(input)).isError).not.toBe(true);
  expect((await f.call({ ...input, content: "Stale change" })).isError).toBe(true);
  expect((await Effect.runPromise(f.memory.readSoul())).content).toBe("Be concise");
});

it("lets only the controller save sourced project knowledge", async () => {
  const f = await fixture();
  const input = {
    action: "write_memory",
    projectId: "other-project",
    name: "lesson",
    description: "Verified lesson",
    type: "project",
    body: "Use the documented project command.",
  };
  expect((await f.call(input, { callerThreadId: "worker" })).isError).toBe(true);
  expect((await f.call(input)).isError).not.toBe(true);
  const saved = await Effect.runPromise(
    f.memory.read({ scope: "project", projectId: "other-project", name: "lesson" }),
  );
  expect(saved.body).toContain("来源：Metis 总控会话 controller；轮次 turn");
});
