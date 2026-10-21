import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ModelSelection, isClaudeSdkProviderKind } from "./orchestration";
import { ProviderSessionStartInput } from "./provider";
import { ProviderGetComposerCapabilitiesInput } from "./providerDiscovery";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "./settings";

describe("Claude SDK OpenRouter provider contract", () => {
  it("preserves its identity across session and discovery boundaries", () => {
    const input = Schema.decodeUnknownSync(ProviderSessionStartInput)({
      threadId: "glm-thread",
      provider: "claudeOpenRouter",
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "claudeOpenRouter",
        model: "z-ai/glm-5.3",
        options: { effort: "high" },
      },
      providerOptions: { claudeOpenRouter: { binaryPath: "/usr/local/bin/claude" } },
    });

    expect(input.provider).toBe("claudeOpenRouter");
    expect(input.modelSelection).toEqual({
      provider: "claudeOpenRouter",
      model: "z-ai/glm-5.3",
      options: { effort: "high" },
    });
    expect(input.providerOptions?.claudeOpenRouter?.binaryPath).toBe("/usr/local/bin/claude");
    expect(
      Schema.decodeUnknownSync(ProviderGetComposerCapabilitiesInput)({
        provider: "claudeOpenRouter",
      }),
    ).toEqual({ provider: "claudeOpenRouter" });
    expect(isClaudeSdkProviderKind(input.provider)).toBe(true);
    expect(isClaudeSdkProviderKind("claudeAgent")).toBe(true);
    expect(isClaudeSdkProviderKind("pi")).toBe(false);
  });

  it.each(["low", "high", "max"])("accepts supported effort %s", (effort) => {
    expect(
      Schema.decodeUnknownSync(ModelSelection)({
        provider: "claudeOpenRouter",
        model: "z-ai/glm-5.3",
        options: { effort },
      }).options,
    ).toEqual({ effort });
  });

  it.each(["medium", "xhigh", "ultrathink", "ultracode"])(
    "rejects unsupported Claude effort %s",
    (effort) => {
      expect(() =>
        Schema.decodeUnknownSync(ModelSelection)({
          provider: "claudeOpenRouter",
          model: "z-ai/glm-5.3",
          options: { effort },
        }),
      ).toThrow();
    },
  );

  it("keeps settings independent without adding credential fields", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeOpenRouter).toEqual({
      enabled: true,
      binaryPath: "claude",
      customModels: [],
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent).toHaveProperty("enableArtifacts");
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: { claudeOpenRouter: { binaryPath: "/opt/claude", enabled: false } },
    });
    expect(patch.providers).toEqual({
      claudeOpenRouter: { binaryPath: "/opt/claude", enabled: false },
    });
  });
});
