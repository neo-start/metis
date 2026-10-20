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
  resources: [];
};
const transport = vi.hoisted(() => ({
  receive: undefined as ((message: Inbound) => Promise<void>) | undefined,
  beforeStream: async () => {},
  contents: [] as string[],
  send: vi.fn(async () => {}),
  getResource: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu" },
  LoggerLevel: { warn: "warn" },
  createLarkChannel: () => ({
    on: (event: string, handler: (message: Inbound) => Promise<void>) => {
      if (event === "message") transport.receive = handler;
    },
    connect: async () => {},
    disconnect: async () => {},
    send: transport.send,
    rawClient: { im: { v1: { messageResource: { get: transport.getResource } } } },
    stream: async (
      _chat: string,
      input: {
        markdown: (controller: { setContent: (text: string) => Promise<void> }) => Promise<void>;
      },
    ) => {
      await transport.beforeStream();
      await input.markdown({
        setContent: async (text) => {
          transport.contents.push(text);
        },
      });
    },
  }),
}));

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  transport.receive = undefined;
  transport.contents.length = 0;
  transport.beforeStream = async () => {};
  vi.clearAllMocks();
});

async function setup() {
  const runtimeLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
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
  const bridge = await runtime.runPromise(
    makeFeishuBridge.pipe(Effect.provideService(MetisControllerService, controller)),
  );
  await runtime.runPromise(Scope.provide(bridge.start(), scope));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
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
  return { runtime, controller, selection, engine, dispatch, complete, receive, mapPath };
}

describe("Feishu instance-controller routing with real orchestration", () => {
  it("follows /clear, preserves controller settings and deduplicates across conversation rotation", async () => {
    const f = await setup();
    const first = (await f.controller.overview()).threadId!;
    transport.beforeStream = () => f.complete("第一轮回复");
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
    transport.beforeStream = () => f.complete("新总控回复");
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
    transport.beforeStream = async () => {
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
