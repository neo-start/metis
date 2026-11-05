import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  CommandId,
  MessageId,
  OrchestrationCommand,
  type OrchestrationThread,
  ThreadId,
} from "@synara/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import { RouterDecision } from "../git/routerPrompt.ts";
import type {
  RouterGenerationInput,
  RouterGenerationResult,
} from "../git/Services/TextGeneration.ts";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { taskControlProgress } from "../taskControl/service.ts";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type DispatchResult = { sequence: number };
export interface AgentRouterHost {
  readThread(id: ThreadId): Promise<OrchestrationThread | null>;
  generate(input: RouterGenerationInput): Promise<RouterGenerationResult>;
  dispatch(command: OrchestrationCommand): Promise<DispatchResult>;
  /** An empty, private working directory, not the user's repository. */
  generationCwd: string;
  listWorkers?(id: ThreadId): Promise<ReadonlyArray<OrchestrationThread>>;
  createWorker?(command: TurnStart, sourceContext?: string): Promise<ThreadId>;
  /** Durable inbox already imported the user message. */
  inputAccepted?: boolean;
}
const WorkerPlan = Schema.Struct({
  type: Schema.Literal("router.worker.create"),
  command: OrchestrationCommand,
  sourceContext: Schema.optional(Schema.String),
});
const PlannedCommand = Schema.Union([OrchestrationCommand, WorkerPlan]);
type PlannedCommand = typeof PlannedCommand.Type;
const SavedDispatch = Schema.Struct({
  fingerprint: Schema.String,
  commands: Schema.Array(PlannedCommand),
  resultSequence: Schema.optional(Schema.Number),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const statusQuestion =
  /^(?:现在|目前|任务)?(?:进度如何|进度怎么样|做到哪了|做到哪一步了|进展如何|还在吗|还在运行吗|卡住了吗|怎么样了)|^(?:status|progress|are you still (?:there|working)|how(?:'s| is) (?:it|the task) going)$/i;
export function isRouterStatusQuestion(text: string) {
  const normalized = text.trim().replace(/[？?！!。.]$/u, "");
  // Match the whole utterance: a status question plus an action must not lose the action.
  return statusQuestion.exec(normalized)?.[0] === normalized;
}
export function isRouterCancelRequest(text: string) {
  return /^(?:停止|暂停|停一下|停止当前任务|暂停当前任务|取消当前任务|stop|pause|cancel(?: the)? (?:current )?task)[。.!！]?$/iu.test(
    text.trim(),
  );
}
function isRouterPriorityRequest(text: string) {
  const targeted = /^(?:任务|task)\s+\S+\s+([\s\S]+)$/iu.exec(text.trim());
  const action = targeted?.[1] ?? text;
  return isRouterStatusQuestion(action) || isRouterCancelRequest(action);
}
export function routerHasActiveTurn(thread: OrchestrationThread) {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running"
  );
}
export function canRouteTurn(command: TurnStart) {
  return (
    command.routingMode === "auto" &&
    !command.asyncUserInputResponse &&
    command.message.attachments.length === 0 &&
    !command.message.skills?.length &&
    !command.message.mentions?.length &&
    !command.reviewTarget &&
    !command.sourceProposedPlan &&
    command.computerControlMode !== "request" &&
    !command.enableComputerControl
  );
}
export function routerStatusReply(thread: OrchestrationThread) {
  const progress = taskControlProgress(thread);
  const latest = thread.messages.findLast(
    (message) =>
      message.role === "assistant" && !message.id.startsWith("router-") && message.text.trim(),
  );
  const activity = thread.activities.findLast((entry) => !entry.kind.startsWith("router."));
  const state =
    progress.pendingInteractions.length || progress.asyncUserInputs.length
      ? "正在等待你的确认或补充信息"
      : routerHasActiveTurn(thread)
        ? "任务仍在运行"
        : "当前没有正在执行的任务";
  return `Router 状态：${state}。\n最近状态更新时间：${thread.session?.updatedAt ?? thread.updatedAt}。${activity ? `\n最近活动：${activity.summary.slice(0, 500)}` : ""}${latest ? `\n最近回复：\n${latest.text.slice(-1200)}` : ""}\n这是已记录的状态，不能仅凭没有新输出判断任务卡住。`;
}

/** Independent of provider turn locks. Only finalized plans are persisted; an RPC
 * is acknowledged after engine receipts exist, so unfinished requests can be retried.
 * Saved plans make retries/restarts replay the same commands instead of reclassifying.
 */
export class AgentRouter {
  private readonly requests = new Map<
    string,
    { fingerprint: string; result: Promise<DispatchResult> }
  >();
  private readonly lanes = new Map<string, Promise<unknown>>();
  constructor(private readonly stateRoot: string) {}

  dispatch(command: TurnStart, host: AgentRouterHost): Promise<DispatchResult> {
    const fingerprint = fingerprintOrchestrationCommand(command).value;
    const key = hash(command.commandId);
    const pending = this.requests.get(key);
    if (pending)
      return pending.fingerprint === fingerprint
        ? pending.result
        : Promise.reject(new Error("Router commandId is already bound to different content."));
    if (this.requests.size >= 32)
      return Promise.reject(new Error("Router is busy. Please retry shortly."));
    // Progress never waits for model generation. Other follow-ups preserve their arrival order.
    const previous = isRouterPriorityRequest(command.message.text)
      ? undefined
      : this.lanes.get(command.threadId);
    const result = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.run(command, fingerprint, key, host));
    this.requests.set(key, { fingerprint, result });
    if (!isRouterPriorityRequest(command.message.text)) this.lanes.set(command.threadId, result);
    void result
      .finally(() => {
        this.requests.delete(key);
        if (this.lanes.get(command.threadId) === result) this.lanes.delete(command.threadId);
      })
      .catch(() => undefined);
    return result;
  }

  private async run(
    command: TurnStart,
    fingerprint: string,
    key: string,
    host: AgentRouterHost,
  ): Promise<DispatchResult> {
    const filePath = path.join(this.stateRoot, `${key}.json`);
    let saved: typeof SavedDispatch.Type | undefined;
    try {
      saved = Schema.decodeUnknownSync(SavedDispatch)(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved && saved.fingerprint !== fingerprint)
      throw new Error("Router commandId is already bound to different content.");
    if (saved?.resultSequence !== undefined) return { sequence: saved.resultSequence };
    const thread = await host.readThread(command.threadId);
    if (!thread || thread.deletedAt || thread.archivedAt || thread.sidechatExpiredAt) {
      throw new Error("Router target conversation is unavailable.");
    }
    if (!saved) {
      const commands = await this.plan(command, thread, host, key);
      saved = { fingerprint, commands };
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: JSON.stringify(saved) }),
      );
    }
    let result: DispatchResult = { sequence: 0 };
    for (const planned of saved.commands) {
      if (planned.type !== "router.worker.create") {
        result = await host.dispatch(planned);
        continue;
      }
      if (!host.createWorker || planned.command.type !== "thread.turn.start")
        throw new Error("Router worker service unavailable.");
      const workerId = await host.createWorker(planned.command, planned.sourceContext);
      result = await host.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`router-worker-reply-${key}`),
        threadId: command.threadId,
        createdAt: command.createdAt,
        messages: [
          {
            messageId: MessageId.makeUnsafe(`router-${key}`),
            role: "assistant",
            text: `Router：已创建独立任务 [${workerId}](/tasks?thread=${encodeURIComponent(workerId)})。可继续在这里聊天；打开任务可查看进度、修改要求或取消。任务完成后会通知此会话。`,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        ],
      });
    }
    // Retain only the receipt after acknowledgement, not another copy of chat text.
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({ fingerprint, commands: [], resultSequence: result.sequence }),
      }),
    );
    return result;
  }

  private async plan(
    command: TurnStart,
    thread: OrchestrationThread,
    host: AgentRouterHost,
    key: string,
  ): Promise<ReadonlyArray<PlannedCommand>> {
    const { routingMode: _, ...workerCommand } = command;
    const { providerOptions: _workerOptions, ...correctionCommand } = workerCommand;
    const workerPlan = (): PlannedCommand => ({
      type: "router.worker.create",
      command: workerCommand,
      sourceContext: JSON.stringify({
        sourceThreadId: thread.id,
        title: thread.title,
        messages: thread.messages
          .filter((message) => message.id !== command.message.messageId)
          .slice(-12)
          .map(({ role, text }) => ({ role, text: text.slice(-2000) })),
      }),
    });
    const reply = (text: string, includeUser = !host.inputAccepted): OrchestrationCommand => ({
      type: "thread.messages.import",
      commandId: includeUser ? command.commandId : CommandId.makeUnsafe(`router-reply-${key}`),
      threadId: command.threadId,
      createdAt: command.createdAt,
      messages: [
        ...(includeUser
          ? [
              {
                messageId: command.message.messageId,
                role: "user" as const,
                text: command.message.text,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            ]
          : []),
        {
          messageId: MessageId.makeUnsafe(`router-${key}`),
          role: "assistant",
          text,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      ],
    });
    if (!canRouteTurn(command)) return [workerCommand];
    const workers = host.listWorkers ? await host.listWorkers(thread.id) : [];
    const tasks = [...(routerHasActiveTurn(thread) ? [thread] : []), ...workers].filter(
      (task) => !task.deletedAt && !task.archivedAt,
    );
    const status = () =>
      tasks.length
        ? tasks
            .map(
              (task) =>
                `[${task.title}](/tasks?thread=${encodeURIComponent(task.id)}) · ${task.id}\n${routerStatusReply(task)}`,
            )
            .join("\n\n")
        : host.createWorker
          ? "Router：尚无已启动任务；已受理消息可能仍在路由或创建中。"
          : routerStatusReply(thread);
    if (isRouterStatusQuestion(command.message.text)) return [reply(status())];
    if (isRouterCancelRequest(command.message.text)) {
      const active = tasks.filter(routerHasActiveTurn);
      if (active.length > 1)
        return [
          reply("Router：有多个运行中任务，请打开需要停止的任务，或发送 `任务 <任务ID> 停止`。"),
        ];
      const target = active[0];
      const turnId = target?.session?.activeTurnId;
      if (!target || !turnId)
        return [reply("Router：当前没有可确认的运行中任务，未发送取消指令。")];
      return [
        {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(`router-cancel-${key}`),
          threadId: target.id,
          turnId,
          createdAt: command.createdAt,
        },
        reply("Router：已请求停止当前任务，正在等待执行器确认。已发生的操作不会因此撤销。"),
      ];
    }
    if (host.createWorker && /^(?:新任务[：:]|new task:)/iu.test(command.message.text.trim()))
      return [workerPlan()];
    const explicit = /^(?:任务|task)\s+(\S+)\s+([\s\S]+)$/iu.exec(command.message.text.trim());
    if (explicit) {
      const target = tasks.find((task) => task.id === explicit[1]);
      if (!target) return [reply("Router：该任务不属于此会话或已不可用，未发送指令。")];
      if (isRouterCancelRequest(explicit[2]!)) {
        if (!routerHasActiveTurn(target) || !target.session?.activeTurnId)
          return [reply("Router：此任务没有可确认的运行中回合。")];
        return [
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`router-cancel-${key}`),
            threadId: target.id,
            turnId: target.session.activeTurnId,
            createdAt: command.createdAt,
          },
          reply(`Router：已请求停止任务 ${target.id}，等待执行器确认。`),
        ];
      }
      if (isRouterStatusQuestion(explicit[2]!)) return [reply(routerStatusReply(target))];
    }
    if (!explicit && host.createWorker && command.message.text.length > 16000)
      return [workerPlan()];
    if (!host.createWorker && !routerHasActiveTurn(thread)) return [workerCommand];
    // A provider/model/permission switch remains an ordinary worker operation.
    if (
      !explicit &&
      (command.runtimeMode !== thread.runtimeMode ||
        command.interactionMode !== thread.interactionMode ||
        (command.modelSelection &&
          JSON.stringify(command.modelSelection) !== JSON.stringify(thread.modelSelection)))
    )
      return host.createWorker ? [workerPlan()] : [workerCommand];
    let decision: RouterGenerationResult;
    let failed = false;
    try {
      decision = Schema.decodeUnknownSync(RouterDecision)(
        explicit
          ? { route: "steer", targetTaskId: explicit[1], reply: "" }
          : await host.generate({
              cwd: host.generationCwd,
              message: command.message.text,
              modelSelection: thread.modelSelection,
              ...(command.providerOptions ? { providerOptions: command.providerOptions } : {}),
              taskContext: JSON.stringify({
                tasks: tasks.slice(-20).map((task) => ({
                  id: task.id,
                  title: task.title,
                  state: task.session?.status,
                  latestTurn: task.latestTurn,
                  latestOutput: task.messages
                    .findLast((m) => m.role === "assistant")
                    ?.text.slice(-1000),
                })),
                title: thread.title,
                state: thread.session?.status,
                latestTurn: thread.latestTurn,
                conversation: thread.messages
                  .slice(-8)
                  .map(({ role, text }) => ({ role, text: text.slice(-2000) })),
                activity: thread.activities
                  .slice(-4)
                  .map(({ kind, summary }) => ({ kind, summary: summary.slice(0, 500) })),
              }),
            }),
      );
    } catch {
      failed = true;
      decision = { route: "queue", reply: "" };
    }
    const current = await host.readThread(command.threadId);
    if (!current || current.deletedAt || current.archivedAt || current.sidechatExpiredAt)
      throw new Error("Router target conversation is unavailable.");
    if (decision.route === "status") return [reply(status())];
    if (decision.route === "reply" && decision.reply.trim())
      return [reply(`Router：\n${decision.reply.trim()}`)];
    if (decision.route === "steer") {
      const target = decision.targetTaskId
        ? tasks.find((task) => task.id === decision.targetTaskId)
        : tasks.length === 1
          ? tasks[0]
          : undefined;
      if (!target) return [reply("Router：请指定要修改的任务，当前没有唯一可确认的目标。")];
      const latest = await host.readThread(target.id);
      if (
        !latest ||
        latest.deletedAt ||
        latest.archivedAt ||
        latest.sidechatExpiredAt ||
        latest.session?.activeTurnId !== target.session?.activeTurnId
      )
        return [
          reply("Router：目标任务的运行状态已改变，这条修改尚未发送。请确认任务后重新发送。"),
        ];
      const active = routerHasActiveTurn(latest);
      if (active && !target.session?.activeTurnId)
        return [reply("Router：任务正在启动，请稍后重试修改。")];
      const steer =
        active &&
        providerSupportsNativeTurnSteering(
          latest.session?.providerName ?? latest.modelSelection.provider,
        );
      // Unsupported native steering remains scoped to that worker's queue, never to the console.
      return [
        {
          ...correctionCommand,
          threadId: target.id,
          modelSelection: latest.modelSelection,
          runtimeMode: latest.runtimeMode,
          interactionMode: latest.interactionMode,
          dispatchMode: steer ? "steer" : "queue",
          ...(steer ? { routerTurnId: target.session!.activeTurnId! } : {}),
        },
        reply(
          steer
            ? `Router：已向任务 ${target.id} 提交修改，等待执行器接收。这不代表修改已经完成。`
            : `Router：修改已加入任务 ${target.id} 的队列。`,
          false,
        ),
      ];
    }
    if (host.createWorker) {
      if (failed)
        return [
          reply(
            "Router：独立响应通道暂时不可用或超时，消息未交给执行器。请重试；明确的新任务可用「新任务：…」直接提交。",
          ),
        ];
      return [workerPlan()];
    }
    return [
      { ...workerCommand, dispatchMode: "queue" },
      reply(
        failed
          ? "Router：独立响应通道暂时不可用或超时，这条消息已交给任务队列。"
          : "Router：这条消息需要任务执行，已交给任务队列。",
        false,
      ),
    ];
  }
}
