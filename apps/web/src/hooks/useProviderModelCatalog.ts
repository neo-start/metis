// FILE: useProviderModelCatalog.ts
// Purpose: Shared provider→model option catalog (static + custom + runtime-discovered)
//          for composer-like surfaces outside ChatView, e.g. the kanban new-task dialog.
// Layer: Web hooks
// Exports: useProviderModelCatalog, ProviderModelCatalog

import type {
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { isCodexProviderKind } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import {
  isInitialModelDiscoveryPending,
  prioritizeProviderModelDiscovery,
  providerAgentsQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../providerModelOptions";

export interface ProviderModelCatalog {
  customModelsByProvider: ReturnType<typeof getCustomModelsByProvider>;
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  /** Providers whose runtime model discovery is still pending (no usable list yet). */
  loadingModelProviders: Partial<Record<ProviderKind, boolean>>;
  /**
   * Runtime-discovered model descriptors per provider. Composer-style trait
   * controls (effort, fast mode, thinking, context window) are sourced from
   * these for cursor/codex/etc., so any surface that wants the effort picker
   * must feed them through (see {@link selectedRuntimeModel}).
   */
  runtimeModelsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
  /** The runtime descriptor matching `selectedProvider` + its selected-model hint. */
  selectedRuntimeModel: ProviderModelDescriptor | undefined;
  /** Runtime-discovered agents/modes for the selected provider (opencode/claude/codex). */
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  /** Loading state used by the selected provider's bootstrap skeleton. */
  selectedProviderModelsLoading: boolean;
  /** Whether the selected provider requires and is still waiting on runtime models. */
  selectedProviderRuntimeModelDiscoveryPending: boolean;
  /** Discovery failure detail per provider (268 passthrough). */
  discoveryErrorsByProvider: Partial<Record<ProviderKind, string | undefined>>;
}

const EMPTY_PROVIDER_AGENTS: ReadonlyArray<ProviderAgentDescriptor> = [];

function modelDiscoveryError(
  resultError: string | undefined,
  queryError: unknown,
): string | undefined {
  if (resultError) {
    return resultError;
  }
  if (queryError instanceof Error) {
    return queryError.message;
  }
  return typeof queryError === "string" ? queryError : undefined;
}

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  /**
   * Enables discovery for the on-demand providers (cursor/grok/droid/opencode/pi)
   * even when they are not selected — pass the picker's open state so their lists
   * are warm by the time the user browses them.
   */
  discoveryEnabled: boolean;
  /** Effective cwd for providers whose model catalog can be extended by project resources. */
  cwd?: string | null;
  /** Per-provider selected-model hints so an unknown selection still lists itself. */
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  /**
   * Restrict background discovery to the providers used by a non-picker surface.
   * Picker surfaces can omit this to use the visible-provider list from settings.
   */
  prefetchProviders?: ReadonlyArray<ProviderKind>;
  /** Preserve eager Claude/Codex agent discovery on surfaces that already prefetch both. */
  agentDiscoveryPolicy?: "selected" | "eager-core";
}): ProviderModelCatalog {
  const { selectedProvider, discoveryEnabled, modelHintByProvider } = input;
  const agentDiscoveryPolicy = input.agentDiscoveryPolicy ?? "selected";
  const discoveryCwd = input.cwd ?? null;
  const { settings, serverSettings } = useAppSettings();
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const prefetchProviderSet = useMemo(
    () =>
      input.prefetchProviders === undefined ? null : new Set<ProviderKind>(input.prefetchProviders),
    [input.prefetchProviders],
  );
  const shouldDiscoverProvider = (
    provider: ProviderKind,
    prefetchRequested = discoveryEnabled,
  ): boolean => {
    // The enabled flag is a short-circuit, not a precondition. `serverSettings` is
    // undefined while the settings query is in flight and stays undefined if it
    // fails — and it never refetches on its own (`staleTime: Infinity`). Treating
    // that as "disabled" would silence discovery for every provider, including the
    // selected one, which is precisely the "my model disappeared" symptom. Mirrors
    // the server-side fallback in ProviderDiscoveryService.listModels.
    if (serverSettings?.providers[provider]?.enabled === false) {
      return false;
    }
    if (provider === selectedProvider) {
      return true;
    }
    if (!prefetchRequested) {
      return false;
    }
    return prefetchProviderSet?.has(provider) ?? !hiddenProviderSet.has(provider);
  };

  const claudeModelDiscoveryEnabled = shouldDiscoverProvider("claudeAgent");
  const claudeOpenRouterModelDiscoveryEnabled = shouldDiscoverProvider("claudeOpenRouter");
  const codexModelDiscoveryEnabled = shouldDiscoverProvider("codex");
  const codexSecondaryModelDiscoveryEnabled = shouldDiscoverProvider("codexSecondary");
  const codexTertiaryModelDiscoveryEnabled = shouldDiscoverProvider("codexTertiary");
  const codexQuaternaryModelDiscoveryEnabled = shouldDiscoverProvider("codexQuaternary");
  const cursorModelDiscoveryEnabled = shouldDiscoverProvider("cursor");
  const antigravityModelDiscoveryEnabled = shouldDiscoverProvider("antigravity");
  const grokModelDiscoveryEnabled = shouldDiscoverProvider("grok");
  // ponytail: explicit prefetch only; picker surfaces stay cold (see droid query comment below).
  const droidPrefetchRequested = discoveryEnabled && (prefetchProviderSet?.has("droid") ?? false);
  const droidModelDiscoveryEnabled = shouldDiscoverProvider("droid", droidPrefetchRequested);
  const openCodeModelDiscoveryEnabled = shouldDiscoverProvider("opencode");
  const piModelDiscoveryEnabled = shouldDiscoverProvider("pi");
  const devinModelDiscoveryEnabled = shouldDiscoverProvider("devin");

  const modelQueryOptionsByProvider = {
    claudeAgent: providerModelsQueryOptions({
      provider: "claudeAgent",
      binaryPath: settings.claudeBinaryPath || null,
      enabled: claudeModelDiscoveryEnabled,
    }),
    claudeOpenRouter: providerModelsQueryOptions({
      provider: "claudeOpenRouter",
      binaryPath: settings.claudeOpenRouterBinaryPath || null,
      enabled: claudeOpenRouterModelDiscoveryEnabled,
    }),
    codex: providerModelsQueryOptions({
      provider: "codex",
      enabled: codexModelDiscoveryEnabled,
    }),
    codexSecondary: providerModelsQueryOptions({
      provider: "codexSecondary",
      enabled: codexSecondaryModelDiscoveryEnabled,
    }),
    codexTertiary: providerModelsQueryOptions({
      provider: "codexTertiary",
      enabled: codexTertiaryModelDiscoveryEnabled,
    }),
    codexQuaternary: providerModelsQueryOptions({
      provider: "codexQuaternary",
      enabled: codexQuaternaryModelDiscoveryEnabled,
    }),
    cursor: providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: cursorModelDiscoveryEnabled,
    }),
    antigravity: providerModelsQueryOptions({
      provider: "antigravity",
      binaryPath: settings.antigravityBinaryPath || null,
      cwd: discoveryCwd,
      enabled: antigravityModelDiscoveryEnabled,
    }),
    grok: providerModelsQueryOptions({
      provider: "grok",
      binaryPath: settings.grokBinaryPath || null,
      enabled: grokModelDiscoveryEnabled,
    }),
    droid: providerModelsQueryOptions({
      provider: "droid",
      binaryPath: settings.droidBinaryPath || null,
      cwd: discoveryCwd,
      // Droid probes every model through a disposable ACP session. Keep it
      // provider-scoped instead of warming it from unrelated picker/settings UI.
      enabled: droidModelDiscoveryEnabled,
    }),
    opencode: providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
    pi: providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      cwd: discoveryCwd,
      enabled: piModelDiscoveryEnabled,
    }),
    devin: providerModelsQueryOptions({
      provider: "devin",
      binaryPath: settings.devinBinaryPath || null,
      cwd: discoveryCwd,
      enabled: devinModelDiscoveryEnabled,
    }),
  } as const;

  const claudeDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.claudeAgent);
  const claudeOpenRouterDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.claudeOpenRouter);
  const codexDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.codex);
  const codexSecondaryDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.codexSecondary);
  const codexTertiaryDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.codexTertiary);
  const codexQuaternaryDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.codexQuaternary);
  const cursorDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.cursor);
  const antigravityModelsQuery = useQuery(modelQueryOptionsByProvider.antigravity);
  const grokDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.grok);
  const droidDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.droid);
  const openCodeDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.opencode);
  const piDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.pi);
  const devinDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.devin);

  const [, , modelProvider, modelBinaryPath, modelApiEndpoint, modelAgentDir, modelCwd] =
    modelQueryOptionsByProvider[selectedProvider].queryKey;
  const selectedProviderModelsQueryKey = useMemo(
    () =>
      providerDiscoveryQueryKeys.models(
        modelProvider,
        modelBinaryPath,
        modelApiEndpoint,
        modelAgentDir,
        modelCwd,
      ),
    [modelProvider, modelBinaryPath, modelApiEndpoint, modelAgentDir, modelCwd],
  );

  const selectedProviderModelsEnabled = modelQueryOptionsByProvider[selectedProvider].enabled;

  // Keep foreground ownership out of queryFn options: retries can outlive
  // the selection that started them. The effect owns the current priority.
  useEffect(() => {
    if (!selectedProviderModelsEnabled) return;
    return prioritizeProviderModelDiscovery(selectedProviderModelsQueryKey);
  }, [selectedProviderModelsQueryKey, selectedProviderModelsEnabled]);

  // Agent/mode discovery (opencode "Agent" picker, claude/codex subagents).
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "claudeAgent",
      enabled: shouldDiscoverProvider("claudeAgent", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const claudeOpenRouterDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "claudeOpenRouter",
      enabled: shouldDiscoverProvider("claudeOpenRouter", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const codexDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "codex",
      enabled: shouldDiscoverProvider("codex", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );

  const cursorRuntimeModels = useMemo(
    () => collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models],
  );

  const hasResolvedCursorModelDiscovery =
    (cursorDynamicModelsQuery.data?.source === "cursor.cli" ||
      cursorDynamicModelsQuery.data?.source === "cursor.acp") &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    isInitialModelDiscoveryPending(cursorDynamicModelsQuery);
  const hasResolvedDroidModelDiscovery =
    droidDynamicModelsQuery.data?.source === "droid-acp" &&
    (droidDynamicModelsQuery.data.models.length ?? 0) > 0;
  const droidModelDiscoveryPending =
    droidModelDiscoveryEnabled &&
    !hasResolvedDroidModelDiscovery &&
    isInitialModelDiscoveryPending(droidDynamicModelsQuery);
  const hasResolvedOpenCodeModelDiscovery =
    (openCodeDynamicModelsQuery.data?.source === "opencode-cli" ||
      openCodeDynamicModelsQuery.data?.source === "opencode") &&
    (openCodeDynamicModelsQuery.data.models.length ?? 0) > 0;
  const openCodeModelDiscoveryPending =
    openCodeModelDiscoveryEnabled &&
    !hasResolvedOpenCodeModelDiscovery &&
    isInitialModelDiscoveryPending(openCodeDynamicModelsQuery);
  const hasResolvedPiModelDiscovery =
    piDynamicModelsQuery.data?.source?.startsWith("pi.sdk") === true &&
    (piDynamicModelsQuery.data.models.length ?? 0) > 0;
  const piModelDiscoveryPending =
    piModelDiscoveryEnabled &&
    !hasResolvedPiModelDiscovery &&
    isInitialModelDiscoveryPending(piDynamicModelsQuery);
  const hasResolvedDevinModelDiscovery =
    (devinDynamicModelsQuery.data?.source === "devin-cli" ||
      // Static fallback descriptors are a valid resolved catalog: the adapter
      // serves its built-in matrix when CLI discovery is unavailable, so the
      // picker must render them instead of spinning (or banner-ing) forever.
      devinDynamicModelsQuery.data?.source === "devin.static") &&
    (devinDynamicModelsQuery.data.models.length ?? 0) > 0;
  const devinModelDiscoveryPending =
    devinModelDiscoveryEnabled &&
    !hasResolvedDevinModelDiscovery &&
    isInitialModelDiscoveryPending(devinDynamicModelsQuery);
  const antigravityModelDiscoveryPending =
    antigravityModelDiscoveryEnabled &&
    !(
      antigravityModelsQuery.data?.source === "antigravity.cli" &&
      (antigravityModelsQuery.data.models.length ?? 0) > 0
    ) &&
    isInitialModelDiscoveryPending(antigravityModelsQuery);

  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions("codex", customModelsByProvider.codex, modelHintByProvider?.codex),
      codexSecondary: getAppModelOptions(
        "codexSecondary",
        customModelsByProvider.codexSecondary,
        modelHintByProvider?.codexSecondary,
      ),
      codexTertiary: getAppModelOptions(
        "codexTertiary",
        customModelsByProvider.codexTertiary,
        modelHintByProvider?.codexTertiary,
      ),
      codexQuaternary: getAppModelOptions(
        "codexQuaternary",
        customModelsByProvider.codexQuaternary,
        modelHintByProvider?.codexQuaternary,
      ),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        modelHintByProvider?.claudeAgent,
      ),
      claudeOpenRouter: getAppModelOptions(
        "claudeOpenRouter",
        customModelsByProvider.claudeOpenRouter,
        modelHintByProvider?.claudeOpenRouter,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        modelHintByProvider?.cursor,
      ),
      antigravity: getAppModelOptions(
        "antigravity",
        customModelsByProvider.antigravity,
        modelHintByProvider?.antigravity,
      ),
      grok: getAppModelOptions("grok", customModelsByProvider.grok, modelHintByProvider?.grok),
      droid: getAppModelOptions("droid", customModelsByProvider.droid, modelHintByProvider?.droid),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        modelHintByProvider?.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, modelHintByProvider?.pi),
      devin: getAppModelOptions("devin", customModelsByProvider.devin, modelHintByProvider?.devin),
    };
    const result: Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    > = { ...staticOptions };
    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      claudeOpenRouter: claudeOpenRouterDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      codexSecondary: codexSecondaryDynamicModelsQuery.data,
      codexTertiary: codexTertiaryDynamicModelsQuery.data,
      codexQuaternary: codexQuaternaryDynamicModelsQuery.data,
      cursor:
        cursorDynamicModelsQuery.data === undefined
          ? undefined
          : { ...cursorDynamicModelsQuery.data, models: cursorRuntimeModels },
      antigravity: antigravityModelsQuery.data,
      grok: grokDynamicModelsQuery.data,
      droid: droidDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
      devin: devinDynamicModelsQuery.data,
    };
    for (const provider of [
      "claudeAgent",
      "claudeOpenRouter",
      "codex",
      "codexSecondary",
      "codexTertiary",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "opencode",
      "pi",
      "devin",
    ] as const) {
      const discovery = dynamicSources[provider];
      const dynamicModels = discovery?.models;
      const hasCodexCatalog =
        isCodexProviderKind(provider) &&
        discovery?.source === "codex-app-server" &&
        discovery.error === undefined;
      if (dynamicModels && (dynamicModels.length > 0 || hasCodexCatalog)) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels,
        });
      }
    }
    return result;
  }, [
    antigravityModelsQuery.data,
    claudeDynamicModelsQuery.data,
    claudeOpenRouterDynamicModelsQuery.data,
    codexDynamicModelsQuery.data,
    codexSecondaryDynamicModelsQuery.data,
    codexTertiaryDynamicModelsQuery.data,
    codexQuaternaryDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    droidDynamicModelsQuery.data,
    grokDynamicModelsQuery.data,
    modelHintByProvider,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
    devinDynamicModelsQuery.data,
  ]);

  const loadingModelProviders = useMemo<Partial<Record<ProviderKind, boolean>>>(
    () => ({
      antigravity: antigravityModelDiscoveryPending,
      cursor: cursorModelDiscoveryPending,
      droid: droidModelDiscoveryPending,
      opencode: openCodeModelDiscoveryPending,
      pi: piModelDiscoveryPending,
      devin: devinModelDiscoveryPending,
    }),
    [
      antigravityModelDiscoveryPending,
      cursorModelDiscoveryPending,
      droidModelDiscoveryPending,
      openCodeModelDiscoveryPending,
      piModelDiscoveryPending,
      devinModelDiscoveryPending,
    ],
  );

  const runtimeModelsByProvider = useMemo<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>
  >(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      claudeOpenRouter: claudeOpenRouterDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      codexSecondary: codexSecondaryDynamicModelsQuery.data?.models ?? [],
      codexTertiary: codexTertiaryDynamicModelsQuery.data?.models ?? [],
      codexQuaternary: codexQuaternaryDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      antigravity: antigravityModelsQuery.data?.models ?? [],
      grok: grokDynamicModelsQuery.data?.models ?? [],
      droid: droidDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
      devin: devinDynamicModelsQuery.data?.models ?? [],
    }),
    [
      antigravityModelsQuery.data?.models,
      claudeDynamicModelsQuery.data?.models,
      claudeOpenRouterDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      codexSecondaryDynamicModelsQuery.data?.models,
      codexTertiaryDynamicModelsQuery.data?.models,
      codexQuaternaryDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      droidDynamicModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
      devinDynamicModelsQuery.data?.models,
    ],
  );

  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: modelHintByProvider?.[selectedProvider] ?? null,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [modelHintByProvider, runtimeModelsByProvider, selectedProvider],
  );

  const selectedDynamicAgents =
    selectedProvider === "claudeAgent"
      ? (claudeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
      : selectedProvider === "claudeOpenRouter"
        ? (claudeOpenRouterDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
        : selectedProvider === "opencode"
          ? (openCodeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
          : (codexDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS);
  const selectedRuntimeAgents = useMemo<ReadonlyArray<ProviderAgentDescriptor>>(
    () =>
      selectedDynamicAgents.map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedDynamicAgents],
  );

  // Discovery failures per provider, surfaced as a subtle inline note by the
  // model pickers.
  const discoveryErrorsByProvider = useMemo(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.error,
      claudeOpenRouter: modelDiscoveryError(
        claudeOpenRouterDynamicModelsQuery.data?.error,
        claudeOpenRouterDynamicModelsQuery.error,
      ),
      codex: codexDynamicModelsQuery.data?.error,
      codexSecondary: codexSecondaryDynamicModelsQuery.data?.error,
      codexTertiary: codexTertiaryDynamicModelsQuery.data?.error,
      codexQuaternary: codexQuaternaryDynamicModelsQuery.data?.error,
      cursor: modelDiscoveryError(
        cursorDynamicModelsQuery.data?.error,
        cursorDynamicModelsQuery.error,
      ),
      devin: modelDiscoveryError(
        devinDynamicModelsQuery.data?.error,
        devinDynamicModelsQuery.error,
      ),
      antigravity: modelDiscoveryError(
        antigravityModelsQuery.data?.error,
        antigravityModelsQuery.error,
      ),
      grok: modelDiscoveryError(grokDynamicModelsQuery.data?.error, grokDynamicModelsQuery.error),
      droid: modelDiscoveryError(
        droidDynamicModelsQuery.data?.error,
        droidDynamicModelsQuery.error,
      ),
      opencode: modelDiscoveryError(
        openCodeDynamicModelsQuery.data?.error,
        openCodeDynamicModelsQuery.error,
      ),
      pi: modelDiscoveryError(piDynamicModelsQuery.data?.error, piDynamicModelsQuery.error),
    }),
    [
      antigravityModelsQuery.data?.error,
      antigravityModelsQuery.error,
      claudeDynamicModelsQuery.data?.error,
      claudeOpenRouterDynamicModelsQuery.data?.error,
      claudeOpenRouterDynamicModelsQuery.error,
      codexDynamicModelsQuery.data?.error,
      codexSecondaryDynamicModelsQuery.data?.error,
      codexTertiaryDynamicModelsQuery.data?.error,
      codexQuaternaryDynamicModelsQuery.data?.error,
      cursorDynamicModelsQuery.data?.error,
      cursorDynamicModelsQuery.error,
      devinDynamicModelsQuery.data?.error,
      devinDynamicModelsQuery.error,
      droidDynamicModelsQuery.data?.error,
      droidDynamicModelsQuery.error,
      grokDynamicModelsQuery.data?.error,
      grokDynamicModelsQuery.error,
      openCodeDynamicModelsQuery.data?.error,
      openCodeDynamicModelsQuery.error,
      piDynamicModelsQuery.data?.error,
      piDynamicModelsQuery.error,
    ],
  );

  const selectedProviderRuntimeModelDiscoveryPending =
    loadingModelProviders[selectedProvider] ?? false;
  const selectedProviderModelsQuery =
    selectedProvider === "claudeAgent"
      ? claudeDynamicModelsQuery
      : selectedProvider === "claudeOpenRouter"
        ? claudeOpenRouterDynamicModelsQuery
        : selectedProvider === "codex"
          ? codexDynamicModelsQuery
          : selectedProvider === "codexSecondary"
            ? codexSecondaryDynamicModelsQuery
            : selectedProvider === "codexTertiary"
              ? codexTertiaryDynamicModelsQuery
              : selectedProvider === "codexQuaternary"
                ? codexQuaternaryDynamicModelsQuery
                : selectedProvider === "cursor"
                  ? cursorDynamicModelsQuery
                  : selectedProvider === "antigravity"
                    ? antigravityModelsQuery
                    : selectedProvider === "grok"
                      ? grokDynamicModelsQuery
                      : selectedProvider === "droid"
                        ? droidDynamicModelsQuery
                        : selectedProvider === "opencode"
                          ? openCodeDynamicModelsQuery
                          : selectedProvider === "pi"
                            ? piDynamicModelsQuery
                            : devinDynamicModelsQuery;
  const selectedProviderModelsLoading =
    selectedProviderRuntimeModelDiscoveryPending ||
    (loadingModelProviders[selectedProvider] === undefined &&
      (selectedProviderModelsQuery.isLoading ||
        (selectedProviderModelsQuery.isFetching &&
          selectedProviderModelsQuery.data === undefined)));

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      loadingModelProviders,
      runtimeModelsByProvider,
      selectedRuntimeModel,
      selectedRuntimeAgents,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      discoveryErrorsByProvider,
    }),
    [
      customModelsByProvider,
      discoveryErrorsByProvider,
      loadingModelProviders,
      modelOptionsByProvider,
      runtimeModelsByProvider,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      selectedRuntimeAgents,
      selectedRuntimeModel,
    ],
  );
}
