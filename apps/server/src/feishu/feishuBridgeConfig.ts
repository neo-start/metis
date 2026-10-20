/**
 * feishuBridgeConfig - what the Feishu bridge needs to run, read from a private
 * JSON file in the Metis data directory (`<baseDir>/feishu-app.json`).
 *
 * The bridge is off whenever that file is absent or unreadable; the server
 * never fails to start because of Feishu. Credentials stay on disk 0600 and are
 * never echoed into logs.
 *
 * @module feishu/feishuBridgeConfig
 */
import type { ModelSelection } from "@synara/contracts";

export const FEISHU_APP_CONFIG_FILENAME = "feishu-app.json";
export const FEISHU_CHAT_MAP_FILENAME = "feishu-chats.json";
/**
 * The concierge is a home chat: it belongs to Metis itself, not to any project.
 * Home chats live in their own folder under the managed chat workspace root and
 * the sidebar shows their container as the app, never as a project.
 */
export const METIS_CONSOLE_FOLDER_NAME = "metis-console";
export const METIS_CONSOLE_TITLE = "Metis 总控";

/** Pi through OpenRouter; picked by the user for the concierge (2026-09-26). */
export const DEFAULT_FEISHU_MODEL_SELECTION: ModelSelection = {
  provider: "pi",
  model: "openrouter/deepseek/deepseek-v4.1-flash",
};

export interface FeishuBridgeConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** Only these senders are answered; everyone else is silently ignored. */
  readonly allowedOpenIds: ReadonlyArray<string>;
  /** Explicit opt-in: trusted senders share the instance controller's conversation. */
  readonly target: "chat" | "controller";
  /** Used only when creating a legacy per-chat concierge. */
  readonly modelSelection: ModelSelection;
  /** HTTPS origin of the Metis web app, used to link replies back to the thread. */
  readonly publicOrigin: string | null;
}

export type FeishuBridgeConfigResult =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "ready"; readonly config: FeishuBridgeConfig };

const looksLikePlaceholder = (value: string): boolean => /在这里|粘贴|paste/i.test(value);

/** Pure: turn the raw file contents into a config or a reason the bridge stays off. */
export function parseFeishuBridgeConfig(
  contents: string | null,
  env: { readonly METIS_PUBLIC_URL?: string | undefined } = {},
): FeishuBridgeConfigResult {
  if (contents === null) {
    return { kind: "disabled", reason: `${FEISHU_APP_CONFIG_FILENAME} not found` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { kind: "disabled", reason: `${FEISHU_APP_CONFIG_FILENAME} is not valid JSON` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "disabled", reason: `${FEISHU_APP_CONFIG_FILENAME} must be an object` };
  }
  const record = raw as Record<string, unknown>;
  const appId = typeof record.appId === "string" ? record.appId.trim() : "";
  const appSecret = typeof record.appSecret === "string" ? record.appSecret.trim() : "";
  if (!appId.startsWith("cli_") || looksLikePlaceholder(appId)) {
    return { kind: "disabled", reason: "appId is missing or still the placeholder" };
  }
  if (appSecret.length < 16 || looksLikePlaceholder(appSecret)) {
    return { kind: "disabled", reason: "appSecret is missing or still the placeholder" };
  }
  const allowedOpenIds = Array.isArray(record.allowedOpenIds)
    ? record.allowedOpenIds.filter(
        (entry): entry is string => typeof entry === "string" && entry.startsWith("ou_"),
      )
    : [];
  if (allowedOpenIds.length === 0) {
    return { kind: "disabled", reason: "allowedOpenIds must list at least one ou_ open id" };
  }
  if (record.target !== undefined && record.target !== "chat" && record.target !== "controller") {
    return { kind: "disabled", reason: "target must be chat or controller" };
  }
  const target = record.target ?? "chat";
  const modelSelection = parseModelSelection(record.modelSelection);
  const publicOrigin =
    parseOrigin(typeof record.publicOrigin === "string" ? record.publicOrigin : undefined) ??
    parseOrigin(env.METIS_PUBLIC_URL);
  return {
    kind: "ready",
    config: { appId, appSecret, allowedOpenIds, target, modelSelection, publicOrigin },
  };
}

function parseModelSelection(value: unknown): ModelSelection {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { model?: unknown }).model === "string"
  ) {
    return value as ModelSelection;
  }
  return DEFAULT_FEISHU_MODEL_SELECTION;
}

function parseOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** One Feishu chat maps to one long-lived Metis thread. */
export type FeishuChatMap = Readonly<Record<string, string>>;

export function parseFeishuChatMap(contents: string | null): FeishuChatMap {
  if (contents === null) return {};
  try {
    const raw: unknown = JSON.parse(contents);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

/** Messages that stop the current turn instead of starting a new one. */
export function isStopCommand(text: string): boolean {
  return /^\s*(停|停止|停下|stop)\s*[。.!！]?\s*$/iu.test(text);
}

/** Feishu text payloads carry `@_user_1` placeholders for mentions; drop them. */
export function normalizeInboundText(content: string): string {
  return content
    .replace(/@_user_\d+/g, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function buildThreadLink(publicOrigin: string | null, threadId: string): string | null {
  return publicOrigin ? `${publicOrigin}/${threadId}` : null;
}

/** The markdown Feishu shows for a finished turn: the answer, then a link to the full thread. */
export function formatReplyMarkdown(input: {
  readonly text: string | null;
  readonly status: "completed" | "error" | "interrupted";
  readonly error: string | null;
  readonly threadLink: string | null;
}): string {
  const body =
    input.status === "completed"
      ? (input.text?.trim() ?? "") || "（这一轮没有文字回复）"
      : input.status === "interrupted"
        ? `${input.text?.trim() ? `${input.text.trim()}\n\n` : ""}（这一轮被打断了）`
        : `出错了：${input.error?.trim() || "未知错误"}`;
  return input.threadLink ? `${body}\n\n[在 Metis 里查看](${input.threadLink})` : body;
}
