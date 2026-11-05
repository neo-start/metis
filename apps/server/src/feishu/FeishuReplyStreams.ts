import type { LarkChannel, SendResult } from "@larksuiteoapi/node-sdk";

type ReplyStream = {
  finish(text: string): void;
  result: Promise<{ sent: SendResult } | { error: unknown }>;
};

/** Live typing cards are disposable; the Router outbox still owns delivery/retry. */
export class FeishuReplyStreams {
  private readonly pending = new Map<string, ReplyStream>();
  constructor(
    private readonly channel: Pick<LarkChannel, "stream">,
    private readonly warn: (error: unknown) => void,
    private readonly timeoutMs = 2 * 60_000,
  ) {}

  private key(chatId: string, replyTo: string) {
    return JSON.stringify([chatId, replyTo]);
  }

  start(chatId: string, replyTo: string) {
    const key = this.key(chatId, replyTo);
    if (this.pending.has(key)) return;
    let finish!: (text: string) => void;
    const content = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      this.cancel(chatId, replyTo, "回复仍在生成，完成后会继续发送。");
    }, this.timeoutMs);
    timer.unref();
    const entry: ReplyStream = {
      finish,
      result: this.channel
        .stream(
          chatId,
          { markdown: async (controller) => controller.setContent(await content) },
          { replyTo },
        )
        .then(
          (sent) => ({ sent }),
          (error: unknown) => {
            this.warn(error);
            return { error };
          },
        )
        .finally(() => {
          clearTimeout(timer);
          if (this.pending.get(key) === entry) this.pending.delete(key);
        }),
    };
    this.pending.set(key, entry);
  }

  async send(chatId: string, text: string, replyTo: string) {
    this.start(chatId, replyTo);
    const entry = this.pending.get(this.key(chatId, replyTo))!;
    entry.finish(text);
    const result = await entry.result;
    if ("error" in result) throw result.error;
    return result.sent;
  }

  cancel(chatId: string, replyTo: string, text = "本次回复已暂停。") {
    const key = this.key(chatId, replyTo);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    entry.finish(text);
    return entry.result;
  }

  async stop() {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.finish("连接正在重启，未完成的回复将在恢复后继续发送。");
    await Promise.all(entries.map((entry) => entry.result));
  }
}
