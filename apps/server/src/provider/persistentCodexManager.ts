import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderEvent,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
} from "@synara/contracts";
import type {
  PersistentHostMethod,
  PersistentHostSnapshot,
} from "@synara/contracts/persistentProviderHost";
import type {
  CodexAppServerManager,
  CodexAppServerStartSessionInput,
} from "../codexAppServerManager.ts";
import { launchOrConnectCodexHost, PersistentCodexHostClient } from "./persistentHost/client.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

type HostSession = PersistentHostSnapshot["sessions"][number] & {
  readonly lifecycleGeneration?: string;
};
export type PersistentCodexManagerClient = Pick<
  PersistentCodexHostClient,
  "snapshot" | "events" | "call" | "acknowledge" | "detach" | "disconnect" | "terminate"
>;
type HostClient = PersistentCodexManagerClient;

export interface PersistentCodexManagerControl {
  prepareHostReplacement(input: {
    readonly threadId: ThreadId;
    readonly persistentNative: boolean;
  }): Promise<ProviderSession | undefined>;
  adoptPersistentSessions(bindings: ReadonlyArray<ProviderRuntimeBinding>): Promise<void>;
  preparePersistentRecovery(bindings: ReadonlyArray<ProviderRuntimeBinding>): Promise<void>;
  listPersistentSessionThreadIds(): ReadonlyArray<ThreadId>;
  registerPersistentRuntimeEvents(
    event: ProviderEvent,
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ): void;
  acknowledgeRuntimeEvent(event: ProviderRuntimeEvent): Promise<void>;
  closeForBackendShutdown(): Promise<void>;
}

export type PersistentCodexManager = CodexAppServerManager & PersistentCodexManagerControl;

function cursorThread(cursor: unknown): string | undefined {
  const value = cursor as { threadId?: unknown } | null;
  return value && typeof value.threadId === "string" ? value.threadId : undefined;
}

/** Resolve both source execution and the sibling entry emitted by the server bundle. */
export function persistentHostLaunchSpec(moduleUrl = import.meta.url) {
  const bundled = fileURLToPath(new URL("./persistentProviderHostMain.mjs", moduleUrl));
  const source = fileURLToPath(new URL("../persistentProviderHostMain.ts", moduleUrl));
  const entry = existsSync(bundled) ? bundled : source;
  if (!existsSync(entry))
    throw new Error("Persistent provider host entry is missing from this server installation");
  return { executable: process.execPath, args: [entry] };
}

/**
 * Keeps the ordinary gateway manager intact. Only an explicit native-only start
 * crosses this process boundary; adopted sessions never issue initialize/resume.
 */
export function makePersistentCodexManager(
  local: CodexAppServerManager,
  options: {
    readonly stateDir: string;
    readonly connect?: (launch: boolean) => Promise<HostClient | undefined>;
    readonly pollIntervalMs?: number;
  },
): PersistentCodexManager {
  const directory = path.join(options.stateDir, "persistent-provider-host", "codex");
  const connect =
    options.connect ??
    (async (launch: boolean) => {
      if (!launch && !existsSync(path.join(directory, "descriptor.json"))) {
        if (existsSync(path.join(directory, "launch.json"))) {
          throw new Error(
            "Persistent host ownership is unresolved; inspect its launch state before starting another provider",
          );
        }
        return undefined;
      }
      return launch
        ? launchOrConnectCodexHost({ directory, ...persistentHostLaunchSpec() })
        : PersistentCodexHostClient.connect(directory);
    });
  let client: HostClient | undefined;
  let opening: Promise<HostClient | undefined> | undefined;
  let snapshot: PersistentHostSnapshot | undefined;
  let sessions = new Map<ThreadId, HostSession>();
  const owned = new Set<ThreadId>();
  const generationByThread = new Map<ThreadId, string>();
  let receivedSequence = 0;
  let acknowledgedSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let retirement: Promise<void> | undefined;
  let retiringHost = false;
  let closed = false;
  let recoveryStarted = false;
  let connectionVerified = false;
  let recoveredBindings: ReadonlyArray<ProviderRuntimeBinding> = [];
  let lastFailure: Error | undefined;
  let acknowledgement = Promise.resolve();
  const pendingNative = new Map<
    number,
    { readonly nativeId: string; remaining: Set<string> | undefined }
  >();
  const nativeSequence = new Map<string, number>();
  const runtimeSequence = new Map<string, number>();

  const validateOwnership = (bindings: ReadonlyArray<ProviderRuntimeBinding>) => {
    const bindingById = new Map(bindings.map((binding) => [binding.threadId, binding]));
    for (const row of sessions.values()) {
      const binding = bindingById.get(row.session.threadId);
      const generation = row.lifecycleGeneration;
      const runtime = binding?.runtimePayload as
        | { providerOptions?: { codex?: { runtimeHost?: string } } }
        | undefined;
      if (
        !generation ||
        binding?.provider !== "codex" ||
        binding.lifecycleGeneration !== generation ||
        runtime?.providerOptions?.codex?.runtimeHost !== "persistent-native" ||
        !cursorThread(binding.resumeCursor) ||
        cursorThread(binding.resumeCursor) !== cursorThread(row.session.resumeCursor)
      ) {
        throw new Error(
          `Persistent host session '${row.session.threadId}' does not match its durable native-only generation and resume cursor`,
        );
      }
      owned.add(row.session.threadId);
      generationByThread.set(row.session.threadId, generation);
    }
    connectionVerified = true;
  };

  const applySnapshot = (next: PersistentHostSnapshot) => {
    if (next.failure !== null) throw new Error(next.failure);
    snapshot = next;
    sessions = new Map(next.sessions.map((row) => [row.session.threadId, row]));
  };
  const open = async (launch: boolean): Promise<HostClient | undefined> => {
    if (retirement) await retirement;
    if (closed) throw new Error("Persistent provider attachment is closed");
    if (client) return client;
    if (!opening) {
      opening = connect(launch)
        .then(async (next) => {
          if (!next) return undefined;
          try {
            applySnapshot(await next.snapshot());
            client = next;
            acknowledgedSequence = snapshot!.acknowledgedSequence;
            receivedSequence = acknowledgedSequence;
            pendingNative.clear();
            nativeSequence.clear();
            runtimeSequence.clear();
            acknowledgement = Promise.resolve();
            lastFailure = undefined;
            return next;
          } catch (error) {
            next.disconnect();
            throw error;
          }
        })
        .finally(() => {
          opening = undefined;
        });
    }
    return opening;
  };
  const flushAcknowledgement = (): Promise<void> => {
    acknowledgement = acknowledgement.then(async () => {
      let through = acknowledgedSequence;
      while (pendingNative.get(through + 1)?.remaining?.size === 0) through++;
      if (through === acknowledgedSequence) return;
      const attached = client;
      if (!attached)
        throw new Error("Cannot acknowledge events without the owning host attachment");
      await attached.acknowledge(through);
      for (let sequence = acknowledgedSequence + 1; sequence <= through; sequence++) {
        const entry = pendingNative.get(sequence);
        if (entry) nativeSequence.delete(entry.nativeId);
        pendingNative.delete(sequence);
      }
      acknowledgedSequence = through;
    });
    return acknowledgement;
  };
  const schedulePoll = (delay = options.pollIntervalMs ?? 100) => {
    if (closed || retiringHost || timer || (!client && owned.size === 0) || !recoveryStarted)
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
    timer.unref();
  };
  const poll = (): Promise<void> => {
    if (polling) return polling;
    polling = (async () => {
      if (closed || retiringHost) return;
      const reconnecting = client === undefined;
      const attached = client ?? (await open(false));
      if (!attached)
        throw new Error("Persistent host is unavailable; no replacement process was launched");
      if (reconnecting) validateOwnership(recoveredBindings);
      // One bounded native batch at a time. A slow durable journal applies
      // backpressure instead of overflowing the adapter callback queue.
      if (pendingNative.size === 0) {
        for (const entry of await attached.events(receivedSequence)) {
          if (entry.sequence !== receivedSequence + 1)
            throw new Error("Persistent host replay has a sequence gap");
          receivedSequence = entry.sequence;
          pendingNative.set(entry.sequence, { nativeId: entry.event.id, remaining: undefined });
          nativeSequence.set(entry.event.id, entry.sequence);
          if (!owned.has(entry.event.threadId)) {
            // Rejected stale ownership is an intentional discard, not an
            // event accepted under a newer thread generation.
            pendingNative.get(entry.sequence)!.remaining = new Set();
          } else if (
            entry.event.lifecycleGeneration !== generationByThread.get(entry.event.threadId)
          ) {
            throw new Error(
              `Persistent host event generation does not own thread '${entry.event.threadId}'`,
            );
          } else {
            local.emit("event", entry.event);
          }
        }
        await flushAcknowledgement();
      }
      applySnapshot(await attached.snapshot());
      lastFailure = undefined;
    })()
      .catch(async (error: unknown) => {
        lastFailure = error instanceof Error ? error : new Error(String(error));
        connectionVerified = false;
        // Preserve the ownership fence and unacknowledged journal. Never turn
        // uncertain transport loss into a fresh prompt or an automatic process.
        client?.disconnect();
        client = undefined;
      })
      .finally(() => {
        polling = undefined;
        schedulePoll(lastFailure ? 1_000 : undefined);
      });
    return polling;
  };
  const awaitAccepted = async (through: number) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (acknowledgedSequence >= through) break;
      await poll();
      if (lastFailure) throw lastFailure;
      await acknowledgement;
      if (acknowledgedSequence >= through) break;
      if (Date.now() >= deadline)
        throw new Error(
          "Persistent host replay could not reach durable acceptance; startup remains fenced",
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const call = async (
    method: PersistentHostMethod,
    args: readonly unknown[],
    operationId: string = randomUUID(),
  ) => {
    const attached = await open(true);
    if (!attached) throw new Error("Persistent host unavailable");
    if (lastFailure) throw lastFailure;
    const result = await attached.call(method, args, operationId);
    applySnapshot(await attached.snapshot());
    schedulePoll(0);
    return result;
  };
  const retireIdleHost = (): Promise<void> => {
    if (retirement) return retirement;
    const attached = client;
    if (!attached) return Promise.resolve();
    retiringHost = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const inFlightPoll = polling;
    retirement = (async () => {
      await inFlightPoll;
      await acknowledgement;
      await attached.terminate();
      client = undefined;
      snapshot = undefined;
      sessions.clear();
      pendingNative.clear();
      nativeSequence.clear();
      runtimeSequence.clear();
      receivedSequence = 0;
      acknowledgedSequence = 0;
      acknowledgement = Promise.resolve();
      lastFailure = undefined;
      connectionVerified = false;
    })().finally(() => {
      retiringHost = false;
      retirement = undefined;
    });
    return retirement;
  };
  const hosted = (threadId: unknown): threadId is ThreadId =>
    typeof threadId === "string" && owned.has(threadId as ThreadId);
  const controls: PersistentCodexManagerControl = {
    async prepareHostReplacement(input) {
      const currentHost = sessions.get(input.threadId)?.session;
      if (owned.has(input.threadId) && !currentHost) {
        throw new Error(
          "Independent Codex session startup or ownership is unresolved; explicitly stop it before replacement",
        );
      }
      const currentLocal = local
        .listSessions()
        .find((session) => session.threadId === input.threadId);
      const previous = owned.has(input.threadId)
        ? currentHost
        : input.persistentNative
          ? currentLocal
          : undefined;
      if (!previous) return undefined;
      if (
        previous.activeTurnId ||
        previous.status === "running" ||
        previous.status === "connecting" ||
        sessions.get(input.threadId)?.awaitingHuman
      ) {
        throw new Error(
          "Stop the current Codex turn before changing its host, workspace or runtime mode",
        );
      }
      if (owned.has(input.threadId)) {
        await (overrides.stopSession as unknown as (threadId: ThreadId) => Promise<unknown>)(
          input.threadId,
        );
      } else {
        await local.stopSession(input.threadId);
      }
      return previous;
    },
    async adoptPersistentSessions(bindings) {
      recoveredBindings = bindings;
      const attached = await open(false);
      if (!attached) return;
      validateOwnership(bindings);
    },
    async preparePersistentRecovery(bindings) {
      await controls.adoptPersistentSessions(bindings);
      recoveryStarted = true;
      if (!client) return;
      const replayThrough = snapshot!.latestSequence;
      await awaitAccepted(replayThrough);
      schedulePoll(0);
    },
    listPersistentSessionThreadIds: () =>
      connectionVerified ? [...sessions.keys()].filter((threadId) => owned.has(threadId)) : [],
    registerPersistentRuntimeEvents(event, events) {
      const sequence = nativeSequence.get(event.id);
      if (sequence === undefined) return;
      const entry = pendingNative.get(sequence);
      if (!entry) return;
      entry.remaining = new Set(events.map((item) => item.eventId));
      for (const item of events) runtimeSequence.set(item.eventId, sequence);
      if (events.length === 0)
        void flushAcknowledgement().catch((error: unknown) => {
          lastFailure = error instanceof Error ? error : new Error(String(error));
        });
    },
    async acknowledgeRuntimeEvent(event) {
      // The durable native journal will replay these events on the next
      // attachment. Closing the backend is not permission to discard them.
      if (closed) return;
      const sequence = runtimeSequence.get(event.eventId);
      if (sequence === undefined) return;
      pendingNative.get(sequence)?.remaining?.delete(event.eventId);
      await flushAcknowledgement();
      runtimeSequence.delete(event.eventId);
    },
    closeForBackendShutdown() {
      if (!closing)
        closing = (async () => {
          closed = true;
          if (timer) clearTimeout(timer);
          timer = undefined;
          await polling;
          await acknowledgement.catch(() => undefined);
          const attached = client;
          client = undefined;
          // Detachment leaves native callbacks and the current turn alive.
          await Promise.all([local.stopAll(), attached?.detach()]);
        })();
      return closing;
    },
  };
  const overrides: Record<string, (...args: never[]) => unknown> = {
    ...controls,
    async startSession(input: CodexAppServerStartSessionInput) {
      if (owned.has(input.threadId)) {
        throw new Error("An existing independent Codex session must be retired before replacement");
      }
      if (input.providerOptions?.codex?.runtimeHost !== "persistent-native")
        return local.startSession(input);
      if (local.hasSession(input.threadId)) {
        throw new Error(
          "The existing backend Codex session must be retired before moving to an independent host",
        );
      }
      if (input.agentGatewayCapabilityInput.enableComputerControl)
        throw new Error(
          "Independent native Codex host cannot provide Metis computer control; disable computer control or use Backend host",
        );
      if (!input.lifecycleGeneration)
        throw new Error("Persistent Codex sessions require a durable lifecycle generation");
      // Reserve ownership before yielding: another start or a final-session
      // stop must see a pending startup even before it has a snapshot row.
      owned.add(input.threadId);
      generationByThread.set(input.threadId, input.lifecycleGeneration);
      recoveryStarted = true;
      const {
        agentGatewayCapabilityInput: _capabilities,
        provider: _provider,
        effort: _effort,
        ...nativeInput
      } = input as CodexAppServerStartSessionInput & { readonly effort?: string };
      try {
        await open(true);
        const result = await call(
          "startSession",
          [{ ...nativeInput, gatewayMode: "native-only" }],
          `start:${input.threadId}:${input.lifecycleGeneration}`,
        );
        connectionVerified = true;
        recoveredBindings = [
          ...recoveredBindings.filter((binding) => binding.threadId !== input.threadId),
          {
            threadId: input.threadId,
            provider: "codex",
            lifecycleGeneration: input.lifecycleGeneration,
            resumeCursor: (result as ProviderSession).resumeCursor,
            runtimePayload: { providerOptions: input.providerOptions },
          },
        ];
        return result;
      } finally {
        // Unknown outcomes retain ownership for recovery; do not retry a
        // native start under a newly generated operation identity.
        schedulePoll(0);
      }
    },
    listSessions: () => [
      ...local.listSessions(),
      ...[...sessions.values()]
        .filter((row) => owned.has(row.session.threadId))
        .map((row) =>
          lastFailure
            ? Object.assign({}, row.session, {
                status: "connecting" as const,
                lastError: `Persistent host connection unavailable: ${lastFailure.message}`,
              })
            : row.session,
        ),
    ],
    hasSession: (threadId: ThreadId) =>
      (owned.has(threadId) && sessions.has(threadId)) || local.hasSession(threadId),
    isTurnActive: (threadId: ThreadId, turnId: string) =>
      hosted(threadId)
        ? sessions.get(threadId)?.session.activeTurnId === turnId
        : local.isTurnActive(
            threadId,
            turnId as Parameters<CodexAppServerManager["isTurnActive"]>[1],
          ),
    isAwaitingHumanResponse: (threadId: ThreadId) =>
      hosted(threadId)
        ? sessions.get(threadId)?.awaitingHuman === true
        : local.isAwaitingHumanResponse(threadId),
    async stopAll() {
      if (client) {
        await call("stopAll", []);
        await awaitAccepted(snapshot!.latestSequence);
        await retireIdleHost();
      }
      await local.stopAll();
      owned.clear();
    },
  };
  const threadMethods = [
    "sendTurn",
    "steerTurn",
    "interruptTurn",
    "readThread",
    "respondToRequest",
    "respondToUserInput",
    "stopSession",
    "compactThread",
    "rollbackThread",
  ] as const;
  for (const method of threadMethods) {
    overrides[method] = async (...args: unknown[]) => {
      const first = args[0];
      const threadId =
        typeof first === "string" ? first : (first as { threadId?: unknown } | undefined)?.threadId;
      if (!hosted(threadId))
        return (local[method] as (...values: unknown[]) => unknown).apply(local, args);
      if (method === "interruptTurn" && args[2] !== undefined)
        throw new Error("Native child-thread interruption is unavailable in the persistent host");
      let operationId: string | undefined;
      let nativeArgs = args;
      if (method === "sendTurn" || method === "steerTurn") {
        const { deliveryId, ...input } = first as { deliveryId?: string } & Record<string, unknown>;
        if (!deliveryId)
          throw new Error("Persistent Codex turn dispatch requires a durable delivery identity");
        operationId = `${method}:${createHash("sha256")
          .update(`${generationByThread.get(threadId)}:${deliveryId}`)
          .digest("hex")}`;
        nativeArgs = [input];
      } else if (method === "respondToRequest" || method === "respondToUserInput") {
        operationId = `${method}:${createHash("sha256")
          .update(`${generationByThread.get(threadId)}:${String(args[1])}`)
          .digest("hex")}`;
      }
      while (nativeArgs.at(-1) === undefined && nativeArgs.length > 0)
        nativeArgs = nativeArgs.slice(0, -1);
      const result = await call(method, nativeArgs, operationId);
      if (method === "stopSession") {
        // Deliver stop terminal events while ownership is still registered.
        await awaitAccepted(snapshot!.latestSequence);
        owned.delete(threadId);
        generationByThread.delete(threadId);
        recoveredBindings = recoveredBindings.filter((binding) => binding.threadId !== threadId);
        if (sessions.size === 0 && owned.size === 0 && client) {
          await retireIdleHost();
        }
      }
      return result;
    };
  }
  overrides.abandonTurn = (threadId: ThreadId, turnId: string, detail: string) =>
    hosted(threadId)
      ? call("abandonTurn", [threadId, turnId, detail])
      : local.abandonTurn(
          threadId,
          turnId as Parameters<CodexAppServerManager["abandonTurn"]>[1],
          detail,
        );
  for (const method of ["startReview", "forkThread"] as const) {
    overrides[method] = (...args: unknown[]) => {
      const first = args[0];
      const input = first as
        | {
            threadId?: unknown;
            sourceThreadId?: unknown;
            providerOptions?: { codex?: { runtimeHost?: string } };
          }
        | undefined;
      if (
        hosted(typeof first === "string" ? first : input?.threadId) ||
        hosted(input?.sourceThreadId) ||
        input?.providerOptions?.codex?.runtimeHost === "persistent-native"
      ) {
        return Promise.reject(
          new Error(`${method} is unavailable for an independent native Codex host`),
        );
      }
      return (local[method] as (...values: unknown[]) => unknown).apply(local, args);
    };
  }
  return new Proxy(local, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PersistentCodexManager;
}
