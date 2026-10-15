import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeMetisMemoryShape } from "../metisMemory/Layers/MetisMemory.ts";
import { makeAgentGatewayMemoryTools } from "./memoryTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { ToolInputError } from "./toolInput.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const THREAD_PROJECTS: Record<string, string> = {
  "thread-alpha": "alpha",
  "thread-beta": "beta",
};

function makeTools() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "metis-memory-tools-"));
  fs.chmodSync(base, 0o700);
  roots.push(base);
  const memory = makeMetisMemoryShape({
    rootDir: path.join(base, "memory"),
    readModel: () => null,
  });
  const tools = makeAgentGatewayMemoryTools({
    memory,
    requireThreadShell: (threadId) => {
      const projectId = THREAD_PROJECTS[threadId];
      return projectId === undefined
        ? Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`))
        : Effect.succeed({ id: threadId, projectId } as unknown as OrchestrationThreadShell);
    },
    resolveProjectTitle: (projectId) => Effect.succeed(`Project ${projectId}`),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return { memory, tools, byName, rootDir: memory.rootDir };
}

function context(threadId: string): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session",
      threadId,
      provider: "codex",
      turnId: "turn-1",
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "session",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-1",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function call(
  tool: ToolEntry | undefined,
  args: Record<string, unknown>,
  threadId = "thread-alpha",
): Promise<{ result: McpToolCallResult; json: unknown }> {
  if (!tool) throw new Error("tool missing");
  const result = await Effect.runPromise(tool.handler(args, context(threadId)));
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { result, json };
}

describe.skipIf(process.platform === "win32")("synara_memory_* gateway tools", () => {
  it("exposes four tools with read/write capabilities and closed schemas", () => {
    const { tools } = makeTools();
    expect(
      tools.map((tool) => [
        tool.definition.name,
        tool.requiredCapability,
        tool.requiresActiveTurn === true,
      ]),
    ).toEqual([
      ["synara_memory_list", "thread:read", false],
      ["synara_memory_read", "thread:read", false],
      ["synara_memory_write", "thread:write", true],
      ["synara_memory_delete", "thread:write", true],
    ]);
    for (const tool of tools) {
      expect(tool.definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("writes, lists, reads, and deletes memories scoped to the caller's project", async () => {
    const { byName, rootDir } = makeTools();
    const write = byName.get("synara_memory_write");
    const saved = await call(write, {
      scope: "project",
      name: "alpha-deploy",
      description: "Alpha deploys through canary",
      type: "project",
      body: "Canary first, then prod.",
    });
    expect(saved.result.isError).toBeUndefined();
    expect(saved.json).toMatchObject({ saved: true, memory: { scope: "project" } });
    const written = fs.readFileSync(
      path.join(rootDir, "projects", "alpha", "alpha-deploy.md"),
      "utf8",
    );
    expect(written).toContain('projectTitle: "Project alpha"');

    await call(write, {
      scope: "global",
      name: "tone",
      description: "Prefers concise answers",
      type: "feedback",
      body: "Short answers.",
    });

    const alphaList = await call(byName.get("synara_memory_list"), {});
    expect(alphaList.json).toMatchObject({
      project: { projectId: "alpha", title: "Project alpha" },
      soul: { present: false },
    });
    expect(
      (alphaList.json as { memories: Array<{ name: string }> }).memories.map((m) => m.name),
    ).toEqual(["alpha-deploy", "tone"]);

    // Another project's thread never sees alpha's project memories.
    const betaList = await call(byName.get("synara_memory_list"), {}, "thread-beta");
    expect(
      (betaList.json as { memories: Array<{ name: string }> }).memories.map((m) => m.name),
    ).toEqual(["tone"]);
    const betaRead = await call(
      byName.get("synara_memory_read"),
      { scope: "project", name: "alpha-deploy" },
      "thread-beta",
    );
    expect(betaRead.result.isError).toBe(true);
    expect(betaRead.json).toMatchObject({ error: { code: "memory_not-found" } });

    const read = await call(byName.get("synara_memory_read"), {
      scope: "project",
      name: "alpha-deploy",
    });
    expect(read.json).toMatchObject({
      name: "alpha-deploy",
      body: expect.stringContaining("Canary first, then prod."),
    });

    expect(read.json).toMatchObject({
      body: expect.stringContaining("来源：Metis 会话 thread-alpha；轮次 turn-1"),
    });

    const soul = await call(byName.get("synara_memory_read"), { scope: "soul" });
    expect(soul.json).toMatchObject({ scope: "soul", content: "" });

    const deleted = await call(byName.get("synara_memory_delete"), {
      scope: "project",
      name: "alpha-deploy",
    });
    expect(deleted.json).toEqual({ scope: "project", name: "alpha-deploy", deleted: true });
  });

  it("returns tool errors for traversal, bad arguments, secrets, and unknown threads", async () => {
    const { byName } = makeTools();
    const write = byName.get("synara_memory_write");
    const valid = {
      scope: "global",
      name: "note",
      description: "A note",
      type: "user",
      body: "Body",
    };
    for (const args of [
      { ...valid, name: "../../escape" },
      { ...valid, scope: "everywhere" },
      { ...valid, type: "secret" },
      { ...valid, body: "   " },
      { ...valid, body: "key AKIAABCDEFGHIJKLMNOP" },
    ]) {
      const { result } = await call(write, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    const unknown = await call(byName.get("synara_memory_list"), {}, "thread-missing");
    expect(unknown.result.isError).toBe(true);
    const readTraversal = await call(byName.get("synara_memory_read"), {
      scope: "global",
      name: "../soul",
    });
    expect(readTraversal.result.isError).toBe(true);
  });
});
