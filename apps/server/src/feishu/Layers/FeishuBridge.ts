/**
 * FeishuBridge - talk to Metis from a Feishu private chat.
 *
 * One Feishu chat is one long-lived Metis thread (the concierge). The concierge
 * is a pinned home chat, above every project: it speaks for Metis as a whole
 * and reaches into projects through the agent gateway tools. Each inbound
 * message becomes a user turn on that thread; while the provider works the
 * bridge streams the growing reply into a Feishu message, and when the turn
 * settles it sends the final answer with a link to the thread. Approval or
 * user-input requests are announced once so the user knows to answer in Metis.
 *
 * Transport is the Feishu "long connection" (outbound websocket): no public
 * callback URL, works behind NAT, reconnects on its own. Only the open ids in
 * `feishu-app.json` are answered; the SDK policy drops everyone else before the
 * handler sees them.
 *
 * @module feishu/Layers/FeishuBridge
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { OrchestrationThread, OrchestrationThreadShell } from "@synara/contracts";
import { CommandId, MessageId, ProjectId, ThreadId } from "@synara/contracts";
import { Cause, Effect, Layer, Option } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FeishuBridge, type FeishuBridgeShape } from "../Services/FeishuBridge.ts";
import {
  FEISHU_APP_CONFIG_FILENAME,
  FEISHU_CHAT_MAP_FILENAME,
  METIS_CONSOLE_FOLDER_NAME,
  METIS_CONSOLE_TITLE,
  buildThreadLink,
  formatReplyMarkdown,
  isStopCommand,
  normalizeInboundText,
  parseFeishuBridgeConfig,
  parseFeishuChatMap,
  type FeishuBridgeConfig,
} from "../feishuBridgeConfig.ts";

const TURN_POLL_MS = 1200;
const TURN_TIMEOUT_MS = 2 * 60 * 60_000;
const STREAM_MIN_CHARS = 24;

type TurnOutcome = {
  readonly status: "completed" | "error" | "interrupted";
  readonly text: string | null;
  readonly error: string | null;
};

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function assistantTextForTurn(
  thread: OrchestrationThread | undefined,
  turnId: string | null,
): string | null {
  if (!thread || turnId === null) return null;
  const message = thread.messages.findLast(
    (entry) => entry.role === "assistant" && entry.turnId === turnId,
  );
  return message?.text ?? null;
}

/** The turn our message started, once it has stopped running; null while it is still going. */
function settleTurn(
  shell: OrchestrationThreadShell | undefined,
  startedAfterIso: string,
): OrchestrationThreadShell["latestTurn"] | null {
  const turn = shell?.latestTurn ?? null;
  if (!turn || turn.requestedAt < startedAfterIso) return null;
  return turn.state === "running" ? null : turn;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const configPath = path.join(config.baseDir, FEISHU_APP_CONFIG_FILENAME);
  const chatMapPath = path.join(config.baseDir, FEISHU_CHAT_MAP_FILENAME);
  // A home chat's folder sits strictly inside the chat workspace root; that is
  // what makes the web classify it as a home chat rather than a project.
  const consoleRoot = path.join(config.chatWorkspaceRoot, METIS_CONSOLE_FOLDER_NAME);

  const log = {
    info: (message: string, data?: Record<string, unknown>) =>
      Effect.runFork(Effect.logInfo(`feishu bridge: ${message}`, data ?? {})),
    warn: (message: string, data?: Record<string, unknown>) =>
      Effect.runFork(Effect.logWarning(`feishu bridge: ${message}`, data ?? {})),
  };

  const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

  const readShell = (threadId: ThreadId) =>
    run(snapshotQuery.getThreadShellById(threadId)).then(Option.getOrUndefined);
  const readDetail = (threadId: ThreadId) =>
    run(snapshotQuery.getThreadDetailById(threadId)).then(Option.getOrUndefined);

  let chatMap = parseFeishuChatMap(readFileOrNull(chatMapPath));
  const persistChatMap = async () => {
    await run(
      writeFileStringAtomically({
        filePath: chatMapPath,
        contents: `${JSON.stringify(chatMap, null, 2)}\n`,
      }),
    );
  };

  /** The home-chat container that holds the concierge (kind "chat", never a project). */
  const ensureConsoleContainer = async (): Promise<ProjectId> => {
    mkdirSync(consoleRoot, { recursive: true });
    const existing = Option.getOrUndefined(
      await run(snapshotQuery.getActiveProjectByWorkspaceRoot(consoleRoot)),
    );
    if (existing) return existing.id;
    const projectId = ProjectId.makeUnsafe(randomUUID());
    await run(
      orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`feishu:container:${projectId}`),
        projectId,
        kind: "chat",
        title: METIS_CONSOLE_TITLE,
        workspaceRoot: consoleRoot,
        createWorkspaceRootIfMissing: true,
        createdAt: new Date().toISOString(),
      }),
    );
    return projectId;
  };

  /**
   * Switching provider in the UI hands the concierge off to a new thread and
   * archives the old one; follow that chain so the Feishu chat keeps its history.
   */
  const findHandoffSuccessor = async (threadId: ThreadId): Promise<ThreadId | undefined> => {
    const { threads } = await run(snapshotQuery.getShellSnapshot());
    let current = threadId;
    for (let hop = 0; hop < threads.length; hop += 1) {
      const next = threads.find((thread) => thread.handoff?.sourceThreadId === current);
      if (!next) return undefined;
      if (next.archivedAt == null) return next.id;
      current = next.id;
    }
    return undefined;
  };

  const ensureThreadForChat = async (
    chatId: string,
    bridgeConfig: FeishuBridgeConfig,
  ): Promise<ThreadId> => {
    const mapped = chatMap[chatId];
    if (mapped) {
      const shell = await readShell(ThreadId.makeUnsafe(mapped));
      if (shell && shell.archivedAt == null) return shell.id;
      const successor = shell ? await findHandoffSuccessor(shell.id) : undefined;
      if (successor) {
        chatMap = { ...chatMap, [chatId]: successor };
        await persistChatMap();
        log.info("concierge moved to handoff thread", { chatId, threadId: successor });
        return successor;
      }
    }
    const projectId = await ensureConsoleContainer();
    const threadId = ThreadId.makeUnsafe(`feishu-${randomUUID()}`);
    await run(
      orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`feishu:thread:${threadId}`),
        threadId,
        projectId,
        title: METIS_CONSOLE_TITLE,
        isPinned: true,
        modelSelection: bridgeConfig.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }),
    );
    chatMap = { ...chatMap, [chatId]: threadId };
    await persistChatMap();
    log.info("created concierge thread", { chatId, threadId });
    return threadId;
  };

  const waitForTurn = async (input: {
    readonly threadId: ThreadId;
    readonly startedAfterIso: string;
    readonly onProgress: (text: string) => Promise<void>;
    readonly onPendingRequest: () => Promise<void>;
  }): Promise<TurnOutcome> => {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let announcedPending = false;
    let lastProgress = "";
    for (;;) {
      const shell = await readShell(input.threadId);
      const settled = settleTurn(shell, input.startedAfterIso);
      if (settled) {
        const detail = await readDetail(input.threadId);
        const text = assistantTextForTurn(detail, settled.turnId);
        return {
          status:
            settled.state === "completed"
              ? "completed"
              : settled.state === "interrupted"
                ? "interrupted"
                : "error",
          text,
          error: settled.state === "error" ? (shell?.session?.lastError ?? null) : null,
        };
      }
      if (
        !announcedPending &&
        (shell?.hasPendingApprovals === true || shell?.hasPendingUserInput === true)
      ) {
        announcedPending = true;
        await input.onPendingRequest();
      }
      if (shell?.latestTurn && shell.latestTurn.requestedAt >= input.startedAfterIso) {
        const detail = await readDetail(input.threadId);
        const text = assistantTextForTurn(detail, shell.latestTurn.turnId) ?? "";
        if (text.length >= STREAM_MIN_CHARS && text !== lastProgress) {
          lastProgress = text;
          await input.onProgress(text);
        }
      }
      if (Date.now() >= deadline) {
        return { status: "error", text: null, error: "等了两小时还没结束，先放下了。" };
      }
      await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
    }
  };

  const currentAllowedOpenIds = (fallback: FeishuBridgeConfig): ReadonlyArray<string> => {
    const parsed = parseFeishuBridgeConfig(readFileOrNull(configPath), {});
    return parsed.kind === "ready" ? parsed.config.allowedOpenIds : fallback.allowedOpenIds;
  };

  const start: FeishuBridgeShape["start"] = Effect.fn(function* () {
    const parsed = parseFeishuBridgeConfig(readFileOrNull(configPath), {
      METIS_PUBLIC_URL: config.publicUrl?.toString(),
    });
    if (parsed.kind === "disabled") {
      yield* Effect.logInfo("feishu bridge disabled", { reason: parsed.reason });
      return;
    }
    const bridgeConfig = parsed.config;
    const sdk = yield* Effect.tryPromise({
      try: () => import("@larksuiteoapi/node-sdk"),
      catch: (cause) => new Error(`Feishu SDK failed to load: ${String(cause)}`),
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(undefined))));
    if (!sdk) return;

    const channel = sdk.createLarkChannel({
      appId: bridgeConfig.appId,
      appSecret: bridgeConfig.appSecret,
      transport: "websocket",
      domain: sdk.Domain.Feishu,
      loggerLevel: sdk.LoggerLevel.warn,
      // The allowlist is enforced in the message handler instead of the SDK
      // policy so that rejected senders are logged and edits to
      // feishu-app.json take effect without restarting Metis. open_id is
      // per-app, so an id copied from another bot never matches.
      policy: { dmMode: "open", groupAllowlist: [] },
    });

    channel.on("error", (error) => {
      log.warn("channel error", { code: error.code, message: error.message });
    });
    channel.on("reconnecting", () => log.info("reconnecting"));
    channel.on("reconnected", () => log.info("reconnected"));

    channel.on("message", async (message) => {
      if (message.chatType !== "p2p") return;
      if (!currentAllowedOpenIds(bridgeConfig).includes(message.senderId)) {
        log.warn("message from sender not in allowedOpenIds", { senderId: message.senderId });
        return;
      }
      const text = normalizeInboundText(message.content);
      if (text.length === 0 && message.resources.length === 0) return;
      try {
        const threadId = await ensureThreadForChat(message.chatId, bridgeConfig);
        const threadLink = buildThreadLink(bridgeConfig.publicOrigin, threadId);
        if (isStopCommand(text)) {
          await run(
            orchestrationEngine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe(`feishu:stop:${message.messageId}`),
              threadId,
              createdAt: new Date().toISOString(),
            }),
          );
          await channel.send(
            message.chatId,
            { text: "已叫停当前这一轮。" },
            {
              replyTo: message.messageId,
            },
          );
          return;
        }
        const startedAt = new Date().toISOString();
        const prompt =
          message.resources.length > 0
            ? `${text}\n\n（附件 ${message.resources.length} 个未随消息带入，暂只处理文字。）`
            : text;
        await run(
          orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`feishu:turn:${message.messageId}`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`feishu:${message.messageId}`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            dispatchMode: "queue",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: startedAt,
          }),
        );

        let outcome: TurnOutcome | null = null;
        await channel.stream(
          message.chatId,
          {
            markdown: async (controller) => {
              outcome = await waitForTurn({
                threadId,
                startedAfterIso: startedAt,
                onProgress: (progress) => controller.setContent(progress),
                onPendingRequest: async () => {
                  await channel.send(message.chatId, {
                    text: `Metis 在等你批准或回答一个问题，请到 Metis 里处理。${threadLink ? `\n${threadLink}` : ""}`,
                  });
                },
              });
              await controller.setContent(
                formatReplyMarkdown({
                  text: outcome.text,
                  status: outcome.status,
                  error: outcome.error,
                  threadLink,
                }),
              );
            },
          },
          { replyTo: message.messageId },
        );
      } catch (cause) {
        log.warn("failed to handle message", {
          messageId: message.messageId,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        await channel
          .send(message.chatId, {
            text: `Metis 这边出错了：${cause instanceof Error ? cause.message : String(cause)}`,
          })
          .catch(() => undefined);
      }
    });

    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => channel.disconnect()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("feishu bridge disconnect failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
    yield* Effect.tryPromise({
      try: () => channel.connect(),
      catch: (cause) => new Error(`Feishu long connection failed: ${String(cause)}`),
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    yield* Effect.logInfo("feishu bridge connected", {
      allowedOpenIds: bridgeConfig.allowedOpenIds.length,
      model: bridgeConfig.modelSelection.model,
    });
  });

  return { start } satisfies FeishuBridgeShape;
});

export const FeishuBridgeLive = Layer.effect(FeishuBridge, make);
