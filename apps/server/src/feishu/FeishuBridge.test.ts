import { RouterRuntime } from "../router/RouterRuntime.ts";
import { RouterInbox } from "../router/RouterInbox.ts";
import { AgentRouter } from "../router/AgentRouter.ts";
import type {
  RouterGenerationInput,
  RouterGenerationResult,
} from "../git/Services/TextGeneration.ts";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { QueuedTurnPromotionRepositoryLive } from "../persistence/Layers/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { MetisMemoryLive } from "../metisMemory/Layers/MetisMemory.ts";
import { MetisController } from "../metis/MetisController.ts";
import {
  MetisControllerService,
  makeMetisControllerHost,
} from "../metis/MetisControllerService.ts";
import { makeFeishuBridge } from "./Layers/FeishuBridge.ts";

type Inbound = {
  chatId: string;
  chatType: string;
  senderId: string;
  messageId: string;
  content: string;
  resources: import("./feishuInboundAttachments.ts").FeishuInboundResource[];
  replyToMessageId?: string;
};
const transport = vi.hoisted(() => ({
  receive: undefined as ((message: Inbound) => Promise<void>) | undefined,
  afterSubmit: async () => {},
  contents: [] as string[],
  initialContents: [] as string[],
  onStreamOpen: async () => {},
  send: vi.fn(async () => {}),
  streamReplies: vi.fn(),
  getResource: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu" },
  LoggerLevel: { warn: "warn" },
  createLarkChannel: (config: { outbound: { streamInitialText: string } }) => ({
    on: (event: string, handler: (message: Inbound) => Promise<void>) => {
      if (event === "message") transport.receive = handler;
    },
    connect: async () => {},
    disconnect: async () => {},
    send: transport.send,
    rawClient: { im: { v1: { messageResource: { get: transport.getResource } } } },
    stream: async (
      chat: string,
      input: {
        markdown: (controller: { setContent: (text: string) => Promise<void> }) => Promise<void>;
      },
      options: { replyTo: string },
    ) => {
      let finalText = "";
      transport.initialContents.push(config.outbound.streamInitialText);
      await transport.onStreamOpen();
      await input.markdown({
        setContent: async (text) => {
          transport.contents.push(text);
          finalText = text;
        },
      });
      transport.streamReplies(chat, { text: finalText }, options);
      return { messageId: `card:${options.replyTo}` };
    },
  }),
}));

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  transport.receive = undefined;
  transport.contents.length = 0;
  transport.initialContents.length = 0;
  transport.onStreamOpen = async () => {};
  transport.afterSubmit = async () => {};
  vi.clearAllMocks();
});

async function setup(routerEnabled = false) {
  const runtimeLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "feishu-controller-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(MetisMemoryLive.pipe(Layer.provideMerge(runtimeLayer)));
  const scope = await Effect.runPromise(Scope.make());
  disposals.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  const host = await runtime.runPromise(makeMetisControllerHost);
  const controller = new MetisController(path.join(config.stateDir, "controller"), host);
  await controller.initialize();
  const selection = {
    modelSelection: { provider: "codex", model: "test-controller-model" },
    runtimeMode: "approval-required",
  } as const;
  await controller.control({ action: "open", ...selection });
  await fs.writeFile(
    path.join(config.baseDir, "feishu-app.json"),
    JSON.stringify({
      appId: "cli_test",
      appSecret: "test-secret-not-a-real-credential",
      allowedOpenIds: ["ou_owner"],
      target: "controller",
    }),
  );
  const mapPath = path.join(config.baseDir, "feishu-chats.json");
  await fs.writeFile(mapPath, JSON.stringify({ oc_owner: "obsolete-concierge" }));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const originalDispatch = engine.dispatch;
  let completing = false;
  vi.spyOn(engine, "dispatch").mockImplementation((command, options) =>
    originalDispatch(command, options).pipe(
      Effect.tap(() =>
        command.type === "thread.turn.start" && !completing
          ? Effect.promise(async () => {
              completing = true;
              try {
                await transport.afterSubmit();
              } finally {
                completing = false;
              }
            })
          : Effect.void,
      ),
    ),
  );
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  const generate = vi.fn(
    async (_input: RouterGenerationInput): Promise<RouterGenerationResult> => ({
      route: "reply",
      reply: "独立回复",
    }),
  );
  const inbox = new RouterInbox(
    path.join(config.stateDir, "router/inbox"),
    new AgentRouter(path.join(config.stateDir, "router/receipts")),
    {
      generationCwd: config.stateDir,
      dispatch,
      generate,
      createWorker: async () => {
        throw new Error("Unexpected worker in conversation test");
      },
      readThread: async (id) =>
        (await runtime.runPromise(engine.getReadModel())).threads.find((t) => t.id === id) ?? null,
      listWorkers: async () => [],
    },
  );
  disposals.unshift(async () => inbox.stop());
  const bridgeEffect = makeFeishuBridge.pipe(
    Effect.provideService(MetisControllerService, controller),
  );
  const bridge = await runtime.runPromise(
    routerEnabled ? bridgeEffect.pipe(Effect.provideService(RouterRuntime, inbox)) : bridgeEffect,
  );
  await runtime.runPromise(Scope.provide(bridge.start(), scope));
  const complete = async (text: string) => {
    const threadId = ThreadId.makeUnsafe((await controller.overview()).threadId!);
    const turnId = TurnId.makeUnsafe(randomUUID());
    const messageId = MessageId.makeUnsafe(randomUUID());
    const stamp = () => ({
      commandId: CommandId.makeUnsafe(randomUUID()),
      createdAt: new Date().toISOString(),
      threadId,
    });
    const session = async (status: "running" | "ready", activeTurnId: TurnId | null) =>
      dispatch({
        ...stamp(),
        type: "thread.session.set",
        session: {
          threadId,
          providerName: "codex",
          runtimeMode: selection.runtimeMode,
          status,
          activeTurnId,
          lastError: null,
          updatedAt: new Date().toISOString(),
        },
      });
    await session("running", turnId);
    await dispatch({
      ...stamp(),
      type: "thread.message.assistant.delta",
      messageId,
      turnId,
      delta: text,
    });
    await dispatch({ ...stamp(), type: "thread.message.assistant.complete", messageId, turnId });
    await session("ready", null);
  };
  const receive = (id: string, content = "你好", override: Partial<Inbound> = {}) =>
    transport.receive!({
      chatId: "oc_owner",
      chatType: "p2p",
      senderId: "ou_owner",
      messageId: id,
      content,
      resources: [],
      ...override,
    });
  return {
    runtime,
    controller,
    selection,
    engine,
    dispatch,
    complete,
    receive,
    mapPath,
    generate,
    inbox,
  };
}

describe("Feishu Router ingress and passive delivery", () => {
  it("starts routing without waiting for the typing card network request", async () => {
    const f = await setup(true);
    let open!: () => void;
    transport.onStreamOpen = () =>
      new Promise<void>((resolve) => {
        open = resolve;
      });
    try {
      await f.receive("slow-card", "你好");
      await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
      expect(transport.initialContents).toHaveLength(1);
      expect(transport.streamReplies).not.toHaveBeenCalled();
    } finally {
      open();
    }
    await vi.waitFor(() => expect(transport.streamReplies).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(transport.initialContents).toHaveLength(1);
  });

  it("passes a durable quoted input binding and refuses unknown references", async () => {
    const f = await setup(true);
    await f.receive("original", "你好");
    const accept = vi.spyOn(f.inbox, "accept");
    await f.receive("quoted", "继续修改", { replyToMessageId: "original" });
    expect(
      accept.mock.calls.some(
        ([command]) => command.routerSourceCommandId === "feishu:turn:original",
      ),
    ).toBe(true);
    await f.receive("unknown-quote", "继续修改", { replyToMessageId: "unknown" });
    expect(
      accept.mock.calls.some(
        ([command]) => command.routerSourceCommandId === "feishu:unbound:unknown",
      ),
    ).toBe(true);
    await vi.waitFor(
      () => expect(JSON.stringify(transport.streamReplies.mock.calls)).toContain("独立回复"),
      { timeout: 3000 },
    );
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(
      f.generate.mock.calls.some(
        ([input]) => input.responseMode && input.taskContext.includes("尚未追加"),
      ),
    ).toBe(true);
  });

  it("answers greetings without a provider turn and deduplicates redelivery after controller rotation", async () => {
    const f = await setup(true);
    f.generate.mockResolvedValueOnce({ route: "reply", reply: "早上好！" });
    const first = (await f.controller.overview()).threadId!;
    await f.receive("router-greeting", "你好？");
    await vi.waitFor(
      () =>
        expect(transport.streamReplies).toHaveBeenCalledWith(
          "oc_owner",
          { text: "早上好！" },
          { replyTo: "router-greeting" },
        ),
      { timeout: 3000 },
    );
    expect(transport.initialContents).toEqual(["…"]);
    expect(transport.contents).toEqual(["早上好！"]);
    expect(transport.send).not.toHaveBeenCalled();
    expect(f.generate).toHaveBeenCalledTimes(1);
    const thread = (await f.runtime.runPromise(f.engine.getReadModel())).threads.find(
      (t) => t.id === first,
    )!;
    expect(thread.latestTurn).toBeNull();
    await f.controller.control({
      action: "clear",
      sourceThreadId: ThreadId.makeUnsafe(first),
      ...f.selection,
    });
    await f.receive("router-greeting", "你好？");
    expect(transport.streamReplies).toHaveBeenCalledTimes(1);
  });
  it("accepts progress while a classifier is blocked instead of waiting in the provider queue", async () => {
    const f = await setup(true);
    let finish!: (result: RouterGenerationResult) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.receive("router-question", "解释一下路由器");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(transport.streamReplies).not.toHaveBeenCalled();
    expect(transport.initialContents).toEqual(["…"]);
    await f.receive("router-progress", "进度如何");
    await vi.waitFor(
      () =>
        expect(
          transport.streamReplies.mock.calls.some(
            (call) => (call as unknown[])[2] && JSON.stringify(call).includes("router-progress"),
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    finish({ route: "reply", reply: "路由器负责分发消息。" });
    await vi.waitFor(
      () =>
        expect(
          transport.streamReplies.mock.calls.some((call) =>
            JSON.stringify(call).includes("路由器负责"),
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    expect(transport.contents).toContain("路由器负责分发消息。");
  });
});

describe("Feishu instance-controller routing with real orchestration", () => {
  it("opens a neutral typing card before downloading an image or starting its provider turn", async () => {
    const f = await setup(true);
    let release!: () => void;
    const download = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.getResource.mockImplementationOnce(async () => {
      expect(transport.initialContents).toEqual(["…"]);
      await download;
      return {
        headers: { "content-type": "image/png" },
        getReadableStream: () => Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]),
      };
    });
    transport.afterSubmit = () => f.complete("图片检查结果");
    const received = f.receive("image-receipt", "检查图片", {
      resources: [{ type: "image", fileKey: "test-image" }],
    });
    await vi.waitFor(() => expect(transport.getResource).toHaveBeenCalledTimes(1));
    const before = await f.runtime.runPromise(f.engine.getReadModel());
    expect(before.threads.every((t) => t.latestTurn === null)).toBe(true);
    release();
    await received;
    expect(transport.contents).toEqual(["图片检查结果"]);
    await f.receive("image-receipt", "检查图片", {
      resources: [{ type: "image", fileKey: "test-image" }],
    });
    expect(transport.initialContents).toEqual(["…"]);
    expect(transport.getResource).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("does not submit a turn when the initial typing card cannot be sent", async () => {
    const f = await setup();
    transport.onStreamOpen = async () => {
      throw new Error("receipt transport unavailable");
    };
    await f.receive("failed-receipt", "执行长任务");
    const model = await f.runtime.runPromise(f.engine.getReadModel());
    expect(model.threads.every((t) => t.latestTurn === null)).toBe(true);
    expect(transport.send).toHaveBeenCalledWith("oc_owner", {
      text: expect.stringContaining("receipt transport unavailable"),
    });
  });

  it("follows /clear, preserves controller settings and deduplicates across conversation rotation", async () => {
    const f = await setup();
    const first = (await f.controller.overview()).threadId!;
    transport.afterSubmit = () => f.complete("第一轮回复");
    await f.receive("one");
    expect(transport.contents).toEqual(["第一轮回复"]);
    const firstThread = (await f.runtime.runPromise(f.engine.getReadModel())).threads.find(
      (thread) => thread.id === first,
    )!;
    expect(firstThread.runtimeMode).toBe("approval-required");
    expect(firstThread.modelSelection).toEqual(f.selection.modelSelection);
    expect(firstThread.messages.some((message) => message.id === "feishu:one")).toBe(true);

    const next = await f.controller.control({
      action: "clear",
      sourceThreadId: ThreadId.makeUnsafe(first),
      ...f.selection,
    });
    transport.afterSubmit = () => f.complete("新总控回复");
    await f.receive("one"); // Old event redelivery after /clear.
    expect(transport.contents).toEqual(["第一轮回复"]);
    await f.receive("two");
    expect(transport.contents).toEqual(["第一轮回复", "新总控回复"]);
    const threads = (await f.runtime.runPromise(f.engine.getReadModel())).threads;
    expect(threads).toHaveLength(2);
    expect(threads.find((thread) => thread.id === next.threadId)?.messages[0]?.id).toBe(
      "feishu:two",
    );
    expect(JSON.parse(await fs.readFile(f.mapPath, "utf8"))).toEqual({
      oc_owner: "obsolete-concierge",
    });
    await f.receive("stop", "停");
    expect(transport.send).toHaveBeenCalledWith(
      "oc_owner",
      { text: "已叫停当前这一轮。" },
      { replyTo: "stop" },
    );
  });

  it("returns only the Feishu turn when a later web turn has already completed", async () => {
    const f = await setup();
    transport.afterSubmit = async () => {
      await f.complete("飞书这轮的答案");
      await f.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("web-request"),
        threadId: ThreadId.makeUnsafe((await f.controller.overview()).threadId!),
        message: {
          messageId: MessageId.makeUnsafe("web-message"),
          role: "user",
          text: "网页消息",
          attachments: [],
        },
        runtimeMode: f.selection.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });
      await f.complete("网页另一轮的私密答案");
    };
    await f.receive("own-turn");
    expect(transport.contents).toEqual(["飞书这轮的答案"]);
  });

  it("rejects other senders/groups and never creates a fallback when the controller is archived", async () => {
    const f = await setup();
    await f.receive("other-owner", "消息", { senderId: "ou_other" });
    await f.receive("group", "消息", { chatType: "group" });
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.getResource).not.toHaveBeenCalled();
    await f.dispatch({
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("archive"),
      threadId: ThreadId.makeUnsafe((await f.controller.overview()).threadId!),
    });
    await f.receive("unavailable");
    expect(transport.send).toHaveBeenCalledWith("oc_owner", {
      text: expect.stringContaining("实例总控暂时不可用"),
    });
    expect((await f.runtime.runPromise(f.engine.getReadModel())).threads).toHaveLength(1);
    expect(transport.contents).toEqual([]);
  });
});
