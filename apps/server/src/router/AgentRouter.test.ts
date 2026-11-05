import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  AgentRouter,
  isRouterStatusQuestion,
  isRouterCancelRequest,
  type AgentRouterHost,
} from "./AgentRouter.ts";
import type { RouterGenerationResult } from "../git/Services/TextGeneration.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-router-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "metis-router-runtime-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  cleanups.push(() => runtime.dispose());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  const createdAt = new Date().toISOString();
  const threadId = ThreadId.makeUnsafe("task");
  const projectId = ProjectId.makeUnsafe("project");
  const turnId = TurnId.makeUnsafe("long-running-turn");
  await dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe("project"),
    projectId,
    title: "Project",
    workspaceRoot: root,
    createdAt,
  });
  await dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe("thread"),
    projectId,
    threadId,
    title: "Long task",
    modelSelection: { provider: "codex", model: "test-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  await dispatch({
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe("session"),
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: createdAt,
    },
    createdAt,
  });
  const readThread = async () => (await runtime.runPromise(engine.getReadModel())).threads[0]!;
  const generate = vi.fn<AgentRouterHost["generate"]>(async () => ({
    route: "reply",
    reply: "独立问题的回答",
  }));
  const host: AgentRouterHost = { readThread, generate, dispatch, generationCwd: root };
  const router = new AgentRouter(path.join(root, "receipts"));
  const command = (
    text: string,
    id = "request",
  ): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(id),
    threadId,
    routingMode: "auto",
    message: {
      messageId: MessageId.makeUnsafe(`message-${id}`),
      role: "user",
      text,
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    dispatchMode: "queue",
    createdAt,
  });
  return {
    root,
    router,
    host,
    readThread,
    generate,
    command,
    dispatch,
    threadId,
    turnId,
    createdAt,
  };
}

describe("AgentRouter above the real orchestration engine", () => {
  it("answers independently without starting a provider turn or changing the active run", async () => {
    const f = await fixture();
    await f.router.dispatch(f.command("解释一下 Redis"), f.host);
    const thread = await f.readThread();
    expect(thread.session?.activeTurnId).toBe(f.turnId);
    expect(thread.messages.map((message) => message.text)).toEqual([
      "解释一下 Redis",
      "Router：\n独立问题的回答",
    ]);
    expect(thread.latestTurn?.turnId).toBe(f.turnId);
    expect(thread.latestTurn?.state).toBe("running");
    expect(f.generate.mock.calls[0]?.[0].modelSelection).toEqual({
      provider: "codex",
      model: "test-model",
    });
  });

  it("answers status and accepts a scoped stop while independent generation is blocked", async () => {
    const f = await fixture();
    let finish!: (value: RouterGenerationResult) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.generate.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const long = f.router.dispatch(f.command("解释一下 Redis"), f.host);
    await entered;
    await f.router.dispatch(f.command("现在做到哪了？", "status"), f.host);
    expect((await f.readThread()).messages.at(-1)?.text).toContain("任务仍在运行");
    await f.router.dispatch(f.command("停一下", "stop"), f.host);
    expect((await f.readThread()).messages.at(-1)?.text).toContain("已请求停止");
    expect(f.generate).toHaveBeenCalledTimes(1);
    finish({ route: "reply", reply: "解释" });
    await long;
  });

  it("replays a completed receipt after restart without regenerating or duplicating chat", async () => {
    const f = await fixture();
    const input = f.command("解释一下 Redis");
    const first = await f.router.dispatch(input, f.host);
    const restarted = new AgentRouter(path.join(f.root, "receipts"));
    expect(await restarted.dispatch(input, f.host)).toEqual(first);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await f.readThread()).messages).toHaveLength(2);
    const files = await readdir(path.join(f.root, "receipts"));
    expect(await readFile(path.join(f.root, "receipts", files[0]!), "utf8")).not.toContain("Redis");
    await expect(restarted.dispatch(f.command("different"), f.host)).rejects.toThrow(
      "different content",
    );
  });

  it("deduplicates concurrent identical requests and rejects command ID reuse", async () => {
    const f = await fixture();
    const input = f.command("解释一下 Redis");
    const first = f.router.dispatch(input, f.host);
    const duplicate = f.router.dispatch(input, f.host);
    await expect(f.router.dispatch(f.command("different"), f.host)).rejects.toThrow(
      "different content",
    );
    expect(await duplicate).toEqual(await first);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("persists a steering plan before dispatch and retries partial delivery without duplication", async () => {
    const f = await fixture();
    f.generate.mockResolvedValue({ route: "steer", reply: "" });
    let fail = true;
    const host: AgentRouterHost = {
      ...f.host,
      dispatch: async (command) => {
        if (command.type === "thread.messages.import" && fail) {
          fail = false;
          throw new Error("disconnected");
        }
        return f.dispatch(command);
      },
    };
    const input = f.command("页面改成蓝色");
    await expect(f.router.dispatch(input, host)).rejects.toThrow("disconnected");
    await new AgentRouter(path.join(f.root, "receipts")).dispatch(input, host);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await f.readThread()).messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect((await f.readThread()).messages.at(-1)?.text).toContain("不代表修改已经完成");
  });

  it("does not redirect a replacement run when the original finishes during classification", async () => {
    const f = await fixture();
    f.generate.mockImplementation(async () => {
      const thread = await f.readThread();
      await f.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("replace"),
        threadId: f.threadId,
        session: { ...thread.session!, activeTurnId: TurnId.makeUnsafe("replacement") },
        createdAt: f.createdAt,
      });
      return { route: "steer", reply: "" };
    });
    await f.router.dispatch(f.command("页面改成蓝色"), f.host);
    expect((await f.readThread()).messages.at(-1)?.text).toContain("尚未发送");
    expect((await f.readThread()).session?.activeTurnId).toBe("replacement");
  });

  it("rechecks steering ownership inside serialized engine admission", async () => {
    const f = await fixture();
    f.generate.mockResolvedValue({ route: "steer", reply: "" });
    const host = {
      ...f.host,
      dispatch: async (command: OrchestrationCommand) => {
        if (command.type === "thread.turn.start") {
          const thread = await f.readThread();
          await f.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("replace"),
            threadId: f.threadId,
            session: { ...thread.session!, activeTurnId: TurnId.makeUnsafe("replacement") },
            createdAt: f.createdAt,
          });
        }
        return f.dispatch(command);
      },
    };
    await expect(f.router.dispatch(f.command("页面改成蓝色"), host)).rejects.toThrow(
      "original turn",
    );
    expect((await f.readThread()).messages).toHaveLength(0);
  });

  it("falls back to the durable queue with an honest notice on generation failure", async () => {
    const f = await fixture();
    f.generate.mockRejectedValue(new Error("timeout"));
    await f.router.dispatch(f.command("调查另一个问题"), f.host);
    expect((await f.readThread()).messages[0]?.dispatchMode).toBe("queue");
    expect((await f.readThread()).messages.at(-1)?.text).toContain("超时");
    expect((await f.readThread()).session?.activeTurnId).toBe(f.turnId);
  });

  it("keeps unsupported native steering queued without interrupting the original task", async () => {
    const f = await fixture();
    const thread = await f.readThread();
    await f.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("provider"),
      threadId: f.threadId,
      session: { ...thread.session!, providerName: "cursor" },
      createdAt: f.createdAt,
    });
    f.generate.mockResolvedValue({ route: "steer", reply: "" });
    await f.router.dispatch(f.command("页面改成蓝色"), f.host);
    expect((await f.readThread()).messages[0]?.dispatchMode).toBe("queue");
  });

  it("does not intercept explicit queue or rich/approval-related commands", async () => {
    const f = await fixture();
    await f.router.dispatch({ ...f.command("进度如何"), routingMode: undefined }, f.host);
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.readThread()).messages).toHaveLength(1);
  });

  it("rejects stale scoped cancellation before it can interrupt a replacement run", async () => {
    const f = await fixture();
    await expect(
      f.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("router-cancel-stale"),
        threadId: f.threadId,
        turnId: TurnId.makeUnsafe("other-run"),
        createdAt: f.createdAt,
      }),
    ).rejects.toThrow("no longer active");
  });

  it("strips client attempts to supply server-only steering preconditions", async () => {
    const f = await fixture();
    const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
      ...f.command("hello"),
      routerTurnId: "spoofed",
    });
    expect(decoded).not.toHaveProperty("routerTurnId");
  });
});

it("recognizes only whole progress/cancellation utterances", () => {
  expect(isRouterStatusQuestion("现在做到哪了？")).toBe(true);
  expect(isRouterStatusQuestion("进度如何，然后删除文件")).toBe(false);
  expect(isRouterCancelRequest("stop")).toBe(true);
  expect(isRouterCancelRequest("解释 stop 命令")).toBe(false);
});
