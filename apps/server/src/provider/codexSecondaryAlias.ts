// FILE: codexSecondaryAlias.ts
// Purpose: Presents a Codex adapter instance as the `codexSecondary` provider (the second
//          ChatGPT account). Inputs are translated to the Codex shape with the account's own
//          CODEX_HOME; sessions, events and discovery results are relabelled on the way out.
// Layer: Server provider adapter composition

import {
  CODEX_SECONDARY_DEFAULT_HOME_PATH,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderStartOptions,
} from "@synara/contracts";
import { mkdir } from "node:fs/promises";

import { Effect, Stream } from "effect";

import { expandCodexHomePath } from "../codexHomePaths.ts";
import type { CodexAdapterShape, CodexSecondaryAdapterShape } from "./Services/CodexAdapter.ts";

type CodexProviderStartOptions = NonNullable<ProviderStartOptions["codex"]>;

const SECONDARY = "codexSecondary" as const;

/** The second account must never fall back to the primary's default ~/.codex home. */
export function resolveCodexSecondaryAccountOptions(
  options: CodexProviderStartOptions | undefined,
): CodexProviderStartOptions {
  const homePath = options?.homePath?.trim() || CODEX_SECONDARY_DEFAULT_HOME_PATH;
  return {
    ...(options?.binaryPath ? { binaryPath: options.binaryPath } : {}),
    homePath: expandCodexHomePath(homePath),
  };
}

function toCodexInput<T>(input: T, account: CodexProviderStartOptions): T {
  if (input === null || typeof input !== "object") {
    return input;
  }
  const record = input as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  if (record.provider === SECONDARY) {
    next.provider = "codex";
  }
  const selection = record.modelSelection as { readonly provider?: string } | undefined;
  if (selection?.provider === SECONDARY) {
    next.modelSelection = { ...selection, provider: "codex" };
  }
  const providerOptions = record.providerOptions as ProviderStartOptions | undefined;
  next.providerOptions = {
    ...providerOptions,
    codex: resolveCodexSecondaryAccountOptions(providerOptions?.codexSecondary ?? account),
  };
  return next as T;
}

function toSecondaryOutput<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return record.provider === "codex" ? ({ ...record, provider: SECONDARY } as T) : value;
}

type AnyFn = (...args: never[]) => unknown;

export function aliasCodexAdapterAsSecondary(
  base: CodexAdapterShape,
  resolveAccountOptions: () => Promise<CodexProviderStartOptions>,
): CodexSecondaryAdapterShape {
  // Codex refuses to start when CODEX_HOME is missing, so create the second
  // account's home on first use instead of surfacing a confusing startup error.
  const account = Effect.promise(async () => {
    const options = await resolveAccountOptions();
    const { homePath } = resolveCodexSecondaryAccountOptions(options);
    if (homePath) {
      await mkdir(homePath, { recursive: true, mode: 0o700 }).catch(() => undefined);
    }
    return options;
  });

  // Every input-bearing method: resolve the account's launch options, translate the input,
  // and relabel whatever the Codex adapter returns.
  const wrapInput =
    <A, R, E>(call: (input: A) => Effect.Effect<R, E>) =>
    (input: A): Effect.Effect<R, E> =>
      account.pipe(
        Effect.flatMap((options) => call(toCodexInput(input, options))),
        Effect.map(toSecondaryOutput),
      );

  const optional = <F extends AnyFn | undefined>(fn: F, wrap: (fn: NonNullable<F>) => F): F =>
    (fn === undefined ? undefined : wrap(fn as NonNullable<F>)) as F;

  const shape: CodexSecondaryAdapterShape = {
    ...base,
    provider: SECONDARY,
    startSession: wrapInput(base.startSession),
    sendTurn: wrapInput(base.sendTurn),
    listSessions: () => base.listSessions().pipe(Effect.map((s) => s.map(toSecondaryOutput))),
    streamEvents: base.streamEvents.pipe(Stream.map(toSecondaryOutput)),
  };

  const optionalMethods: { readonly [K in keyof CodexSecondaryAdapterShape]?: unknown } = {
    ...(base.didResumeSession
      ? {
          didResumeSession: (input: ProviderSessionStartInput, session: ProviderSession) =>
            base.didResumeSession!(input, { ...session, provider: "codex" }),
        }
      : {}),
    steerTurn: optional(base.steerTurn, wrapInput),
    startReview: optional(base.startReview, wrapInput),
    forkThread: optional(base.forkThread, wrapInput),
    readExternalThread: optional(base.readExternalThread, wrapInput),
    listSkills: optional(base.listSkills, wrapInput),
    listCommands: optional(base.listCommands, wrapInput),
    listPlugins: optional(base.listPlugins, wrapInput),
    readPlugin: optional(base.readPlugin, wrapInput),
    listModels: optional(base.listModels, wrapInput),
    listAgents: optional(base.listAgents, wrapInput),
    prewarmVoice: optional(base.prewarmVoice, wrapInput),
    transcribeVoice: optional(base.transcribeVoice, wrapInput),
    getComposerCapabilities: optional(
      base.getComposerCapabilities,
      (fn) => () => fn().pipe(Effect.map(toSecondaryOutput)),
    ),
    prepareSessionReplacement: optional(
      base.prepareSessionReplacement,
      (fn) => (input) =>
        account.pipe(
          Effect.flatMap((options) => fn(toCodexInput(input, options))),
          Effect.map((replacement) =>
            replacement === undefined
              ? undefined
              : {
                  previousSession: toSecondaryOutput(replacement.previousSession),
                  startSession: wrapInput(replacement.startSession),
                },
          ),
        ),
    ),
  };
  // Omit methods the Codex adapter does not implement (exactOptionalPropertyTypes).
  const definedMethods = Object.fromEntries(
    Object.entries(optionalMethods).filter(([, method]) => method !== undefined),
  ) as Partial<CodexSecondaryAdapterShape>;
  return { ...shape, ...definedMethods };
}
