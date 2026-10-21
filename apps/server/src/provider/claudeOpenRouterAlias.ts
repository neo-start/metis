// Reuses the Claude SDK lifecycle with a separate identity, credentials and transcript store.
import type { ProviderSessionStartInput, ProviderStartOptions } from "@synara/contracts";
import { getModelCapabilities, getProviderOptionDescriptors } from "@synara/shared/model";
import { Effect, Stream } from "effect";

import { type ProviderAdapterError, ProviderAdapterValidationError } from "./Errors.ts";
import type { ClaudeAdapterShape } from "./Services/ClaudeAdapter.ts";
import type { ClaudeOpenRouterAdapterShape } from "./Services/ClaudeOpenRouterAdapter.ts";

const PROVIDER = "claudeOpenRouter" as const;
const DEFAULT_MODEL = "z-ai/glm-5.3";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function output<T>(value: T): T {
  if (Array.isArray(value)) return value.map(output) as T;
  const source = record(value);
  if (!source) return value;
  const cursor = record(source.resumeCursor);
  // Claude Code cannot price an OpenRouter model (costBasis: unknown). Keep token
  // usage, but do not publish its fallback Claude price as a GLM charge.
  const {
    claudeCache: _cache,
    totalCostUsd: _totalCost,
    cumulativeCostUsd: _cumulativeCost,
    ...rest
  } = source;
  const modelUsage = record(source.modelUsage);
  return {
    ...rest,
    ...(source.provider === "claudeAgent" ? { provider: PROVIDER } : {}),
    ...(cursor ? { resumeCursor: { ...output(cursor), provider: PROVIDER } } : {}),
    ...(source.payload ? { payload: output(source.payload) } : {}),
    ...(source.usage ? { usage: output(source.usage) } : {}),
    ...(modelUsage
      ? {
          modelUsage: Object.fromEntries(
            Object.entries(modelUsage).map(([model, value]) => {
              const usage = record(value);
              if (!usage) return [model, value];
              const { costUSD: _cost, ...tokens } = usage;
              return [model, tokens];
            }),
          ),
        }
      : {}),
  } as T;
}

function remapError<E extends ProviderAdapterError>(error: E): E {
  // Preserve tagged error prototypes/getters so upstream failure classification still works.
  return Object.assign(Object.create(Object.getPrototypeOf(error)), error, { provider: PROVIDER });
}

function translateInput<T>(input: T, binaryPath?: string): T {
  const source = record(input);
  if (!source) return input;
  if (source.runtimeMode === "auto") {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "startSession",
      issue: "GLM via Claude SDK does not support Claude Auto mode.",
    });
  }
  const selection = record(source.modelSelection);
  const selectionOptions = record(selection?.options);
  const providerOptions = source.providerOptions as ProviderStartOptions | undefined;
  const cursor = record(source.resumeCursor);
  if (source.resumeCursor !== undefined && cursor?.provider !== PROVIDER) {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "startSession",
      issue: "This resume cursor belongs to a different provider. Start a GLM conversation.",
    });
  }
  if (source.forkSourceResumeCursor !== undefined) {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "startSession",
      issue: "Native Claude transcript import is unavailable for GLM. Use conversation replay.",
    });
  }
  return {
    ...source,
    ...("enableArtifacts" in source ? { enableArtifacts: false } : {}),
    ...("provider" in source && !("runtimeMode" in source) && binaryPath && !source.binaryPath
      ? { binaryPath }
      : {}),
    ...(source.provider === PROVIDER ? { provider: "claudeAgent" } : {}),
    // Pin the effective default on every turn; clearing a low override must return to high.
    ...(selection?.provider === PROVIDER || "runtimeMode" in source
      ? {
          modelSelection: {
            provider: "claudeAgent",
            model: selection?.model ?? DEFAULT_MODEL,
            options: { effort: selectionOptions?.effort ?? "high" },
          },
        }
      : {}),
    providerOptions: {
      ...providerOptions,
      claudeAgent: {
        ...(binaryPath ? { binaryPath } : {}),
        ...providerOptions?.claudeOpenRouter,
      },
    },
  } as T;
}

export function aliasClaudeAdapterAsOpenRouter(
  base: ClaudeAdapterShape,
  resolveConnectionOptions: () => Promise<{ readonly binaryPath?: string }>,
): ClaudeOpenRouterAdapterShape {
  const connection = Effect.tryPromise({
    try: resolveConnectionOptions,
    catch: () =>
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "connection",
        issue: "Could not read GLM provider settings.",
      }),
  });
  const wrapInput =
    <A, R>(call: (input: A) => Effect.Effect<R, ProviderAdapterError>) =>
    (input: A): Effect.Effect<R, ProviderAdapterError> =>
      connection.pipe(
        Effect.flatMap((options) =>
          Effect.try({
            try: () => translateInput(input, options.binaryPath),
            catch: (error) => error as ProviderAdapterValidationError,
          }),
        ),
        Effect.flatMap(call),
        Effect.map(output),
        Effect.mapError(remapError),
      );
  const wrap =
    <A extends unknown[], R, E extends ProviderAdapterError>(
      call: (...args: A) => Effect.Effect<R, E>,
    ) =>
    (...args: A): Effect.Effect<R, E> =>
      call(...args).pipe(Effect.map(output), Effect.mapError(remapError));
  // The SDK's native read/fork helpers read the user's default Claude config.
  // Leave them unadvertised; the orchestration layer can replay retained messages.
  const {
    forkThread: _fork,
    getClaudeCacheObservation: _cache,
    startClaudeCompaction: _compaction,
    ...safeBase
  } = base;
  return {
    ...safeBase,
    provider: PROVIDER,
    startSession: wrapInput(base.startSession),
    sendTurn: wrapInput(base.sendTurn),
    steerTurn: wrapInput(base.steerTurn),
    stopTask: wrap(base.stopTask),
    backgroundTask: wrap(base.backgroundTask),
    steerSubagent: wrap(base.steerSubagent),
    interruptTurn: wrap(base.interruptTurn),
    readThread: wrap(base.readThread),
    rollbackThread: wrap(base.rollbackThread),
    respondToRequest: wrap(base.respondToRequest),
    respondToUserInput: wrap(base.respondToUserInput),
    stopSession: wrap(base.stopSession),
    stopAll: wrap(base.stopAll),
    listSessions: wrap(base.listSessions),
    ...(base.prepareSessionReplacement
      ? {
          prepareSessionReplacement: (input: ProviderSessionStartInput) =>
            wrapInput(base.prepareSessionReplacement!)(input).pipe(
              Effect.map((replacement) =>
                replacement
                  ? {
                      previousSession: output(replacement.previousSession),
                      startSession: wrapInput(replacement.startSession),
                    }
                  : undefined,
              ),
            ),
        }
      : {}),
    getComposerCapabilities: () =>
      base.getComposerCapabilities!().pipe(
        Effect.map((caps) => ({
          ...caps,
          provider: PROVIDER,
          supportsThreadImport: false,
        })),
      ),
    ...(base.listCommands ? { listCommands: wrapInput(base.listCommands) } : {}),
    ...(base.listAgents ? { listAgents: wrapInput(base.listAgents) } : {}),
    listModels: () =>
      Effect.succeed({
        models: [
          {
            slug: DEFAULT_MODEL,
            name: "GLM 5.3",
            upstreamProviderId: "openrouter",
            upstreamProviderName: "OpenRouter",
            supportsAutoMode: false,
            optionDescriptors: getProviderOptionDescriptors({
              provider: PROVIDER,
              caps: getModelCapabilities(PROVIDER, DEFAULT_MODEL),
            }),
          },
        ],
        source: "configured",
        cached: false,
      }),
    streamEvents: base.streamEvents.pipe(Stream.map(output)),
  };
}
