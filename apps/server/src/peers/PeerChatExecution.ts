import { createHash } from "node:crypto";
import { formatAsyncUserInputResponse } from "@synara/shared/asyncUserInput";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type PeerChatReply,
  type PeerChatRequest,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { MetisControllerService } from "../metis/MetisControllerService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";

export interface PeerChatExecution {
  handle(peerId: string, request: PeerChatRequest): Promise<PeerChatReply>;
  revoke(peerId: string): Promise<void>;
}

/** Resolve every command through an owned conversation binding. No caller-selected
 * thread id, project, provider, permission mode or management RPC crosses this boundary. */
export const makePeerChatExecution = Effect.gen(function* () {
  const controller = yield* MetisControllerService;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  return {
    revoke: (peerId) => controller.revokePeer(peerId),
    handle: async (peerId, request) => {
      const list = async (): Promise<PeerChatReply> => ({
        controllerId: controller.identity.id,
        chats: await Promise.all(
          (await controller.peerChats(peerId)).map(async ({ id, title, createdAt }) => {
            const threadId = await controller.peerChatThread(peerId, id);
            const shell = Option.getOrUndefined(
              await run(query.getThreadShellById(ThreadId.makeUnsafe(threadId))),
            );
            return { id, title: shell?.title.replace(/^Remote · /, "") ?? title, createdAt };
          }),
        ),
      });
      if (request.action === "chat.list") return list();
      if (request.action === "chat.open") {
        const chat = await controller.openPeerChat(peerId, request.id, request.title);
        return { ...(await list()), chatId: chat.id };
      }
      const commandId =
        "id" in request ? CommandId.makeUnsafe(`peer:chat:${peerId}:${request.id}`) : null;
      const receipt = commandId
        ? Option.getOrUndefined(await run(receipts.getByCommandId({ commandId })))
        : undefined;
      if (receipt?.status === "rejected") throw new Error(receipt.error ?? "远端操作被拒绝。");
      // Archive retries arrive after the active binding has deliberately been closed.
      if (receipt?.status === "accepted" && request.action === "chat.archive") {
        await controller.updatePeerChat(peerId, request.chatId);
        return { ...(await list()), chatId: request.chatId };
      }
      const threadId = ThreadId.makeUnsafe(await controller.peerChatThread(peerId, request.chatId));
      const detail = Option.getOrUndefined(await run(query.getThreadDetailById(threadId)));
      if (!detail) throw new Error("远端对话不存在。");
      if (request.action === "chat.read") {
        const end =
          request.before === undefined
            ? detail.messages.length
            : detail.messages.findIndex((message) => message.id === request.before);
        if (end < 0) throw new Error("历史分页位置已失效，请刷新对话。");
        const start = Math.max(0, end - 60);
        const thread = {
          ...detail,
          messages: detail.messages.slice(start, end),
          activities: detail.activities.slice(-600),
        };
        const revision = createHash("sha256").update(JSON.stringify(thread)).digest("hex");
        return {
          controllerId: controller.identity.id,
          chats: [],
          chatId: request.chatId,
          revision,
          ...(revision === request.revision ? {} : { thread }),
          before: start > 0 ? detail.messages[start]!.id : null,
        };
      }
      if (receipt?.status !== "accepted") {
        const createdAt = new Date().toISOString();
        const common = { commandId: commandId!, threadId, createdAt };
        if (request.action === "chat.send") {
          await run(
            engine.dispatch({
              ...common,
              type: "thread.turn.start",
              dispatchMode: "queue",
              runtimeMode: detail.runtimeMode,
              interactionMode: detail.interactionMode,
              message: {
                messageId: MessageId.makeUnsafe(commandId!),
                role: "user",
                text: request.text,
                attachments: [],
              },
            }),
          );
        } else if (request.action === "chat.async-answer") {
          const input = detail.messages.find(
            (message) => message.id === request.messageId,
          )?.asyncUserInput;
          if (!input) throw new Error("该问题已不可用。");
          if (!input.response)
            await run(
              engine.dispatch({
                ...common,
                type: "thread.turn.start",
                dispatchMode: "steer",
                runtimeMode: detail.runtimeMode,
                interactionMode: detail.interactionMode,
                message: {
                  messageId: MessageId.makeUnsafe(commandId!),
                  role: "user",
                  text: formatAsyncUserInputResponse(input.questions, request.answers),
                  attachments: [],
                },
                asyncUserInputResponse: {
                  messageId: MessageId.makeUnsafe(request.messageId),
                  answers: [...request.answers],
                },
              }),
            );
        } else if (request.action === "chat.stop") {
          if (detail.latestTurn?.turnId !== request.turnId || detail.latestTurn.state !== "running")
            throw new Error("这轮执行已经结束，请刷新后再操作。");
          await run(
            engine.dispatch({
              ...common,
              type: "thread.turn.interrupt",
              turnId: TurnId.makeUnsafe(request.turnId),
            }),
          );
        } else if (request.action === "chat.rename") {
          await run(
            engine.dispatch({
              ...common,
              type: "thread.meta.update",
              title: `Remote · ${request.title.slice(0, 120)}`,
            }),
          );
        } else if (request.action === "chat.archive") {
          if (
            detail.latestTurn?.state === "running" ||
            detail.hasPendingApprovals ||
            detail.hasPendingUserInput
          )
            throw new Error("请先完成或停止对话中的执行，再归档。");
          await run(engine.dispatch({ ...common, type: "thread.archive" }));
        } else {
          const kind = request.action === "chat.approval" ? "approval" : "userInput";
          const pending = detail.pendingInteractions?.find(
            (entry) =>
              entry.interactionKind === kind &&
              entry.requestId === request.requestId &&
              entry.lifecycleGeneration === (request.lifecycleGeneration ?? null) &&
              !entry.resolvedAt,
          );
          if (!pending) throw new Error("该请求已经失效，请刷新对话。");
          const response = {
            ...common,
            requestId: ApprovalRequestId.makeUnsafe(request.requestId),
            ...(request.lifecycleGeneration
              ? { lifecycleGeneration: request.lifecycleGeneration }
              : {}),
          };
          if (request.action === "chat.approval")
            await run(
              engine.dispatch({
                ...response,
                type: "thread.approval.respond",
                decision: request.decision,
              }),
            );
          else
            await run(
              engine.dispatch({
                ...response,
                type: "thread.user-input.respond",
                answers: request.answers,
              }),
            );
        }
      }
      if (
        request.action === "chat.send" &&
        detail.title === "Remote · 新对话" &&
        (detail.messages.length === 0 ||
          detail.messages[0]?.id === MessageId.makeUnsafe(commandId!))
      ) {
        const title = request.text.replace(/\s+/g, " ").slice(0, 48);
        await run(
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`${commandId}:title`),
            threadId,
            title: `Remote · ${title}`,
          }),
        );
        await controller.updatePeerChat(peerId, request.chatId, title);
      }
      if (request.action === "chat.rename")
        await controller.updatePeerChat(peerId, request.chatId, request.title);
      if (request.action === "chat.archive")
        await controller.updatePeerChat(peerId, request.chatId);
      return { ...(await list()), chatId: request.chatId };
    },
  } satisfies PeerChatExecution;
});
