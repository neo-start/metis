import { EventEmitter } from "node:events";
import {
  EventId,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import type {
  PersistentHostEvent,
  PersistentHostMethod,
  PersistentHostSnapshot,
} from "@synara/contracts/persistentProviderHost";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexAppServerManager,
  CodexAppServerStartSessionInput,
} from "../codexAppServerManager.ts";
import {
  makePersistentCodexManager,
  type PersistentCodexManager,
  type PersistentCodexManagerClient,
} from "./persistentCodexManager.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

const THREAD = ThreadId.makeUnsafe("persistent-facade-thread");
const TURN = TurnId.makeUnsafe("inflight-turn");
const NOW = "2026-10-12T10:00:00.000Z";
const GENERATION = "durable-generation";
const CURSOR = { threadId: "native-thread" };

const session = (): ProviderSession => ({
  provider: "codex",
  threadId: THREAD,
  status: "running",
  runtimeMode: "approval-required",
  activeTurnId: TURN,
  resumeCursor: CURSOR,
  createdAt: NOW,
  updatedAt: NOW,
});

const readySession = (): ProviderSession => {
  const { activeTurnId: _activeTurnId, ...previous } = session();
  return { ...previous, status: "ready" };
};

const binding = (generation = GENERATION): ProviderRuntimeBinding => ({
  threadId: THREAD,
  provider: "codex",
  lifecycleGeneration: generation,
  resumeCursor: CURSOR,
  runtimePayload: { providerOptions: { codex: { runtimeHost: "persistent-native" } } },
});

const startInput = (): CodexAppServerStartSessionInput => ({
  threadId: THREAD,
  lifecycleGeneration: GENERATION,
  runtimeMode: "approval-required",
  providerOptions: { codex: { runtimeHost: "persistent-native" } },
  agentGatewayCapabilityInput: {},
});

const nativeEvent = (id: string): ProviderEvent => ({
  id: EventId.makeUnsafe(id),
  kind: "notification",
  provider: "codex",
  threadId: THREAD,
  turnId: TURN,
  lifecycleGeneration: GENERATION,
  createdAt: NOW,
  method: "turn/started",
});

const canonicalEvent = (id: string): ProviderRuntimeEvent => ({
  eventId: EventId.makeUnsafe(id),
  provider: "codex",
  threadId: THREAD,
  turnId: TURN,
  lifecycleGeneration: GENERATION,
  createdAt: NOW,
  type: "turn.started",
  payload: {},
});

const managers: PersistentCodexManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeForBackendShutdown()));
});

function harness(generation = GENERATION) {
  const state: { snapshot: PersistentHostSnapshot; events: PersistentHostEvent[] } = {
    snapshot: {
      instanceId: "fake-host",
      hostPid: 12345,
      acknowledgedSequence: 0,
      latestSequence: 0,
      failure: null,
      sessions: [
        {
          session: session(),
          providerPid: 12346,
          sessionAttemptId: "original-attempt",
          lifecycleGeneration: generation,
          routable: true,
          awaitingHuman: true,
        },
      ],
      operations: [],
    },
    events: [],
  };
  const local = Object.assign(new EventEmitter(), {
    startSession: vi.fn(async (_input: CodexAppServerStartSessionInput) => session()),
    listSessions: vi.fn((): ProviderSession[] => []),
    hasSession: vi.fn((_threadId: ThreadId) => false),
    isTurnActive: vi.fn((_threadId: ThreadId, _turnId: TurnId) => false),
    isAwaitingHumanResponse: vi.fn((_threadId: ThreadId) => false),
    stopSession: vi.fn(async (_threadId: ThreadId) => undefined),
    stopAll: vi.fn(async () => undefined),
  });
  const host = {
    snapshot: vi.fn(async () => state.snapshot),
    events: vi.fn(async (after = 0) => state.events.filter((event) => event.sequence > after)),
    call: vi.fn(
      async (
        _method: PersistentHostMethod,
        _args: readonly unknown[],
        _operationId: string,
      ): Promise<unknown> => undefined,
    ),
    acknowledge: vi.fn(async (sequence: number) => {
      state.snapshot = { ...state.snapshot, acknowledgedSequence: sequence };
    }),
    detach: vi.fn(async () => undefined),
    disconnect: vi.fn(() => undefined),
    terminate: vi.fn(async () => undefined),
  } satisfies PersistentCodexManagerClient;
  const connect = vi.fn(async (_launch: boolean) => host);
  const manager = makePersistentCodexManager(local as unknown as CodexAppServerManager, {
    stateDir: "/unused-fake-persistent-host-state",
    connect,
    pollIntervalMs: 60_000,
  });
  managers.push(manager);
  return { state, local, host, connect, manager };
}

describe("persistent Codex manager facade", () => {
  it("adopts the same active native session without starting, resuming or replaying before recovery", async () => {
    const { manager, host, local, connect } = harness();
    const onEvent = vi.fn();
    local.on("event", onEvent);

    await manager.adoptPersistentSessions([binding()]);

    expect(connect).toHaveBeenCalledExactlyOnceWith(false);
    expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
    expect(manager.listSessions()).toEqual([session()]);
    expect(manager.hasSession(THREAD)).toBe(true);
    expect(manager.isTurnActive(THREAD, TURN)).toBe(true);
    expect(manager.isAwaitingHumanResponse(THREAD)).toBe(true);
    expect(local.startSession).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
    expect(host.events).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(["generation", "cursor", "provider", "host-mode", "missing-cursor"] as const)(
    "refuses adoption when durable %s ownership does not match",
    async (mismatch) => {
      const { manager, state, host, local } = harness();
      let durable = binding();
      if (mismatch === "generation")
        durable = { ...durable, lifecycleGeneration: "old-generation" };
      if (mismatch === "cursor")
        durable = { ...durable, resumeCursor: { threadId: "other-native-thread" } };
      if (mismatch === "provider") durable = { ...durable, provider: "claudeAgent" };
      if (mismatch === "host-mode") durable = { ...durable, runtimePayload: {} };
      if (mismatch === "missing-cursor") {
        durable = { ...durable, resumeCursor: null };
        const row = state.snapshot.sessions[0]!;
        state.snapshot = {
          ...state.snapshot,
          sessions: [{ ...row, session: { ...row.session, resumeCursor: null } }],
        };
      }

      await expect(manager.adoptPersistentSessions([durable])).rejects.toThrow(/generation|cursor/);
      expect(manager.listPersistentSessionThreadIds()).toEqual([]);
      expect(host.call).not.toHaveBeenCalled();
      expect(host.events).not.toHaveBeenCalled();
      expect(local.startSession).not.toHaveBeenCalled();
    },
  );

  it("retains a native event until every mapped canonical event has durable acceptance", async () => {
    const { manager, state, host, local } = harness();
    const native = nativeEvent("native-1");
    const first = canonicalEvent("canonical-1");
    const second = canonicalEvent("canonical-2");
    state.events = [{ sequence: 1, event: native }];
    state.snapshot = { ...state.snapshot, latestSequence: 1 };
    let emitted!: () => void;
    const emission = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    local.on("event", (event: ProviderEvent) => {
      manager.registerPersistentRuntimeEvents(event, [first, second]);
      emitted();
    });
    let ready = false;
    const recovery = manager.preparePersistentRecovery([binding()]).then(() => {
      ready = true;
    });
    await emission;

    expect(ready).toBe(false);
    expect(host.acknowledge).not.toHaveBeenCalled();
    await manager.acknowledgeRuntimeEvent(first);
    expect(host.acknowledge).not.toHaveBeenCalled();
    expect(ready).toBe(false);
    await manager.acknowledgeRuntimeEvent(second);
    await recovery;

    expect(host.acknowledge).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.snapshot.acknowledgedSequence).toBe(1);
    expect(ready).toBe(true);
    expect(host.call).not.toHaveBeenCalled();
  });

  it("accepts deliberately unmapped native events without waiting for a nonexistent canonical event", async () => {
    const { manager, state, host, local } = harness();
    state.events = [{ sequence: 1, event: nativeEvent("ignored-native") }];
    state.snapshot = { ...state.snapshot, latestSequence: 1 };
    const onEvent = vi.fn((event: ProviderEvent) =>
      manager.registerPersistentRuntimeEvents(event, []),
    );
    local.on("event", onEvent);

    await manager.preparePersistentRecovery([binding()]);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(host.acknowledge).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps replay identities stable per delivery while separating methods and lifecycle generations", async () => {
    const first = harness();
    const next = harness("next-generation");
    await first.manager.adoptPersistentSessions([binding()]);
    await next.manager.adoptPersistentSessions([binding("next-generation")]);
    const input = { threadId: THREAD, deliveryId: "turn-command-1", input: "Continue." };

    await first.manager.sendTurn(input);
    await first.manager.sendTurn(input);
    await first.manager.steerTurn(input);
    await next.manager.sendTurn(input);

    const calls = first.host.call.mock.calls;
    expect(calls.map(([method]) => method)).toEqual(["sendTurn", "sendTurn", "steerTurn"]);
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(calls[0]![2]).not.toBe(calls[2]![2]);
    expect(calls[0]![2]).not.toBe(next.host.call.mock.calls[0]![2]);
    expect(calls[0]![2]).toMatch(/^sendTurn:/);
    expect(calls[2]![2]).toMatch(/^steerTurn:/);
    expect(calls.every(([, args]) => !Object.hasOwn(args[0] as object, "deliveryId"))).toBe(true);
    expect(calls[0]![1]).toEqual([{ threadId: THREAD, input: "Continue." }]);
  });

  it("refuses hosted turn dispatch without a durable delivery identity", async () => {
    const { manager, host } = harness();
    await manager.adoptPersistentSessions([binding()]);

    await expect(manager.sendTurn({ threadId: THREAD, input: "Continue." })).rejects.toThrow(
      /delivery identity/,
    );
    await expect(manager.steerTurn({ threadId: THREAD, input: "Continue." })).rejects.toThrow(
      /delivery identity/,
    );
    expect(host.call).not.toHaveBeenCalled();
  });

  it("does not report a persistent session after a failed start with no actual host session", async () => {
    const { manager, state, host, local } = harness();
    state.snapshot = { ...state.snapshot, sessions: [] };
    host.call.mockRejectedValue(new Error("native startup failed"));

    await expect(manager.startSession(startInput())).rejects.toThrow("native startup failed");

    expect(manager.hasSession(THREAD)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
    expect(manager.listPersistentSessionThreadIds()).toEqual([]);
    expect(local.startSession).not.toHaveBeenCalled();
  });

  it("leaves ordinary gateway session startup on the local manager unchanged", async () => {
    const { manager, local, connect, host } = harness();
    const input: CodexAppServerStartSessionInput = {
      ...startInput(),
      providerOptions: { codex: { runtimeHost: "backend" } },
      agentGatewayCapabilityInput: { enableComputerControl: true },
    };

    await expect(manager.startSession(input)).resolves.toEqual(session());

    expect(local.startSession).toHaveBeenCalledExactlyOnceWith(input);
    expect(connect).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
    expect(manager.listPersistentSessionThreadIds()).toEqual([]);
  });

  it("terminates the host only after explicitly stopping its final session", async () => {
    const { manager, state, host } = harness();
    await manager.adoptPersistentSessions([binding()]);
    host.call.mockImplementation(async (method) => {
      if (method === "stopSession") state.snapshot = { ...state.snapshot, sessions: [] };
    });

    await manager.stopSession(THREAD);

    expect(host.call).toHaveBeenCalledWith("stopSession", [THREAD], expect.any(String));
    expect(host.terminate).toHaveBeenCalledExactlyOnceWith();
    expect(host.detach).not.toHaveBeenCalled();
    expect(manager.listPersistentSessionThreadIds()).toEqual([]);
    expect(manager.hasSession(THREAD)).toBe(false);
  });

  it("detaches on backend shutdown while leaving the hosted active turn untouched", async () => {
    const { manager, host, local, state } = harness();
    await manager.adoptPersistentSessions([binding()]);

    await manager.closeForBackendShutdown();
    await manager.closeForBackendShutdown();

    expect(host.detach).toHaveBeenCalledExactlyOnceWith();
    expect(host.terminate).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
    expect(local.stopAll).toHaveBeenCalledExactlyOnceWith();
    expect(state.snapshot.sessions[0]?.session.activeTurnId).toBe(TURN);
    expect(state.snapshot.sessions[0]?.awaitingHuman).toBe(true);
  });

  it("routes watchdog abandonment to the native abandon operation with its diagnostic detail", async () => {
    const { manager, host } = harness();
    await manager.adoptPersistentSessions([binding()]);

    await manager.abandonTurn(THREAD, TURN, "The active turn exceeded its idle limit.");

    expect(host.call).toHaveBeenCalledExactlyOnceWith(
      "abandonTurn",
      [THREAD, TURN, "The active turn exceeded its idle limit."],
      expect.any(String),
    );
  });

  describe("host replacement", () => {
    it("reserves thread ownership before the first native host connection resolves", async () => {
      const { manager, host, connect, state, local } = harness();
      const row = state.snapshot.sessions[0]!;
      state.snapshot = { ...state.snapshot, sessions: [] };
      let release!: () => void;
      const connected = new Promise<void>((resolve) => {
        release = resolve;
      });
      connect.mockImplementation(async () => {
        await connected;
        return host;
      });
      host.call.mockImplementation(async (method) => {
        if (method === "startSession") {
          state.snapshot = { ...state.snapshot, sessions: [row] };
          return row.session;
        }
        return undefined;
      });
      const startup = manager.startSession(startInput());

      try {
        expect(connect).toHaveBeenCalledExactlyOnceWith(true);
        expect(host.call).not.toHaveBeenCalled();
        for (const runtimeHost of ["persistent-native", "backend"] as const) {
          await expect(
            manager.startSession({
              ...startInput(),
              lifecycleGeneration: "competing-generation",
              providerOptions: { codex: { runtimeHost } },
            }),
          ).rejects.toThrow(/retired|unresolved|pending/i);
        }
        expect(local.startSession).not.toHaveBeenCalled();
        expect(connect).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await startup;
      }

      expect(host.call).toHaveBeenCalledTimes(1);
      expect(host.call.mock.calls[0]![1]).toMatchObject([
        {
          threadId: THREAD,
          lifecycleGeneration: GENERATION,
        },
      ]);
      expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
    });

    it("keeps a host alive while another native start owns a pending session", async () => {
      const { manager, host, state, local } = harness();
      const existing = state.snapshot.sessions[0]!;
      state.snapshot = {
        ...state.snapshot,
        sessions: [{ ...existing, session: readySession(), awaitingHuman: false }],
      };
      await manager.adoptPersistentSessions([binding()]);
      const pendingThread = ThreadId.makeUnsafe("pending-native-session");
      const pendingGeneration = "pending-native-generation";
      const pendingSession: ProviderSession = {
        ...readySession(),
        threadId: pendingThread,
        resumeCursor: { threadId: "pending-native-thread" },
      };
      let admit!: () => void;
      let complete!: () => void;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      host.call.mockImplementation(async (method, args) => {
        if (method === "startSession") {
          admit();
          await completion;
          state.snapshot = {
            ...state.snapshot,
            sessions: [
              {
                ...existing,
                session: pendingSession,
                lifecycleGeneration: pendingGeneration,
                sessionAttemptId: "pending-attempt",
                awaitingHuman: false,
              },
            ],
          };
          return pendingSession;
        }
        if (method === "stopSession") {
          state.snapshot = {
            ...state.snapshot,
            sessions: state.snapshot.sessions.filter((row) => row.session.threadId !== args[0]),
          };
        }
        return undefined;
      });
      const input: CodexAppServerStartSessionInput = {
        ...startInput(),
        threadId: pendingThread,
        lifecycleGeneration: pendingGeneration,
      };
      const startup = manager.startSession(input);
      await admitted;

      try {
        expect(state.snapshot.sessions.map((row) => row.session.threadId)).toEqual([THREAD]);
        await manager.stopSession(THREAD);
        expect(state.snapshot.sessions).toEqual([]);
        expect(host.terminate).not.toHaveBeenCalled();
        expect(manager.hasSession(pendingThread)).toBe(false);

        for (const runtimeHost of ["persistent-native", "backend"] as const) {
          await expect(
            manager.startSession({
              ...input,
              lifecycleGeneration: "competing-generation",
              providerOptions: { codex: { runtimeHost } },
            }),
          ).rejects.toThrow(/retired|unresolved|pending/i);
          await expect(
            manager.prepareHostReplacement({
              threadId: pendingThread,
              persistentNative: runtimeHost === "persistent-native",
            }),
          ).rejects.toThrow(/unresolved|pending|uncertain|ownership/i);
        }
        expect(local.startSession).not.toHaveBeenCalled();
        expect(local.stopSession).not.toHaveBeenCalled();
        expect(host.call.mock.calls.map(([method]) => method)).toEqual([
          "startSession",
          "stopSession",
        ]);
      } finally {
        complete();
        await startup;
      }

      expect(manager.listPersistentSessionThreadIds()).toEqual([pendingThread]);
      expect(state.snapshot.sessions[0]?.lifecycleGeneration).toBe(pendingGeneration);
      expect(host.call.mock.calls[0]![1]).toMatchObject([
        {
          threadId: pendingThread,
          lifecycleGeneration: pendingGeneration,
        },
      ]);
      await manager.stopSession(pendingThread);
      expect(host.terminate).toHaveBeenCalledExactlyOnceWith();
      expect(manager.listPersistentSessionThreadIds()).toEqual([]);
    });

    it("keeps an uncertain start fenced until an explicit stop is confirmed", async () => {
      const { manager, host, state, local } = harness();
      state.snapshot = { ...state.snapshot, sessions: [] };
      let confirmStop = false;
      host.call.mockImplementation(async (method) => {
        if (method === "startSession") throw new Error("start outcome uncertain");
        if (method === "stopSession" && !confirmStop) throw new Error("stop outcome uncertain");
        return undefined;
      });

      await expect(manager.startSession(startInput())).rejects.toThrow("start outcome uncertain");
      expect(manager.hasSession(THREAD)).toBe(false);
      expect(manager.listPersistentSessionThreadIds()).toEqual([]);
      for (const runtimeHost of ["persistent-native", "backend"] as const) {
        await expect(
          manager.startSession({
            ...startInput(),
            lifecycleGeneration: "competing-generation",
            providerOptions: { codex: { runtimeHost } },
          }),
        ).rejects.toThrow(/retired|unresolved|pending/i);
        await expect(
          manager.prepareHostReplacement({
            threadId: THREAD,
            persistentNative: runtimeHost === "persistent-native",
          }),
        ).rejects.toThrow(/unresolved|pending|uncertain|ownership/i);
      }
      expect(host.call).toHaveBeenCalledTimes(1);
      expect(local.startSession).not.toHaveBeenCalled();

      await expect(manager.stopSession(THREAD)).rejects.toThrow("stop outcome uncertain");
      expect(host.terminate).not.toHaveBeenCalled();
      await expect(
        manager.startSession({
          ...startInput(),
          providerOptions: { codex: { runtimeHost: "backend" } },
        }),
      ).rejects.toThrow(/retired|unresolved|pending/i);
      expect(local.startSession).not.toHaveBeenCalled();

      confirmStop = true;
      await manager.stopSession(THREAD);
      expect(host.terminate).toHaveBeenCalledExactlyOnceWith();
      const backendInput: CodexAppServerStartSessionInput = {
        ...startInput(),
        providerOptions: { codex: { runtimeHost: "backend" } },
      };
      await manager.startSession(backendInput);
      expect(local.startSession).toHaveBeenCalledExactlyOnceWith(backendInput);
    });

    it.each([
      { state: "running", persistentNative: true },
      { state: "running", persistentNative: false },
      { state: "connecting", persistentNative: true },
      { state: "connecting", persistentNative: false },
      { state: "awaiting-human", persistentNative: true },
      { state: "awaiting-human", persistentNative: false },
    ] as const)(
      "preserves $state host ownership before replacement to persistentNative=$persistentNative",
      async ({ state: runtimeState, persistentNative }) => {
        const { manager, state, local, host } = harness();
        const previous =
          runtimeState === "running"
            ? session()
            : {
                ...readySession(),
                status:
                  runtimeState === "connecting" ? ("connecting" as const) : ("ready" as const),
              };
        const row = state.snapshot.sessions[0]!;
        state.snapshot = {
          ...state.snapshot,
          sessions: [
            { ...row, session: previous, awaitingHuman: runtimeState === "awaiting-human" },
          ],
        };
        await manager.adoptPersistentSessions([binding()]);

        await expect(
          manager.prepareHostReplacement({ threadId: THREAD, persistentNative }),
        ).rejects.toThrow(/Stop the current Codex turn/);

        expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
        expect(manager.listSessions()).toEqual([previous]);
        expect(state.snapshot.sessions[0]?.lifecycleGeneration).toBe(GENERATION);
        expect(host.call).not.toHaveBeenCalled();
        expect(host.terminate).not.toHaveBeenCalled();
        expect(local.stopSession).not.toHaveBeenCalled();
        expect(local.startSession).not.toHaveBeenCalled();
        await expect(manager.adoptPersistentSessions([binding()])).resolves.toBeUndefined();
      },
    );

    it.each(["persistent-native", "backend"] as const)(
      "rejects direct %s replacement without overwriting the active generation",
      async (runtimeHost) => {
        const { manager, host, local } = harness();
        await manager.adoptPersistentSessions([binding()]);
        const delivery = {
          threadId: THREAD,
          deliveryId: "old-generation-steer",
          input: "Keep the current task.",
        };
        await manager.steerTurn(delivery);
        const originalOperationId = host.call.mock.calls[0]![2];

        await expect(
          manager.startSession({
            ...startInput(),
            lifecycleGeneration: "replacement-generation",
            providerOptions: { codex: { runtimeHost } },
          }),
        ).rejects.toThrow(/must be retired before replacement/);

        expect(host.call).toHaveBeenCalledTimes(1);
        expect(local.startSession).not.toHaveBeenCalled();
        expect(manager.isTurnActive(THREAD, TURN)).toBe(true);
        expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
        await manager.steerTurn(delivery);
        expect(host.call.mock.calls[1]![2]).toBe(originalOperationId);
      },
    );

    it.each(["backend", "persistent-native"] as const)(
      "retires a ready hosted session after durable replay before starting its %s replacement",
      async (runtimeHost) => {
        const { manager, host, state, local } = harness();
        const previous = readySession();
        const row = state.snapshot.sessions[0]!;
        state.snapshot = {
          ...state.snapshot,
          sessions: [{ ...row, session: previous, awaitingHuman: false }],
        };
        await manager.adoptPersistentSessions([binding()]);
        const canonical = canonicalEvent("buffered-before-retirement");
        let emitted!: () => void;
        const emission = new Promise<void>((resolve) => {
          emitted = resolve;
        });
        local.on("event", (event: ProviderEvent) => {
          manager.registerPersistentRuntimeEvents(event, [canonical]);
          emitted();
        });
        host.call.mockImplementation(async (method) => {
          if (method === "stopSession") {
            state.events = [
              { sequence: 1, event: nativeEvent("buffered-native-before-retirement") },
            ];
            state.snapshot = { ...state.snapshot, sessions: [], latestSequence: 1 };
          }
          if (method === "startSession") {
            state.snapshot = {
              ...state.snapshot,
              sessions: [
                {
                  ...row,
                  session: previous,
                  lifecycleGeneration: "replacement-generation",
                  awaitingHuman: false,
                },
              ],
            };
            return previous;
          }
          return undefined;
        });
        let retired = false;
        const retirement = manager
          .prepareHostReplacement({
            threadId: THREAD,
            persistentNative: runtimeHost === "persistent-native",
          })
          .then((result) => {
            retired = true;
            return result;
          });
        await emission;

        expect(retired).toBe(false);
        expect(host.terminate).not.toHaveBeenCalled();
        expect(local.startSession).not.toHaveBeenCalled();
        await manager.acknowledgeRuntimeEvent(canonical);
        await expect(retirement).resolves.toEqual(previous);
        expect(host.acknowledge).toHaveBeenCalledExactlyOnceWith(1);
        expect(host.terminate).toHaveBeenCalledExactlyOnceWith();
        expect(manager.hasSession(THREAD)).toBe(false);

        const input: CodexAppServerStartSessionInput = {
          ...startInput(),
          resumeCursor: previous.resumeCursor,
          lifecycleGeneration: "replacement-generation",
          providerOptions: { codex: { runtimeHost } },
        };
        await manager.startSession(input);

        if (runtimeHost === "backend") {
          expect(local.startSession).toHaveBeenCalledExactlyOnceWith(input);
          expect(host.call.mock.calls.map(([method]) => method)).toEqual(["stopSession"]);
          expect(manager.listPersistentSessionThreadIds()).toEqual([]);
        } else {
          expect(local.startSession).not.toHaveBeenCalled();
          expect(host.call.mock.calls.map(([method]) => method)).toEqual([
            "stopSession",
            "startSession",
          ]);
          expect(host.call.mock.calls[1]![1]).toMatchObject([
            {
              threadId: THREAD,
              lifecycleGeneration: "replacement-generation",
              resumeCursor: previous.resumeCursor,
              gatewayMode: "native-only",
            },
          ]);
          expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
        }
      },
    );

    it("stops a ready backend session before allowing a native host start", async () => {
      const { manager, host, state, local, connect } = harness();
      const previous = readySession();
      let localSessions = [previous];
      local.listSessions.mockImplementation(() => localSessions);
      local.hasSession.mockImplementation((threadId) =>
        localSessions.some((entry) => entry.threadId === threadId),
      );
      local.stopSession.mockImplementation(async () => {
        localSessions = [];
      });
      state.snapshot = { ...state.snapshot, sessions: [] };
      host.call.mockImplementation(async (method) => {
        if (method !== "startSession") return undefined;
        expect(localSessions).toEqual([]);
        expect(local.stopSession).toHaveBeenCalledExactlyOnceWith(THREAD);
        state.snapshot = {
          ...state.snapshot,
          sessions: [
            {
              session: previous,
              lifecycleGeneration: GENERATION,
              providerPid: 12346,
              sessionAttemptId: "replacement-attempt",
              awaitingHuman: false,
              routable: true,
            },
          ],
        };
        return previous;
      });

      await expect(manager.startSession(startInput())).rejects.toThrow(
        /backend Codex session must be retired/,
      );
      expect(connect).not.toHaveBeenCalled();
      await expect(
        manager.prepareHostReplacement({ threadId: THREAD, persistentNative: true }),
      ).resolves.toEqual(previous);
      expect(connect).not.toHaveBeenCalled();
      await expect(
        manager.startSession({ ...startInput(), resumeCursor: previous.resumeCursor }),
      ).resolves.toEqual(previous);

      expect(local.stopSession).toHaveBeenCalledExactlyOnceWith(THREAD);
      expect(local.startSession).not.toHaveBeenCalled();
      expect(host.call).toHaveBeenCalledTimes(1);
      expect(manager.listPersistentSessionThreadIds()).toEqual([THREAD]);
    });
  });
});
