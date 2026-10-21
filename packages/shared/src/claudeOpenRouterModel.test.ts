import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";

import {
  claudeSelectionRequiresRestart,
  getDefaultEffort,
  getDefaultModel,
  getModelCapabilities,
  getProviderOptionDescriptors,
  normalizeClaudeOpenRouterModelOptions,
  normalizeModelSlug,
} from "./model";
import { providerStartOptionsFromServerSettings } from "./serverSettings";
import { autoRuntimeModeSelectionIssue } from "./runtimeMode";

describe("GLM through Claude SDK model options", () => {
  it("offers only the GLM effort ladder and defaults to high", () => {
    const caps = getModelCapabilities("claudeOpenRouter", "z-ai/glm-5.3");
    expect(getDefaultModel("claudeOpenRouter")).toBe("z-ai/glm-5.3");
    expect(normalizeModelSlug("glm-5.3", "claudeOpenRouter")).toBe("z-ai/glm-5.3");
    expect(getDefaultEffort(caps)).toBe("high");
    const descriptors = getProviderOptionDescriptors({ provider: "claudeOpenRouter", caps });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "effort",
      type: "select",
      currentValue: "high",
      options: [{ id: "low" }, { id: "high", isDefault: true }, { id: "max" }],
    });
    expect(caps.supportsFastMode).toBe(false);
    expect(caps.supportsThinkingToggle).toBe(false);
    expect(caps.contextWindowOptions).toEqual([]);
  });

  it("keeps explicit effort overrides without sending Claude-only settings", () => {
    expect(
      normalizeClaudeOpenRouterModelOptions("z-ai/glm-5.3", { effort: "high" }),
    ).toBeUndefined();
    expect(normalizeClaudeOpenRouterModelOptions("z-ai/glm-5.3", { effort: "low" })).toEqual({
      effort: "low",
    });
    expect(normalizeClaudeOpenRouterModelOptions("z-ai/glm-5.3", { effort: "max" })).toEqual({
      effort: "max",
    });
    expect(
      providerStartOptionsFromServerSettings(DEFAULT_SERVER_SETTINGS).claudeOpenRouter,
    ).toEqual({
      binaryPath: "claude",
    });
  });

  it("does not claim Claude Auto-mode compatibility", () => {
    expect(
      autoRuntimeModeSelectionIssue({
        runtimeMode: "auto",
        modelSelection: { provider: "claudeOpenRouter", model: "z-ai/glm-5.3" },
      }),
    ).toContain("does not support Auto runtime mode");
  });

  it("restarts when GLM enters or leaves the SDK's spawn-fixed max effort", () => {
    const selection = { provider: "claudeOpenRouter", model: "z-ai/glm-5.3" } as const;
    expect(claudeSelectionRequiresRestart(undefined, selection)).toBe(false);
    expect(
      claudeSelectionRequiresRestart(selection, { ...selection, options: { effort: "low" } }),
    ).toBe(false);
    expect(
      claudeSelectionRequiresRestart(selection, { ...selection, options: { effort: "max" } }),
    ).toBe(true);
    expect(
      claudeSelectionRequiresRestart({ ...selection, options: { effort: "max" } }, selection),
    ).toBe(true);
    expect(
      claudeSelectionRequiresRestart(selection, { ...selection, model: "z-ai/glm-custom" }),
    ).toBe(true);
  });
});
