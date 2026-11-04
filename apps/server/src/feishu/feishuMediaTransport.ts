import { createReadStream } from "node:fs";
import {
  Client,
  defaultHttpInstance,
  Domain,
  type HttpInstance,
  type HttpRequestOptions,
} from "@larksuiteoapi/node-sdk";

export class FeishuMediaError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(code);
  }
}

export interface FeishuMediaTransport {
  upload(input: {
    filePath: string;
    name: string;
    type: "image" | "stream" | "opus" | "mp4";
    durationMs?: number;
  }): Promise<string>;
  send(
    chatId: string,
    type: string,
    content: Record<string, unknown>,
    uuid: string,
  ): Promise<string>;
  reconcile(
    chatId: string,
    appId: string,
    type: string,
    content: Record<string, unknown>,
    since: number,
  ): Promise<string | undefined>;
}

/** Official SDK handles tenant tokens and multipart. Never use channel.send's retry loop
 * for media: a transport timeout is an unknown result, not permission to resend. */
export function makeFeishuMediaTransport(
  config: { appId: string; appSecret: string },
  domain: Domain | string = Domain.Feishu,
): FeishuMediaTransport {
  const http: HttpInstance = {
    get: (url, options) => http.request({ ...options, url, method: "GET" }),
    delete: (url, options) => http.request({ ...options, url, method: "DELETE" }),
    head: (url, options) => http.request({ ...options, url, method: "HEAD" }),
    options: (url, options) => http.request({ ...options, url, method: "OPTIONS" }),
    post: (url, data, options) => http.request({ ...options, url, data, method: "POST" }),
    put: (url, data, options) => http.request({ ...options, url, data, method: "PUT" }),
    patch: (url, data, options) => http.request({ ...options, url, data, method: "PATCH" }),
    request: async <T, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
      try {
        const response = await defaultHttpInstance.request({
          ...options,
          timeout: 60_000,
          maxRedirects: 0,
        });
        const value = response as unknown as { code?: number };
        if (typeof value?.code === "number" && value.code !== 0)
          throw new FeishuMediaError(`feishu_api_${value.code}`);
        return response as unknown as R;
      } catch (error) {
        if (error instanceof FeishuMediaError) throw error;
        const status = (error as { response?: { status?: number } }).response?.status;
        // Never retain Axios errors: they contain Authorization and app secrets.
        throw new FeishuMediaError(
          status ? `feishu_http_${status}` : "feishu_transport_unknown",
          !status || status >= 500,
        );
      }
    },
  };
  const client = new Client({
    ...config,
    domain,
    httpInstance: http,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
  });
  return {
    async upload(input) {
      const stream = createReadStream(input.filePath);
      try {
        const key =
          input.type === "image"
            ? (await client.im.v1.image.create({ data: { image_type: "message", image: stream } }))
                ?.image_key
            : (
                await client.im.v1.file.create({
                  data: {
                    file_type: input.type,
                    file_name: input.name,
                    file: stream,
                    ...(input.durationMs === undefined ? {} : { duration: input.durationMs }),
                  },
                })
              )?.file_key;
        if (!key) throw new FeishuMediaError("feishu_upload_missing_key");
        return key;
      } finally {
        stream.destroy();
      }
    },
    async send(chatId, type, content, uuid) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid },
      });
      if (response.code !== 0) throw new FeishuMediaError(`feishu_api_${response.code}`);
      const id = response.data?.message_id;
      if (!id) throw new FeishuMediaError("feishu_send_missing_receipt", true);
      return id;
    },
    async reconcile(chatId, appId, type, content, since) {
      // Text has no unique uploaded key. Absence from a bounded scan proves nothing.
      if (type === "text") return undefined;
      let pageToken: string | undefined;
      const matches = new Set<string>();
      for (let page = 0; page < 5; page++) {
        const response = await client.im.v1.message.list({
          params: {
            container_id_type: "chat",
            container_id: chatId,
            start_time: String(Math.floor(since / 1000)),
            end_time: String(Math.ceil(Date.now() / 1000)),
            sort_type: "ByCreateTimeAsc",
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        if (response.code !== 0) throw new FeishuMediaError(`feishu_api_${response.code}`);
        for (const item of response.data?.items ?? []) {
          if (
            item.chat_id !== chatId ||
            item.sender?.id !== appId ||
            item.sender.sender_type !== "app" ||
            item.msg_type !== type ||
            item.deleted
          )
            continue;
          try {
            const body = JSON.parse(item.body?.content ?? "null");
            const key = type === "image" ? "image_key" : "file_key";
            if (
              body?.[key] === content[key] &&
              Number(item.create_time) >= since &&
              item.message_id &&
              (type !== "media" || (body.image_key ?? "") === (content.image_key ?? ""))
            )
              matches.add(item.message_id);
          } catch {
            /* malformed or unrelated message */
          }
        }
        if (!response.data?.has_more) return matches.size === 1 ? [...matches][0] : undefined;
        if (!response.data.page_token) return undefined;
        pageToken = response.data.page_token;
      }
      return undefined;
    },
  };
}
