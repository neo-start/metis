import { AsyncLocalStorage } from "node:async_hooks";
import type { HttpInstance, LarkChannel, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { createFeishuHttpInstance } from "./FeishuOutbound.ts";

type MarkdownProducer = (controller: {
  readonly messageId: string;
  append(text: string): Promise<void>;
  setContent(text: string): Promise<void>;
}) => Promise<void>;

/** The SDK swallows card update failures. Keep delivery evidence outside it. */
export class FeishuStreaming {
  private readonly attempts = new AsyncLocalStorage<{
    failed: boolean;
    messageIds: Set<string>;
  }>();
  readonly httpInstance: HttpInstance;

  constructor(
    base: Pick<HttpInstance, "request">,
    private readonly warn: (message: string) => void,
  ) {
    const checked = createFeishuHttpInstance(base);
    this.httpInstance = {
      ...checked,
      request: async (options) => {
        const attempt = this.attempts.getStore();
        try {
          const result = await checked.request(options);
          // Includes rollover cards, which the SDK's stream result omits.
          if (
            attempt &&
            /\/im\/v1\/messages(?:\/|$)/u.test(options.url ?? "") &&
            (options.data as { msg_type?: string } | undefined)?.msg_type === "interactive"
          ) {
            const id = (result as { data?: { message_id?: string } })?.data?.message_id;
            if (id) attempt.messageIds.add(id);
          }
          return result;
        } catch (error) {
          if (attempt && /\/cardkit\//u.test(options.url ?? "")) attempt.failed = true;
          throw error;
        }
      },
    };
  }

  stream(
    channel: Pick<LarkChannel, "stream" | "send" | "recallMessage">,
    chatId: string,
    input: { markdown: MarkdownProducer },
    options: SendOptions = {},
  ): Promise<SendResult> {
    return this.attempts.run({ failed: false, messageIds: new Set() }, async () => {
      const attempt = this.attempts.getStore()!;
      let text = "";
      const sent = await channel.stream(
        chatId,
        {
          markdown: async (controller) => {
            attempt.messageIds.add(controller.messageId);
            await input.markdown({
              get messageId() {
                return controller.messageId;
              },
              append: async (chunk) => {
                text += chunk;
                await controller.append(chunk);
              },
              setContent: async (content) => {
                text = content;
                await controller.setContent(content);
              },
            });
          },
        },
        options,
      );
      if (!attempt.failed) {
        const ids = [...attempt.messageIds];
        return { ...sent, ...(ids.length > 1 ? { chunkIds: ids } : {}) };
      }

      // Do not rerun the producer/task. Only a completed, retained reply can fall back.
      // Plain text also survives card-specific Markdown rejection (e.g. local images).
      this.warn("Feishu card update failed; delivering the completed reply as text.");
      const failedCardIds = [...attempt.messageIds];
      const fallback = await channel.send(chatId, { text: text || "本次回复没有正文。" }, options);
      for (const id of failedCardIds) {
        try {
          await channel.recallMessage(id);
        } catch {
          this.warn("Feishu reply delivered, but the failed placeholder could not be recalled.");
        }
      }
      return fallback;
    });
  }
}
