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
  /** Only authorized controller conversations may receive instance-wide state. */
  listActiveThreads?(id: ThreadId): Promise<ReadonlyArray<OrchestrationThread> | null>;
  listWorkers?(id: ThreadId): Promise<ReadonlyArray<OrchestrationThread>>;
  createWorker?(command: TurnStart, sourceContext?: string): Promise<ThreadId>;
  /** Durable inbox already imported the user message. */
  inputAccepted?: boolean;
}
const WorkerPlan = Schema.Struct({
  type: Schema.Literal("router.worker.create"),
  command: OrchestrationCommand,
  sourceContext: Schema.optional(Schema.String),
  reply: Schema.optional(Schema.String),
});
const PlannedCommand = Schema.Union([OrchestrationCommand, WorkerPlan]);
type PlannedCommand = typeof PlannedCommand.Type;
const SavedDispatch = Schema.Struct({
  replyCreatedAt: Schema.optional(Schema.String),
  presentationVersion: Schema.optional(Schema.Literal(1)),
  followup: Schema.optional(Schema.Boolean),
  fingerprint: Schema.String,
  commands: Schema.Array(PlannedCommand),
  resultSequence: Schema.optional(Schema.Number),
  workerId: Schema.optional(ThreadId),
  sourceThreadId: Schema.optional(ThreadId),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const statusQuestion =
  /^(?:(?:现在|目前|当前)?(?:任务|工作|优化|这个任务|这项工作)?(?:进度如何|进度怎么样|做到哪了|做到哪一步了|进展如何|进展怎么样|还在吗|还在运行吗|卡住了吗|怎么样了|查好了吗|查完了吗|做好了吗|完成了吗)|status|progress|are you still (?:there|working)|how(?:'s| is) (?:it|the task) going)$/i;
export function isRouterStatusQuestion(text: string) {
  const normalized = text.trim().replace(/[？?！!。.]$/u, "");
  // Match the whole utterance: a status question plus an action must not lose the action.
  return statusQuestion.exec(normalized)?.[0] === normalized;
}
/** Whole utterances only: never swallow an appended action. */
export function isRouterGlobalStatusQuestion(text: string) {
  const normalized = text
    .trim()
    .replace(/[？?！!。.]$/u, "")
    .replace(/\s+/gu, " ");
  return (
    /^(?:现在|目前|当前)?\s*(?:Metis\s*)?(?:有(?:哪些)?|有什么)(?:正在进行|进行中|正在运行|运行中)的\s*(?:Metis\s*)?(?:会话|任务)(?:吗|么)?$/iu.test(
      normalized,
    ) ||
    /^(?:列出|查看)(?:所有|全部)(?:正在进行|进行中|正在运行|运行中)的\s*(?:Metis\s*)?(?:会话|任务)$/iu.test(
      normalized,
    ) ||
    /^(?:list|show)(?: all)? (?:active|running) (?:sessions|threads|tasks)$/iu.test(normalized)
  );
}

export function isRouterCancelRequest(text: string) {
  return /^(?:停|停下|停止|暂停|停一下|停止当前任务|暂停当前任务|取消当前任务|stop|pause|cancel(?: the)? (?:current )?task)[。.!！]?$/iu.test(
    text.trim(),
  );
}
function isRouterPriorityRequest(text: string) {
  const targeted = /^(?:任务|task)\s+\S+\s+([\s\S]+)$/iu.exec(text.trim());
  const action = targeted?.[1] ?? text;
  return (
    isRouterStatusQuestion(action) ||
    isRouterGlobalStatusQuestion(text) ||
    isRouterCancelRequest(action)
  );
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
  return `任务状态：${state}。\n最近状态更新时间：${thread.session?.updatedAt ?? thread.updatedAt}。${activity ? `\n最近活动：${activity.summary.slice(0, 500)}` : ""}${latest ? `\n最近回复：\n${latest.text.slice(-1200)}` : ""}\n这是已记录的状态，不能仅凭没有新输出判断任务卡住。`;
}

/** Independent of provider turn locks. Only finalized plans are persisted; an RPC
 * is acknowledged after engine receipts exist, so unfinished requests can be retried.
 * Saved plans make retries/restarts replay the same commands instead of reclassifying.
 */
export class AgentRouter {
  private readonly requests = new Map<
    string,
    { fingerprint: string; command: TurnStart; result: Promise<DispatchResult> }
  >();
  private readonly lanes = new Map<string, Promise<unknown>>();
  constructor(private readonly stateRoot: string) {}

  /** Server-owned transport metadata, independent of user-visible wording. */
  async readDelivery(command: TurnStart) {
    try {
      const receipt = Schema.decodeUnknownSync(SavedDispatch)(
        JSON.parse(
          await readFile(path.join(this.stateRoot, `${hash(command.commandId)}.json`), "utf8"),
        ),
      );
      if (
        receipt.fingerprint !== fingerprintOrchestrationCommand(command).value ||
        receipt.sourceThreadId !== command.threadId ||
        receipt.presentationVersion !== 1
      )
        return;
      return { workerId: receipt.workerId, followup: receipt.followup ?? false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

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
    // Classify concurrently: a slow model request must not block later chat.
    // Only task-changing effects wait for earlier requests in the conversation.
    const priority = isRouterPriorityRequest(command.message.text);
    const previous = priority ? undefined : this.lanes.get(command.threadId);
    const predecessors = [...this.requests.values()].filter(
      (entry) => entry.command.threadId === command.threadId,
    );
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const result = this.run(command, fingerprint, key, host, timings, previous, predecessors);
    void result
      .then(
        () =>
          Effect.runPromise(
            Effect.logInfo("Router dispatch completed", {
              commandId: command.commandId,
              threadId: command.threadId,
              elapsedMs: Date.now() - startedAt,
              ...timings,
            }),
          ),
        () =>
          Effect.runPromise(
            Effect.logWarning("Router dispatch failed", {
              commandId: command.commandId,
              threadId: command.threadId,
              elapsedMs: Date.now() - startedAt,
              ...timings,
            }),
          ),
      )
      .catch(() => undefined);
    const lane = Promise.allSettled([previous, result]);
    this.requests.set(key, { fingerprint, command, result });
    if (!priority) this.lanes.set(command.threadId, lane);
    void result.finally(() => this.requests.delete(key)).catch(() => undefined);
    void lane.then(() => {
      if (this.lanes.get(command.threadId) === lane) this.lanes.delete(command.threadId);
    });
    return result;
  }

  private async run(
    command: TurnStart,
    fingerprint: string,
    key: string,
    host: AgentRouterHost,
    timings: Record<string, number>,
    previous?: Promise<unknown>,
    predecessors: Array<{ command: TurnStart; result: Promise<DispatchResult> }> = [],
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
      const planStartedAt = Date.now();
      let commands: ReadonlyArray<PlannedCommand>;
      try {
        commands = await this.plan(command, thread, host, key, predecessors);
      } finally {
        timings.planMs = Date.now() - planStartedAt;
      }
      saved = {
        fingerprint,
        commands,
        presentationVersion: 1,
        sourceThreadId: command.threadId,
        replyCreatedAt: new Date().toISOString(),
      };
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: JSON.stringify(saved) }),
      );
    }
    const waitStartedAt = Date.now();
    if (saved.commands.some((planned) => planned.type !== "thread.messages.import"))
      await previous?.catch(() => undefined);
    timings.queueWaitMs = Date.now() - waitStartedAt;
    const executionStartedAt = Date.now();
    let workerBinding = saved.workerId;
    let result: DispatchResult = { sequence: 0 };
    for (const planned of saved.commands) {
      if (planned.type !== "router.worker.create") {
        result = await host.dispatch(planned);
        if (planned.type === "thread.turn.start" && planned.threadId !== command.threadId) {
          workerBinding = planned.threadId;
          // Save the acknowledged binding before publishing the conversational reply.
          saved = {
            ...saved,
            workerId: workerBinding,
            followup: true,
            sourceThreadId: command.threadId,
          };
          await Effect.runPromise(
            writeFileStringAtomically({ filePath, contents: JSON.stringify(saved) }),
          );
        }
        continue;
      }
      if (!host.createWorker || planned.command.type !== "thread.turn.start")
        throw new Error("Router worker service unavailable.");
      const workerId = await host.createWorker(planned.command, planned.sourceContext);
      workerBinding = workerId;
      saved = {
        ...saved,
        workerId,
        sourceThreadId: command.threadId,
        // Old in-flight receipts must replay their original command fingerprint.
        replyCreatedAt: saved.replyCreatedAt ?? command.createdAt,
      };
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: JSON.stringify(saved) }),
      );
      result = await host.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`router-worker-reply-${key}`),
        threadId: command.threadId,
        createdAt: saved.replyCreatedAt!,
        messages: [
          {
            messageId: MessageId.makeUnsafe(`router-${key}`),
            role: "assistant",
            text:
              planned.reply ??
              (saved.presentationVersion === 1
                ? "我会按你的要求处理，有结果后在这里告诉你。"
                : `已创建独立任务 [${workerId}](/tasks?thread=${encodeURIComponent(workerId)})。可继续在这里聊天；打开任务可查看进度、修改要求或取消。任务完成后会通知此会话。`),
            createdAt: saved.replyCreatedAt!,
            updatedAt: saved.replyCreatedAt!,
          },
        ],
      });
    }
    timings.executionMs = Date.now() - executionStartedAt;
    // Retain only the receipt after acknowledgement, not another copy of chat text.
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({
          fingerprint,
          presentationVersion: saved.presentationVersion,
          followup: saved.followup,
          commands: [],
          resultSequence: result.sequence,
          workerId: workerBinding,
          sourceThreadId: command.threadId,
        }),
      }),
    );
    return result;
  }

  private async plan(
    command: TurnStart,
    thread: OrchestrationThread,
    host: AgentRouterHost,
    key: string,
    predecessors: Array<{ command: TurnStart; result: Promise<DispatchResult> }>,
  ): Promise<ReadonlyArray<PlannedCommand>> {
    const { routingMode: _, routerSourceCommandId: _sourceReference, ...workerCommand } = command;
    const { providerOptions: _workerOptions, ...correctionCommand } = workerCommand;
    const workerPlan = (response?: string): PlannedCommand => ({
      ...(response?.trim() ? { reply: response.trim() } : {}),
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
    const reply = (text: string, includeUser = !host.inputAccepted): OrchestrationCommand => {
      const repliedAt = new Date().toISOString();
      return {
        type: "thread.messages.import",
        commandId: includeUser ? command.commandId : CommandId.makeUnsafe(`router-reply-${key}`),
        threadId: command.threadId,
        createdAt: repliedAt,
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
            createdAt: repliedAt,
            updatedAt: repliedAt,
          },
        ],
      };
    };
    if (!canRouteTurn(command)) return [workerCommand];
    if (
      !command.routerSourceCommandId &&
      /^(?:你好|您好|在吗|在不在|hello|hi|hey)[？?！!。\s]*$/iu.test(command.message.text.trim())
    ) {
      return [reply("我在，收到你的消息了。")];
    }
    if (!command.routerSourceCommandId && isRouterGlobalStatusQuestion(command.message.text)) {
      const threads = await host.listActiveThreads?.(thread.id);
      if (!threads) return [reply("此会话无法读取全局会话状态，请在 Metis 总控中查询。")];
      const active = threads.filter(
        (task) =>
          !task.deletedAt &&
          !task.archivedAt &&
          !task.sidechatExpiredAt &&
          (routerHasActiveTurn(task) ||
            taskControlProgress(task).pendingInteractions.length > 0 ||
            taskControlProgress(task).asyncUserInputs.length > 0),
      );
      const lines = active.slice(0, 20).map((task) => {
        const progress = taskControlProgress(task);
        const state =
          progress.pendingInteractions.length || progress.asyncUserInputs.length
            ? "等待确认或补充"
            : "运行中";
        return `- ${task.title}（${state}） /tasks?thread=${encodeURIComponent(task.id)}`;
      });
      const pending = Math.max(0, this.requests.size - 1);
      return [
        reply(
          [
            active.length
              ? `当前 Metis 有 ${active.length} 个进行中的会话：`
              : "当前 Metis 没有进行中的会话。",
            ...lines,
            ...(active.length > 20
              ? [`另有 ${active.length - 20} 个，完整列表请查看任务页面。`]
              : []),
            ...(pending ? [`另有 ${pending} 条请求正在路由或提交，尚不等同于已启动会话。`] : []),
          ].join("\n"),
        ),
      ];
    }
    const workers = host.listWorkers ? await host.listWorkers(thread.id) : [];
    const tasks = [...(routerHasActiveTurn(thread) ? [thread] : []), ...workers].filter(
      (task) => !task.deletedAt && !task.archivedAt && !task.sidechatExpiredAt,
    );
    const resolveRequest = async (id: string) => {
      const pending = predecessors.find((entry) => entry.command.commandId === id);
      if (pending) await pending.result.catch(() => undefined);
      try {
        const receipt = Schema.decodeUnknownSync(SavedDispatch)(
          JSON.parse(await readFile(path.join(this.stateRoot, `${hash(id)}.json`), "utf8")),
        );
        if (receipt.sourceThreadId !== thread.id || !receipt.workerId) return;
        const owned = host.listWorkers ? await host.listWorkers(thread.id) : [];
        return owned.find(
          (task) =>
            task.id === receipt.workerId &&
            !task.deletedAt &&
            !task.archivedAt &&
            !task.sidechatExpiredAt,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    };
    let referencedTask: OrchestrationThread | undefined;
    if (
      command.routerSourceCommandId &&
      !/^(?:新任务[：:]|new task:)/iu.test(command.message.text.trim())
    ) {
      referencedTask = await resolveRequest(command.routerSourceCommandId);
      if (!referencedTask)
        return [reply("我还无法确认你引用的是哪件事，这条补充尚未追加。请说一下要修改的内容。")];
      tasks.splice(0, tasks.length, referencedTask);
    }
    const status = () =>
      tasks.length
        ? tasks.map((task) => `${task.title}\n${routerStatusReply(task)}`).join("\n\n")
        : host.createWorker
          ? "尚无已启动任务；已受理消息可能仍在路由或创建中。"
          : routerStatusReply(thread);
    // Preserve instant progress while an earlier classifier/creation is still pending.
    if (isRouterStatusQuestion(command.message.text)) return [reply(status())];
    if (isRouterCancelRequest(command.message.text)) {
      const active = tasks.filter(routerHasActiveTurn);
      if (active.length > 1)
        return [
          reply(
            `你想停止哪件事：${active.map((task) => task.title).join("、")}？可以引用对应的消息，再说“停止”。`,
          ),
        ];
      const target = active[0];
      const turnId = target?.session?.activeTurnId;
      if (!target || !turnId) return [reply("当前没有可确认的运行中任务，未发送取消指令。")];
      return [
        {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(`router-cancel-${key}`),
          threadId: target.id,
          turnId,
          createdAt: command.createdAt,
        },
        reply("已请求停止当前任务，正在等待执行器确认。已发生的操作不会因此撤销。"),
      ];
    }
    if (
      !referencedTask &&
      host.createWorker &&
      /^(?:新任务[：:]|new task:)/iu.test(command.message.text.trim())
    )
      return [workerPlan()];
    const explicit = /^(?:任务|task)\s+(\S+)\s+([\s\S]+)$/iu.exec(command.message.text.trim());
    if (explicit) {
      const target = tasks.find((task) => task.id === explicit[1]);
      if (!target) return [reply("该任务不属于此会话或已不可用，未发送指令。")];
      if (isRouterCancelRequest(explicit[2]!)) {
        if (!routerHasActiveTurn(target) || !target.session?.activeTurnId)
          return [reply("此任务没有可确认的运行中回合。")];
        return [
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`router-cancel-${key}`),
            threadId: target.id,
            turnId: target.session.activeTurnId,
            createdAt: command.createdAt,
          },
          reply(`已请求停止“${target.title}”，正在等待停止确认。`),
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
        referencedTask || explicit
          ? {
              route: "steer",
              targetTaskId: referencedTask?.id ?? explicit![1],
              reply: "明白，我会按这条补充继续处理。",
            }
          : await host.generate({
              cwd: host.generationCwd,
              message: command.message.text,
              modelSelection: thread.modelSelection,
              ...(command.providerOptions ? { providerOptions: command.providerOptions } : {}),
              taskContext: JSON.stringify({
                pendingRequests: predecessors.map((entry) => ({
                  id: `pending:${entry.command.commandId}`,
                  request: entry.command.message.text.slice(0, 2000),
                  createdAt: entry.command.createdAt,
                })),
                tasks: tasks.slice(-20).map((task) => ({
                  id: task.id,
                  title: task.title,
                  originalRequest: task.messages
                    .find((m) => m.role === "user")
                    ?.text.slice(0, 2000),
                  latestInput: task.messages
                    .findLast((m) => m.role === "user")
                    ?.text.slice(0, 1000),
                  state: task.session?.status,
                  pendingInteractions: taskControlProgress(task).pendingInteractions.length,
                  pendingUserInputs: taskControlProgress(task).asyncUserInputs.length,
                  latestActivity: task.activities.at(-1)?.summary.slice(0, 500),
                  updatedAt: task.session?.updatedAt ?? task.updatedAt,
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
    if (decision.route === "status") return [reply(decision.reply.trim() || status())];
    if (decision.route === "reply" && decision.reply.trim()) return [reply(decision.reply.trim())];
    if (decision.route === "steer") {
      const selectedPending = predecessors.find(
        (entry) => `pending:${entry.command.commandId}` === decision.targetTaskId,
      );
      // Semantic selection may resolve one target among several owned tasks.
      if (selectedPending) {
        const resolved = await resolveRequest(selectedPending.command.commandId);
        if (!resolved)
          return [reply("前一条请求还没有成功安排，这条补充尚未追加。请说明要继续处理的内容。")];
        if (!tasks.some((task) => task.id === resolved.id)) tasks.push(resolved);
        decision = { ...decision, targetTaskId: resolved.id };
      }
      const target = decision.targetTaskId
        ? tasks.find((task) => task.id === decision.targetTaskId)
        : tasks.length === 1
          ? tasks[0]
          : undefined;
      if (!target) return [reply("请指定要修改的任务，当前没有唯一可确认的目标。")];
      const latest = await host.readThread(target.id);
      if (
        !latest ||
        latest.deletedAt ||
        latest.archivedAt ||
        latest.sidechatExpiredAt ||
        latest.session?.activeTurnId !== target.session?.activeTurnId
      )
        return [reply("目标任务的运行状态已改变，这条修改尚未发送。请确认任务后重新发送。")];
      const active = routerHasActiveTurn(latest);
      if (active && !target.session?.activeTurnId) return [reply("任务正在启动，请稍后重试修改。")];
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
          decision.reply.trim() ||
            (steer
              ? "明白，我会按这条补充继续处理。"
              : "收到这条补充，我会在当前这一步结束后继续处理。"),
          false,
        ),
      ];
    }
    if (host.createWorker) {
      if (failed)
        return [
          reply(
            "独立响应通道暂时不可用或超时，消息未交给执行器。请重试；明确的新任务可用「新任务：…」直接提交。",
          ),
        ];
      return [workerPlan(decision.reply)];
    }
    return [
      { ...workerCommand, dispatchMode: "queue" },
      reply(
        failed
          ? "独立响应通道暂时不可用或超时，这条消息已交给任务队列。"
          : decision.reply.trim() || "我会按你的要求继续处理。",
        false,
      ),
    ];
  }
}
