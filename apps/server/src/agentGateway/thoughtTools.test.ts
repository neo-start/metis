import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeThoughtsStore } from "../metisMemory/thoughtsStore.ts";
import { makeThoughtTools } from "./thoughtTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "thought-tools-"));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const tools = makeThoughtTools(makeThoughtsStore(root));
  const context = { callerThreadId: "thread-a", callerTurnId: "turn-a" } as ToolContext;
  const call = async (action: string, args: Record<string, unknown>) => {
    const tool = tools.find((tool) => tool.definition.name === `metis_thoughts_${action}`)!;
    const result = await Effect.runPromise(tool.handler(args, context));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return { result, text };
  };
  return { tools, call };
}

it("requires write capability and an active turn for all mutations", () => {
  const { tools } = fixture();
  expect(
    tools.map((tool) => [
      tool.definition.name,
      tool.requiredCapability,
      Boolean(tool.requiresActiveTurn),
    ]),
  ).toEqual([
    ["metis_thoughts_list", "thread:read", false],
    ["metis_thoughts_read", "thread:read", false],
    ["metis_thoughts_create", "thread:write", true],
    ["metis_thoughts_update", "thread:write", true],
    ["metis_thoughts_delete", "thread:write", true],
  ]);
  for (const tool of tools) expect(tool.definition.inputSchema.additionalProperties).toBe(false);
});

it("records caller provenance and returns citation URLs for recall", async () => {
  const { call } = fixture();
  const created = await call("create", { id: "thought-1", body: "我想慢下来。" });
  expect(created.result.isError).not.toBe(true);
  expect(JSON.parse(created.text)).toMatchObject({
    saved: true,
    thought: {
      body: "我想慢下来。",
      origin: "agent",
      sourceThreadId: "thread-a",
      sourceTurnId: "turn-a",
      url: "/thoughts?entry=thought-1",
    },
  });
  const found = await call("list", { query: "慢下来" });
  expect(JSON.parse(found.text)).toMatchObject({
    total: 1,
    entries: [{ id: "thought-1", url: "/thoughts?entry=thought-1" }],
  });
  const read = await call("read", { id: "thought-1" });
  expect(JSON.parse(read.text).body).toBe("我想慢下来。");
});

it("returns validation and conflict failures as tool errors without false saved receipts", async () => {
  const { call } = fixture();
  expect((await call("create", { body: "missing ID" })).result.isError).toBe(true);
  expect((await call("list", { limit: -1 })).result.isError).toBe(true);
  await call("create", { id: "one", body: "原文" });
  expect(
    (await call("update", { id: "one", body: "新文", expectedRevision: 1 })).result.isError,
  ).not.toBe(true);
  const conflict = await call("update", { id: "one", body: "覆盖", expectedRevision: 1 });
  expect(conflict.result.isError).toBe(true);
  expect(conflict.text).toContain("已被修改");
  expect(JSON.parse((await call("read", { id: "one" })).text).body).toBe("新文");
  expect((await call("delete", { id: "one", expectedRevision: 1 })).result.isError).toBe(true);
  expect(JSON.parse((await call("delete", { id: "one", expectedRevision: 2 })).text)).toEqual({
    deleted: true,
  });
});
