import { RouterInbox } from "./RouterInbox.ts";
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
  isRouterGlobalStatusQuestion,
  isRouterCancelRequest,
  type AgentRouterHost,
} from "./AgentRouter.ts";
import type { RouterGenerationResult } from "../git/Services/TextGeneration.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture(active = true) {
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
  if (active)
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
  const readThread = async (id = threadId) =>
    (await runtime.runPromise(engine.getReadModel())).threads.find((thread) => thread.id === id)!;
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
      "独立问题的回答",
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

  it("delivers greetings and ordinary chat while an earlier classifier is blocked", async () => {
    const f = await fixture();
    let finish!: (value: RouterGenerationResult) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.router.dispatch(f.command("解释一下 Redis", "slow"), f.host);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    try {
      const greeting = f.router.dispatch(f.command("你好", "greeting"), f.host);
      const chat = f.router.dispatch(f.command("你还在吗", "chat"), f.host);
      await vi.waitFor(async () => {
        const messages = (await f.readThread()).messages;
        expect(messages.some((m) => m.text === "我在，收到你的消息了。")).toBe(true);
        expect(messages.some((m) => m.text === "独立问题的回答")).toBe(true);
      });
      await Promise.all([greeting, chat]);
    } finally {
      finish({ route: "reply", reply: "较慢的回答" });
      await first;
    }
  });

  it("keeps task effects ordered even when later chat finishes first", async () => {
    const f = await fixture();
    let finish!: (value: RouterGenerationResult) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const createWorker = vi.fn(async () => ThreadId.makeUnsafe("worker"));
    const host = { ...f.host, createWorker };
    const first = f.router.dispatch(f.command("分析项目", "first-task"), host);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    await f.router.dispatch(f.command("你好", "intervening-chat"), host);
    const third = f.router.dispatch(f.command("新任务：分析另一个项目", "third-task"), host);
    try {
      await vi.waitFor(async () => {
        const files = await readdir(path.join(f.root, "receipts"));
        expect(files.length).toBeGreaterThanOrEqual(2);
      });
      expect(createWorker).not.toHaveBeenCalled();
    } finally {
      finish({ route: "queue", reply: "" });
      await Promise.all([first, third]);
    }
    expect(createWorker).toHaveBeenCalledTimes(2);
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
    expect((await f.readThread()).messages.at(-1)?.text).toContain("我会按这条补充继续处理");
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
      routerSourceCommandId: "spoofed",
    });
    expect(decoded).not.toHaveProperty("routerTurnId");
    expect(decoded).not.toHaveProperty("routerSourceCommandId");
  });
});

it("recognizes only whole progress/cancellation utterances", () => {
  expect(isRouterStatusQuestion("现在做到哪了？")).toBe(true);
  expect(isRouterStatusQuestion("优化进展如何？")).toBe(true);
  expect(isRouterStatusQuestion("当前任务进展怎么样？")).toBe(true);
  expect(isRouterStatusQuestion("进度如何，然后删除文件")).toBe(false);
  expect(isRouterStatusQuestion("优化进展如何？然后停止任务")).toBe(false);
  expect(isRouterCancelRequest("stop")).toBe(true);
  expect(isRouterCancelRequest("解释 stop 命令")).toBe(false);
});

async function workerFixture() {
  const f = await fixture(false);
  const ids: ThreadId[] = [];
  f.host.listWorkers = async () => Promise.all(ids.map((id) => f.readThread(id)));
  f.host.createWorker = vi.fn(async (command) => {
    const id = ThreadId.makeUnsafe(`worker-${command.commandId}`);
    if (!ids.includes(id)) {
      const source = await f.readThread();
      await f.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`create-${id}`),
        threadId: id,
        projectId: source.projectId,
        title: command.message.text,
        modelSelection: source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch: null,
        worktreePath: null,
        sourceThreadId: source.id,
        creationSource: "router",
        createdAt: f.createdAt,
      });
      const { routingMode: _routing, ...turn } = command;
      await f.dispatch({ ...turn, threadId: id });
      await f.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`running-${id}`),
        threadId: id,
        session: {
          threadId: id,
          status: "running",
          providerName: "codex",
          runtimeMode: source.runtimeMode,
          activeTurnId: TurnId.makeUnsafe(`turn-${id}`),
          lastError: null,
          updatedAt: f.createdAt,
        },
        createdAt: f.createdAt,
      });
      ids.push(id);
    }
    return id;
  });
  const inbox = new RouterInbox(path.join(f.root, "inbox"), f.router, f.host);
  cleanups.push(async () => inbox.stop());
  return { ...f, ids, inbox };
}

describe("durable Router workers", () => {
  it("binds an immediate supplement to a pending creation without creating another worker", async () => {
    const f = await workerFixture();
    let finish!: (value: RouterGenerationResult) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.router.dispatch(f.command("新任务：旧书店页面", "old"), f.host);
    const first = f.router.dispatch(f.command("帮我改页面", "page"), f.host);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    f.generate.mockResolvedValueOnce({ route: "steer", targetTaskId: "pending:page", reply: "" });
    const followup = f.router.dispatch(f.command("背景用蓝色", "blue"), f.host);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(2));
    expect(JSON.parse(f.generate.mock.calls[1]![0].taskContext).pendingRequests[0].id).toBe(
      "pending:page",
    );
    finish({ route: "queue", reply: "" });
    await Promise.all([first, followup]);
    expect(f.ids).toHaveLength(2);
    expect((await f.readThread(f.ids[1]!)).messages.some((m) => m.text === "背景用蓝色")).toBe(
      true,
    );
  });

  it("accepts a semantic target among several owned workers", async () => {
    const f = await workerFixture();
    await f.router.dispatch(f.command("新任务：咖啡店页面", "coffee"), f.host);
    await f.router.dispatch(f.command("新任务：书店页面", "book"), f.host);
    f.generate.mockResolvedValueOnce({ route: "steer", targetTaskId: f.ids[0]!, reply: "" });
    await f.router.dispatch(f.command("咖啡店那个用蓝色", "blue"), f.host);
    expect(
      (await f.readThread(f.ids[0]!)).messages.some((m) => m.text === "咖啡店那个用蓝色"),
    ).toBe(true);
    expect(
      (await f.readThread(f.ids[1]!)).messages.some((m) => m.text === "咖啡店那个用蓝色"),
    ).toBe(false);
    expect(f.ids).toHaveLength(2);
  });

  it("requires a target among multiple workers but resolves quoted bindings after restart", async () => {
    const f = await workerFixture();
    await f.router.dispatch(f.command("新任务：页面 A", "a"), f.host);
    await f.router.dispatch(f.command("新任务：页面 B", "b"), f.host);
    f.generate.mockResolvedValueOnce({ route: "steer", targetTaskId: "", reply: "" });
    await f.router.dispatch(f.command("背景用蓝色", "ambiguous"), f.host);
    expect((await f.readThread()).messages.at(-1)?.text).toContain("没有唯一可确认的目标");
    expect((await f.readThread(f.ids[0]!)).messages.some((m) => m.text === "背景用蓝色")).toBe(
      false,
    );
    const restarted = new AgentRouter(path.join(f.root, "receipts"));
    await restarted.dispatch(
      { ...f.command("背景用蓝色", "quoted"), routerSourceCommandId: CommandId.makeUnsafe("b") },
      f.host,
    );
    expect((await f.readThread(f.ids[1]!)).messages.some((m) => m.text === "背景用蓝色")).toBe(
      true,
    );
    expect(f.ids).toHaveLength(2);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.lastCall?.[0].responseMode).toBe("acknowledgement");
    await restarted.dispatch(
      {
        ...f.command("继续修改", "quote-followup"),
        routerSourceCommandId: CommandId.makeUnsafe("quoted"),
      },
      f.host,
    );
    expect((await f.readThread(f.ids[1]!)).messages.some((m) => m.text === "继续修改")).toBe(true);
  });

  it("scopes quoted cancellation to its bound worker and rejects cross-conversation bindings", async () => {
    const f = await workerFixture();
    await f.router.dispatch(f.command("新任务：A", "a"), f.host);
    await f.router.dispatch(f.command("新任务：B", "b"), f.host);
    const calls: OrchestrationCommand[] = [];
    const dispatch = f.host.dispatch;
    f.host.dispatch = async (command) => {
      calls.push(command);
      return dispatch(command);
    };
    await f.router.dispatch(
      { ...f.command("停止", "stop-b"), routerSourceCommandId: CommandId.makeUnsafe("b") },
      f.host,
    );
    expect(calls.filter((c) => c.type === "thread.turn.interrupt").map((c) => c.threadId)).toEqual([
      f.ids[1],
    ]);
    const other = new AgentRouter(path.join(f.root, "receipts"));
    const otherHost = {
      ...f.host,
      dispatch: async (command: OrchestrationCommand) => {
        calls.push(command);
        return { sequence: 1 };
      },
      readThread: async () => ({ ...(await f.readThread()), id: ThreadId.makeUnsafe("other") }),
    };
    calls.length = 0;
    await other.dispatch(
      {
        ...f.command("修改", "cross"),
        threadId: ThreadId.makeUnsafe("other"),
        routerSourceCommandId: CommandId.makeUnsafe("a"),
      },
      otherHost,
    );
    expect(calls.some((c) => c.type === "thread.turn.start")).toBe(false);
    expect(f.ids).toHaveLength(2);
  });

  it("does not turn a missing quoted binding into a new task", async () => {
    const f = await workerFixture();
    await f.router.dispatch(
      {
        ...f.command("修改页面", "missing"),
        routerSourceCommandId: CommandId.makeUnsafe("unknown"),
      },
      f.host,
    );
    expect(f.ids).toHaveLength(0);
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.readThread()).messages.at(-1)?.text).toContain("尚未追加");
  });

  it("acknowledges before classification and handles chat, progress, corrections, second task and exact cancel without occupying the console", async () => {
    const f = await workerFixture();
    await f.inbox.accept(f.command("新任务：长任务 A", "a"));
    await vi.waitFor(() => expect(f.ids).toHaveLength(1));
    expect((await f.readThread()).session).toBeNull();
    const first = f.ids[0]!;
    const originalTurn = (await f.readThread(first)).session?.activeTurnId;
    let finish: ((value: RouterGenerationResult) => void) | undefined;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ack = await f.inbox.accept(f.command("解释一下队列", "chat"));
    expect(ack.routed).toBe(true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.inbox.accept(f.command("进度如何", "status"));
    await vi.waitFor(async () =>
      expect((await f.readThread()).messages.some((m) => m.text.includes("任务仍在运行"))).toBe(
        true,
      ),
    );
    finish!({ route: "reply", reply: "队列保存待处理消息。" });
    await vi.waitFor(async () =>
      expect((await f.readThread()).messages.some((m) => m.text.includes("队列保存"))).toBe(true),
    );
    f.generate.mockResolvedValueOnce({ route: "steer", targetTaskId: first, reply: "" });
    await f.inbox.accept(f.command("长任务 A 改成中文", "steer"));
    await vi.waitFor(async () =>
      expect((await f.readThread(first)).messages.some((m) => m.text.includes("改成中文"))).toBe(
        true,
      ),
    );
    expect((await f.readThread(first)).session?.activeTurnId).toBe(originalTurn);
    await f.inbox.accept(f.command("新任务：长任务 B", "b"));
    await vi.waitFor(() => expect(f.ids).toHaveLength(2));
    await f.inbox.accept(f.command("停止", "ambiguous"));
    await vi.waitFor(async () =>
      expect((await f.readThread()).messages.some((m) => m.text.includes("你想停止哪件事"))).toBe(
        true,
      ),
    );
    const deliveries = vi.spyOn(f.host, "dispatch");
    await f.inbox.accept(f.command(`任务 ${first} 停止`, "cancel"));
    await vi.waitFor(() =>
      expect(
        deliveries.mock.calls.some(
          ([command]) =>
            command.type === "thread.turn.interrupt" &&
            command.threadId === first &&
            command.turnId === originalTurn,
        ),
      ).toBe(true),
    );
    expect((await f.readThread(f.ids[1]!)).latestTurn?.state).toBe("running");
    expect((await f.readThread()).session).toBeNull();
  });

  it("replays accepted work after restart, rejects changed id content and retains only receipts", async () => {
    const f = await workerFixture();
    // Pause processing after durable admission to simulate a process loss before classification.
    const blocked = vi.spyOn(f.router, "dispatch").mockImplementation(() => new Promise(() => {}));
    const command = f.command("新任务：恢复工作", "recover");
    const ack = await f.inbox.accept(command);
    f.inbox.stop();
    blocked.mockRestore();
    const restarted = new RouterInbox(
      path.join(f.root, "inbox"),
      new AgentRouter(path.join(f.root, "receipts")),
      f.host,
    );
    cleanups.push(async () => restarted.stop());
    await restarted.recover();
    await vi.waitFor(() => expect(f.ids).toHaveLength(1));
    await vi.waitFor(async () => {
      const records = await readdir(path.join(f.root, "inbox"));
      const data = JSON.parse(await readFile(path.join(f.root, "inbox", records[0]!), "utf8"));
      expect(data.command).toBeUndefined();
    });
    expect(await restarted.accept(command)).toEqual(ack);
    await expect(
      restarted.accept({ ...command, message: { ...command.message, text: "changed" } }),
    ).rejects.toThrow("different content");
    expect(f.host.createWorker).toHaveBeenCalledTimes(1);
  });

  it("does not guess an unrelated target or execute ambiguous work when classification fails", async () => {
    const f = await workerFixture();
    f.generate.mockResolvedValueOnce({
      route: "steer",
      targetTaskId: "another-conversation",
      reply: "",
    });
    await f.router.dispatch(f.command("改成中文", "invalid-target"), f.host);
    expect(f.host.createWorker).not.toHaveBeenCalled();
    f.generate.mockRejectedValueOnce(new Error("timeout"));
    await f.router.dispatch(f.command("帮我改一下", "failed-generation"), f.host);
    expect(f.host.createWorker).not.toHaveBeenCalled();
    expect((await f.readThread()).messages.at(-1)?.text).toContain("消息未交给执行器");
  });

  it("reports uncertain submission honestly when worker creation succeeds but its acknowledgement fails", async () => {
    const f = await workerFixture();
    const dispatch = f.host.dispatch;
    f.host.dispatch = async (command) => {
      if (command.commandId.startsWith("router-worker-reply-"))
        throw new Error("notification unavailable");
      return dispatch(command);
    };
    await f.inbox.accept(f.command("新任务：通知失败", "ack-failure"));
    await vi.waitFor(async () =>
      expect((await f.readThread()).messages.some((m) => m.text.includes("任务可能已提交"))).toBe(
        true,
      ),
    );
    expect(f.ids).toHaveLength(1);
  });
});

it("leaves admitted input recoverable when the Router lifecycle stops during generation", async () => {
  const f = await workerFixture();
  let finish: ((value: RouterGenerationResult) => void) | undefined;
  f.generate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.inbox.accept(f.command("需要调查的问题", "shutdown"));
  await vi.waitFor(() => expect(finish).toBeDefined());
  f.inbox.stop();
  finish!({ route: "queue", reply: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.host.createWorker).not.toHaveBeenCalled();
  const files = await readdir(path.join(f.root, "inbox"));
  const saved = JSON.parse(await readFile(path.join(f.root, "inbox", files[0]!), "utf8"));
  expect(saved.command.message.text).toBe("需要调查的问题");
  expect(saved.error).toBeUndefined();
  f.generate.mockResolvedValue({ route: "queue", reply: "" });
  const restarted = new RouterInbox(
    path.join(f.root, "inbox"),
    new AgentRouter(path.join(f.root, "receipts")),
    f.host,
  );
  cleanups.push(async () => restarted.stop());
  await restarted.recover();
  await vi.waitFor(() => expect(f.host.createWorker).toHaveBeenCalledTimes(1));
  const context = vi.mocked(f.host.createWorker!).mock.calls[0]?.[1];
  expect(context).toContain('"sourceThreadId":"task"');
});

it("pins an explicit correction to task A even when generation would pick B and console settings differ", async () => {
  const f = await workerFixture();
  await f.router.dispatch(f.command("新任务：A", "target-a"), f.host);
  await f.router.dispatch(f.command("新任务：B", "target-b"), f.host);
  const [first, second] = f.ids;
  f.generate.mockResolvedValue({ route: "steer", targetTaskId: second!, reply: "" });
  await f.router.dispatch(
    {
      ...f.command(`任务 ${first} 修改成中文`, "pinned-correction"),
      runtimeMode: "full-access",
      providerOptions: { codex: { homePath: "/wrong-console-home" } },
    },
    f.host,
  );
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.lastCall?.[0].responseMode).toBe("acknowledgement");
  expect(
    (await f.readThread(first!)).messages.some((message) => message.text.includes("修改成中文")),
  ).toBe(true);
  expect(
    (await f.readThread(second!)).messages.some((message) => message.text.includes("修改成中文")),
  ).toBe(false);
  expect((await f.readThread(first!)).runtimeMode).toBe("approval-required");
  expect(f.ids).toHaveLength(2);
});

it("publishes a generated acknowledgement only after creation and persists its binding before publication", async () => {
  const f = await workerFixture();
  const input = f.command("给 MCP 加上直聊入口", "natural");
  const response = "我来补上 MCP 的直聊入口，先检查现有接口和会话处理方式。";
  f.generate.mockResolvedValue({ route: "queue", reply: response });
  const originalDispatch = f.host.dispatch;
  let lost = true;
  f.host.dispatch = async (command) => {
    if (command.type === "thread.messages.import") {
      expect(f.ids).toHaveLength(1);
      expect(await f.inbox.readDelivery(input)).toEqual({ workerId: f.ids[0], followup: false });
      expect(command.messages.at(-1)?.text).toBe(response);
      const result = await originalDispatch(command);
      if (lost) {
        lost = false;
        throw new Error("lost acknowledgement");
      }
      return result;
    }
    return originalDispatch(command);
  };
  await expect(f.router.dispatch(input, f.host)).rejects.toThrow("lost acknowledgement");
  const recovered = new AgentRouter(path.join(f.root, "receipts"));
  await recovered.dispatch(input, f.host);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.ids).toHaveLength(1);
  expect((await f.readThread()).messages.filter((m) => m.text === response)).toHaveLength(1);
  expect(await recovered.readDelivery(input)).toEqual({ workerId: f.ids[0], followup: false });
  expect(
    await recovered.readDelivery({ ...input, message: { ...input.message, text: "different" } }),
  ).toBeUndefined();
});

it("never publishes generated acceptance when worker creation fails", async () => {
  const f = await workerFixture();
  f.generate.mockResolvedValue({ route: "queue", reply: "我来补上接口。" });
  f.host.createWorker = async () => {
    throw new Error("creation failed");
  };
  await expect(f.router.dispatch(f.command("增加接口"), f.host)).rejects.toThrow("creation failed");
  expect((await f.readThread()).messages.some((m) => m.role === "assistant")).toBe(false);
});

it("keeps a generated supplement scoped to its worker and saves the binding before replying", async () => {
  const f = await workerFixture();
  await f.router.dispatch(f.command("新任务：MCP", "initial"), f.host);
  const input = f.command("本机有连接跳板机", "supplement");
  const response = "明白，我会通过本机的跳板机连接继续排查。";
  f.generate.mockResolvedValue({ route: "steer", targetTaskId: f.ids[0]!, reply: response });
  const dispatch = f.host.dispatch;
  f.host.dispatch = async (command) => {
    if (command.type === "thread.messages.import") {
      expect(await f.inbox.readDelivery(input)).toEqual({ workerId: f.ids[0], followup: true });
    }
    return dispatch(command);
  };
  await f.router.dispatch(input, f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toBe(response);
  expect((await f.readThread(f.ids[0]!)).messages.at(-1)?.text).toBe(input.message.text);
});

it("answers local and targeted progress without invoking a provider", async () => {
  const f = await workerFixture();
  await f.router.dispatch(f.command("新任务：MCP", "initial"), f.host);
  f.generate.mockImplementation(() => new Promise(() => {}));
  await f.router.dispatch(f.command("进度如何", "progress"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("任务仍在运行");
  await f.router.dispatch(f.command("优化进展如何？", "optimization-progress"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("任务仍在运行");
  await f.router.dispatch(f.command(`任务 ${f.ids[0]} 进度如何`, "targeted"), f.host);
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.ids).toHaveLength(1);
});

it("answers instance status from authorized state, filtering unavailable and idle threads", async () => {
  const f = await fixture(false);
  const base = await f.readThread();
  f.host.listActiveThreads = vi.fn(async () => [
    base,
    {
      ...base,
      id: ThreadId.makeUnsafe("elsewhere"),
      title: "Other project",
      latestTurn: { ...base.latestTurn!, state: "running" as const },
    },
    {
      ...base,
      title: "Archived",
      archivedAt: f.createdAt,
      latestTurn: { ...base.latestTurn!, state: "running" as const },
    },
    {
      ...base,
      title: "Expired",
      sidechatExpiredAt: f.createdAt,
      latestTurn: { ...base.latestTurn!, state: "running" as const },
    },
  ]);
  await f.router.dispatch(f.command("现在有进行中的 Metis 会话吗", "global"), f.host);
  const reply = (await f.readThread()).messages.at(-1)?.text;
  expect(reply).toContain("1 个进行中的会话");
  expect(reply).toContain("Other project");
  expect(reply).not.toContain("Archived");
  expect(reply).not.toContain("Expired");
  expect(reply).not.toContain("正在路由");
  expect(f.generate).not.toHaveBeenCalled();
  f.host.listActiveThreads = async () => null;
  await f.router.dispatch(f.command("现在有进行中的 Metis 会话吗", "denied"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("无法读取全局");
  f.host.listActiveThreads = async () => [];
  await f.router.dispatch(f.command("list active sessions", "empty"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("没有进行中的会话");
});

it("excludes expired workers from local progress and task control", async () => {
  const f = await workerFixture();
  await f.router.dispatch(f.command("新任务：expired work", "initial"), f.host);
  const worker = await f.readThread(f.ids[0]!);
  f.host.listWorkers = async () => [{ ...worker, sidechatExpiredAt: f.createdAt }];
  await f.router.dispatch(f.command("优化进展如何？", "local"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("尚无已启动任务");
  await f.router.dispatch(f.command(`任务 ${worker.id} 停止`, "cancel-expired"), f.host);
  expect((await f.readThread()).messages.at(-1)?.text).toContain("不属于此会话或已不可用");
  expect(f.generate).not.toHaveBeenCalled();
});

it("timestamps replies when produced and replays their durable plan unchanged", async () => {
  const f = await fixture();
  const input = { ...f.command("进度如何", "timed"), createdAt: "2020-01-01T00:00:00.000Z" };
  const dispatch = vi.fn(f.host.dispatch);
  f.host.dispatch = dispatch;
  dispatch.mockRejectedValueOnce(new Error("delivery unavailable"));
  await expect(f.router.dispatch(input, f.host)).rejects.toThrow("delivery unavailable");
  const first = dispatch.mock.calls[0]![0];
  expect(first.type).toBe("thread.messages.import");
  if (first.type !== "thread.messages.import") throw new Error("Expected reply");
  expect(first.messages[0]?.createdAt).toBe(input.createdAt);
  expect(first.messages[1]?.createdAt).not.toBe(input.createdAt);
  await f.router.dispatch(input, f.host);
  expect(dispatch.mock.calls[1]![0]).toEqual(first);
});

it("matches only whole global status queries", () => {
  expect(isRouterGlobalStatusQuestion("现在有进行中的 Metis 会话吗")).toBe(true);
  expect(isRouterGlobalStatusQuestion("列出所有运行中的任务")).toBe(true);
  expect(isRouterGlobalStatusQuestion("当前 Metis 有哪些运行中的任务？")).toBe(true);
  expect(isRouterGlobalStatusQuestion("目前有哪些正在进行的会话？")).toBe(true);
  expect(isRouterGlobalStatusQuestion("查看全部进行中的 Metis 任务")).toBe(true);
  expect(isRouterGlobalStatusQuestion("现在有进行中的 Metis 会话吗，然后停止它们")).toBe(false);
  expect(isRouterGlobalStatusQuestion("show all running tasks and delete them")).toBe(false);
  expect(isRouterGlobalStatusQuestion("当前 Metis 有哪些运行中的任务？停止它们")).toBe(false);
});
