import fs from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { ThreadId, TurnId } from "@synara/contracts";
import { ServerConfig } from "../config.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { FeishuMedia } from "./FeishuMedia.ts";
import { makeFeishuMediaFiles } from "./feishuMediaFiles.ts";
import { FeishuMediaError, makeFeishuMediaTransport } from "./feishuMediaTransport.ts";
import { FEISHU_APP_CONFIG_FILENAME, parseFeishuBridgeConfig } from "./feishuBridgeConfig.ts";

export class FeishuMediaService extends ServiceMap.Service<FeishuMediaService, FeishuMedia>()(
  "metis/feishu/FeishuMediaService",
) {}
export const FeishuMediaLive = Layer.effect(
  FeishuMediaService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const repository = yield* ManagedAttachmentRepository;
    const turns = yield* ProjectionTurnRepository;
    const files = makeFeishuMediaFiles({
      repository,
      attachmentsDir: config.attachmentsDir,
      baseDir: config.baseDir,
    });
    const manager = new FeishuMedia(path.join(config.stateDir, "feishu-media"), {
      async turn(threadId, turnId) {
        const turn = Option.getOrUndefined(
          await Effect.runPromise(
            turns.getByTurnId({
              threadId: ThreadId.makeUnsafe(threadId),
              turnId: TurnId.makeUnsafe(turnId),
            }),
          ),
        );
        return turn ? { state: turn.state, messageId: turn.pendingMessageId } : undefined;
      },
      async transport(binding) {
        const raw = await fs
          .readFile(path.join(config.baseDir, FEISHU_APP_CONFIG_FILENAME), "utf8")
          .catch(() => null);
        const parsed = parseFeishuBridgeConfig(raw, {});
        if (
          parsed.kind !== "ready" ||
          parsed.config.appId !== binding.appId ||
          !parsed.config.allowedOpenIds.includes(binding.senderId)
        )
          throw new FeishuMediaError("feishu_owner_revoked_or_config_unavailable");
        return makeFeishuMediaTransport(parsed.config);
      },
      prepare: (attachment, binding, transport, workspaceRoot) =>
        files(attachment, { ...binding, workspaceRoot }, transport),
    });
    yield* Effect.tryPromise(() => manager.initialize());
    return manager;
  }),
);
