import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEISHU_MODEL_SELECTION,
  formatReplyMarkdown,
  isStopCommand,
  normalizeInboundText,
  parseFeishuBridgeConfig,
  parseFeishuChatMap,
} from "./feishuBridgeConfig.ts";

const valid = JSON.stringify({
  appId: "cli_abc123",
  appSecret: "0123456789abcdef0123456789abcdef",
  allowedOpenIds: ["ou_1"],
});

describe("parseFeishuBridgeConfig", () => {
  it("stays disabled without a file, with placeholders, or without an allowlist", () => {
    expect(parseFeishuBridgeConfig(null).kind).toBe("disabled");
    expect(
      parseFeishuBridgeConfig(
        JSON.stringify({ appId: "在这里粘贴 app_id", appSecret: "x", allowedOpenIds: ["ou_1"] }),
      ).kind,
    ).toBe("disabled");
    expect(
      parseFeishuBridgeConfig(
        JSON.stringify({ appId: "cli_a", appSecret: "0123456789abcdef0", allowedOpenIds: [] }),
      ).kind,
    ).toBe("disabled");
    expect(parseFeishuBridgeConfig("{not json").kind).toBe("disabled");
  });

  it("reads a valid file with the Pi/OpenRouter default model and an optional origin", () => {
    const result = parseFeishuBridgeConfig(valid, { METIS_PUBLIC_URL: "https://m.example/x" });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.config.appId).toBe("cli_abc123");
    expect(result.config.allowedOpenIds).toEqual(["ou_1"]);
    expect(result.config.modelSelection).toEqual(DEFAULT_FEISHU_MODEL_SELECTION);
    expect(result.config.publicOrigin).toBe("https://m.example");
  });
});

describe("helpers", () => {
  it("parses the chat map defensively", () => {
    expect(parseFeishuChatMap(null)).toEqual({});
    expect(parseFeishuChatMap('{"oc_1":"thread-1","oc_2":3}')).toEqual({ oc_1: "thread-1" });
  });
  it("recognises stop commands and strips mention placeholders", () => {
    expect(isStopCommand("停")).toBe(true);
    expect(isStopCommand("Stop!")).toBe(true);
    expect(isStopCommand("停一下再看看")).toBe(false);
    expect(normalizeInboundText("@_user_1 帮我看看 PR")).toBe("帮我看看 PR");
  });
  it("formats replies per status with a thread link", () => {
    expect(
      formatReplyMarkdown({
        text: "done",
        status: "completed",
        error: null,
        threadLink: "https://m/t1",
      }),
    ).toBe("done\n\n[在 Metis 里查看](https://m/t1)");
    expect(
      formatReplyMarkdown({ text: null, status: "error", error: "boom", threadLink: null }),
    ).toBe("出错了：boom");
  });
});
