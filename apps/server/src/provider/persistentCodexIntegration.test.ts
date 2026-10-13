import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { CodexAppServerManager } from "../codexAppServerManager.ts";
import { ServerConfig } from "../config.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderRuntimeEventRepository } from "../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderUnsupportedError } from "./Errors.ts";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter.ts";
import { makeDurableProviderServiceLive } from "./Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory.ts";
import { makePersistentCodexManager } from "./persistentCodexManager.ts";
import { launchOrConnectCodexHost, PersistentCodexHostClient } from "./persistentHost/client.ts";
import { CodexAdapter } from "./Services/CodexAdapter.ts";
import { ProviderAdapterRegistry } from "./Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";

const fixtures = path.join(import.meta.dirname, "persistentHost", "fixtures");
const supported = process.platform === "darwin" || process.platform === "linux";
const threadId = ThreadId.makeUnsafe("durable-host-thread");

async function waitUntil<T>(
  label: string,
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 8_000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function protocolMessages(root: string) {
  return readFileSync(path.join(root, "protocol.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: unknown;
          result?: unknown;
        },
    );
}

function makeBackend(root: string) {
  const hostDirectory = path.join(root, "host");
  let client: PersistentCodexHostClient | undefined;
  const manager = makePersistentCodexManager(new CodexAppServerManager(), {
    stateDir: root,
    pollIntervalMs: 10,
    connect: async (launch) => {
      if (!launch && !existsSync(path.join(hostDirectory, "descriptor.json"))) return undefined;
      client = await launchOrConnectCodexHost({
        directory: hostDirectory,
        executable: process.env.METIS_HOST_TEST_BUN_EXECUTABLE ?? "bun",
        args: [path.join(fixtures, "host.ts")],
        env: {
          ...process.env,
          SYNARA_HOME: path.join(root, "host-home"),
          CODEX_HOME: path.join(root, "codex-home"),
          METIS_FAKE_PROTOCOL_DIRECTORY: root,
        },
      });
      return client;
    },
  });
  const persistence = makeSqlitePersistenceLive(path.join(root, "state.sqlite"));
  const runtimeRepository = ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(persistence));
  const events = ProviderRuntimeEventRepositoryLive.pipe(Layer.provide(persistence));
  const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository));
  const adapter = makeCodexAdapterLive({ manager }).pipe(
    Layer.provide(directory),
    Layer.provide(ServerConfig.layerTest(root, path.join(root, "backend-home"))),
  );
  const registry = Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const codex = yield* CodexAdapter;
      return {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"] as const),
      } satisfies typeof ProviderAdapterRegistry.Service;
    }),
  ).pipe(Layer.provide(adapter));
  const provider = makeDurableProviderServiceLive({ runtimeIdleStopMs: 0 }).pipe(
    Layer.provide(registry),
    Layer.provide(directory),
    Layer.provide(events),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(provider, directory, events).pipe(Layer.provide(NodeServices.layer)),
  );
  let closed = false;
  return {
    runtime,
    manager,
    snapshot: () => {
      if (!client) throw new Error("Expected an attached persistent host");
      return client.snapshot();
    },
    services: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          return {
            provider: yield* ProviderService,
            directory: yield* ProviderSessionDirectory,
            events: yield* ProviderRuntimeEventRepository,
          };
        }),
      ),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const service = yield* ProviderService;
            yield* service.closeRuntimeEvents;
          }),
        );
      } finally {
        await runtime.dispose();
      }
    },
  };
}

async function openBackend(root: string) {
  const backend = makeBackend(root);
  const services = await backend.services();
  await backend.runtime.runPromise(services.provider.adoptPersistentHostSessions!());
  await backend.runtime.runPromise(services.provider.preparePersistentHostRecovery!());
  return {
    ...backend,
    ...services,
    readEvents: () =>
      backend.runtime.runPromise(
        services.events.readThreadEvents({
          threadId,
          throughSequenceInclusive: Number.MAX_SAFE_INTEGER,
          limit: 1_000,
        }),
      ),
  };
}

describe.skipIf(!supported)("persistent Codex service integration", () => {
  it("adopts SQLite-bound sessions across backend replacement and preserves human replies and canonical event identity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "metis-persistent-codex-service-"));
    chmodSync(root, 0o700);
    const binaryPath = path.join(root, "fake codex.mjs");
    // Extend this test's private copy with the native resume response needed
    // when an explicit runtime-mode change replaces an idle provider process.
    writeFileSync(
      binaryPath,
      readFileSync(path.join(fixtures, "fake-codex.mjs"), "utf8").replace(
        'else if (method === "thread/start")',
        'else if (method === "thread/start" || method === "thread/resume")',
      ),
      { mode: 0o700 },
    );
    chmodSync(binaryPath, 0o700);
    const homePath = path.join(root, "codex-home");
    mkdirSync(homePath);
    writeFileSync(path.join(homePath, "config.toml"), "", { mode: 0o600 });
    const backends: Array<ReturnType<typeof makeBackend>> = [];
    const modelSelection = {
      provider: "codex" as const,
      model: "gpt-5.4",
      options: { reasoningEffort: "high" as const },
    };
    const turnInput = {
      threadId,
      deliveryId: "durable-turn-once",
      input: "one prompt",
      modelSelection,
    };
    try {
      const first = await openBackend(root);
      backends.push(first);
      await first.runtime.runPromise(
        first.provider.startSession(threadId, {
          threadId,
          provider: "codex",
          cwd: root,
          runtimeMode: "approval-required",
          modelSelection,
          providerOptions: {
            codex: { binaryPath, homePath, runtimeHost: "persistent-native" },
          },
        }),
      );
      const accepted = await first.runtime.runPromise(first.provider.sendTurn(turnInput));
      const beforeEvents = await waitUntil("durable approval", first.readEvents, (rows) =>
        rows.some(({ event }) => event.type === "request.opened"),
      );
      const approval = beforeEvents.find(({ event }) => event.type === "request.opened")!.event;
      expect(approval.requestId).toBeDefined();
      const before = await first.snapshot();
      const providerPid = before.sessions[0]!.providerPid;
      expect(before.sessions[0]!.session.activeTurnId).toBe("native-turn-1");
      expect(before.sessions[0]!.awaitingHuman).toBe(true);
      const originalBinding = Option.getOrThrow(
        await first.runtime.runPromise(first.directory.getBinding(threadId)),
      );

      await first.close();
      expect(isAlive(before.hostPid)).toBe(true);
      expect(isAlive(providerPid)).toBe(true);

      const second = await openBackend(root);
      backends.push(second);
      const adopted = await second.snapshot();
      expect(adopted.hostPid).toBe(before.hostPid);
      expect(adopted.sessions[0]!.providerPid).toBe(providerPid);
      expect(adopted.sessions[0]!.sessionAttemptId).toBe(before.sessions[0]!.sessionAttemptId);
      expect(adopted.sessions[0]!.session.activeTurnId).toBe("native-turn-1");
      expect(
        await second.runtime.runPromise(second.provider.listPersistentSessionThreadIds!()),
      ).toEqual([threadId]);
      const recoveredBinding = Option.getOrThrow(
        await second.runtime.runPromise(second.directory.getBinding(threadId)),
      );
      expect(recoveredBinding.lifecycleGeneration).toBe(originalBinding.lifecycleGeneration);
      expect(recoveredBinding.resumeCursor).toEqual(originalBinding.resumeCursor);
      expect(
        (await second.readEvents()).filter(({ event }) => event.eventId === approval.eventId),
      ).toHaveLength(1);
      const replayed = await second.runtime.runPromise(second.provider.sendTurn(turnInput));
      expect(replayed).toEqual(accepted);
      await second.runtime.runPromise(
        second.provider.respondToRequest({
          threadId,
          requestId: ApprovalRequestId.makeUnsafe(String(approval.requestId)),
          lifecycleGeneration: originalBinding.lifecycleGeneration,
          decision: "accept",
        }),
      );
      const inputEvents = await waitUntil("durable user input", second.readEvents, (rows) =>
        rows.some(({ event }) => event.type === "user-input.requested"),
      );
      const input = inputEvents.find(({ event }) => event.type === "user-input.requested")!.event;
      expect(input.requestId).toBeDefined();
      await second.close();

      const third = await openBackend(root);
      backends.push(third);
      expect((await third.snapshot()).sessions[0]!.providerPid).toBe(providerPid);
      await third.runtime.runPromise(
        third.provider.respondToUserInput({
          threadId,
          requestId: ApprovalRequestId.makeUnsafe(String(input.requestId)),
          lifecycleGeneration: originalBinding.lifecycleGeneration,
          answers: { q: "yes" },
        }),
      );
      const completed = await waitUntil("durable completion", third.readEvents, (rows) =>
        rows.some(({ event }) => event.type === "turn.completed"),
      );
      expect(new Set(completed.map(({ event }) => event.eventId)).size).toBe(completed.length);
      for (const { event: previous } of beforeEvents) {
        expect(completed.filter(({ event }) => event.eventId === previous.eventId)).toHaveLength(1);
      }
      const protocol = protocolMessages(root);
      expect(protocol.filter((message) => message.method === "initialize")).toHaveLength(1);
      expect(protocol.filter((message) => message.method === "thread/start")).toHaveLength(1);
      expect(protocol.filter((message) => message.method === "thread/resume")).toHaveLength(0);
      expect(protocol.filter((message) => message.method === "turn/start")).toHaveLength(1);
      expect(protocol.find((message) => message.method === "turn/start")?.params).toMatchObject({
        model: "gpt-5.4",
        effort: "high",
      });
      expect(protocol.filter((message) => message.id === "approve" && message.result)).toHaveLength(
        1,
      );
      expect(protocol.filter((message) => message.id === "input" && message.result)).toHaveLength(
        1,
      );

      await waitUntil(
        "idle native session",
        third.snapshot,
        (snapshot) =>
          snapshot.sessions[0]?.session.status === "ready" &&
          snapshot.sessions[0]?.session.activeTurnId === undefined,
      );
      const beforeReplacement = Option.getOrThrow(
        await third.runtime.runPromise(third.directory.getBinding(threadId)),
      );
      const replacement = await third.runtime.runPromise(
        third.provider.startSession(threadId, {
          threadId,
          provider: "codex",
          cwd: root,
          runtimeMode: "full-access",
          modelSelection,
          providerOptions: {
            codex: { binaryPath, homePath, runtimeHost: "persistent-native" },
          },
        }),
      );
      // Replacement must not report success until the old host and provider
      // have exited, and it must resume native context without another turn.
      expect(isAlive(before.hostPid)).toBe(false);
      expect(isAlive(providerPid)).toBe(false);
      const replaced = await third.snapshot();
      const replacementProviderPid = replaced.sessions[0]!.providerPid;
      expect(replaced.hostPid).not.toBe(before.hostPid);
      expect(replacementProviderPid).not.toBe(providerPid);
      expect(isAlive(replaced.hostPid)).toBe(true);
      expect(isAlive(replacementProviderPid)).toBe(true);
      expect(replacement.runtimeMode).toBe("full-access");
      expect(replacement.resumeCursor).toEqual(beforeReplacement.resumeCursor);
      const afterReplacement = Option.getOrThrow(
        await third.runtime.runPromise(third.directory.getBinding(threadId)),
      );
      expect(afterReplacement.lifecycleGeneration).not.toBe(beforeReplacement.lifecycleGeneration);
      expect(afterReplacement.resumeCursor).toEqual(beforeReplacement.resumeCursor);
      const afterReplacementProtocol = protocolMessages(root);
      expect(
        afterReplacementProtocol.filter((message) => message.method === "initialize"),
      ).toHaveLength(2);
      expect(
        afterReplacementProtocol.filter((message) => message.method === "thread/start"),
      ).toHaveLength(1);
      expect(
        afterReplacementProtocol.filter((message) => message.method === "thread/resume"),
      ).toHaveLength(1);
      expect(
        afterReplacementProtocol.filter((message) => message.method === "turn/start"),
      ).toHaveLength(1);

      await third.runtime.runPromise(third.provider.stopSession({ threadId }));
      await waitUntil(
        "explicit provider and host termination",
        () => isAlive(replaced.hostPid) || isAlive(replacementProviderPid),
        (alive) => !alive,
      );
      expect(existsSync(path.join(root, "host", "descriptor.json"))).toBe(false);
    } finally {
      for (const backend of backends.toReversed()) await backend.close();
      if (existsSync(path.join(root, "host", "descriptor.json"))) {
        const cleanup = await PersistentCodexHostClient.connect(path.join(root, "host"));
        await cleanup.terminate();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("isolates unavailable host recovery without replacing its durable native session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "metis-unavailable-codex-host-"));
    chmodSync(root, 0o700);
    const generation = "unavailable-native-generation";
    const resumeCursor = { threadId: "unavailable-native-thread" };
    const backends: Array<ReturnType<typeof makeBackend>> = [];
    try {
      const first = makeBackend(root);
      backends.push(first);
      const firstServices = await first.services();
      await first.runtime.runPromise(
        firstServices.directory.upsert({
          threadId,
          provider: "codex",
          status: "running",
          lifecycleGeneration: generation,
          runtimeMode: "approval-required",
          resumeCursor,
          runtimePayload: {
            cwd: root,
            activeTurnId: "unavailable-native-turn",
            providerOptions: { codex: { runtimeHost: "persistent-native" } },
          },
        }),
      );
      await first.close();

      const hostDirectory = path.join(root, "host");
      mkdirSync(hostDirectory, { mode: 0o700 });
      const descriptorPath = path.join(hostDirectory, "descriptor.json");
      writeFileSync(descriptorPath, "{}", { mode: 0o600 });
      const second = makeBackend(root);
      backends.push(second);
      const { provider, directory, events } = await second.services();
      await second.runtime.runPromise(provider.adoptPersistentHostSessions!());
      await second.runtime.runPromise(provider.preparePersistentHostRecovery!());
      expect(await second.runtime.runPromise(provider.listPersistentSessionThreadIds!())).toEqual(
        [],
      );
      expect(
        await second.runtime.runPromise(provider.listPersistentRecoveryBlockedThreadIds!()),
      ).toEqual([threadId]);
      const sessions = await second.runtime.runPromise(provider.listSessions());
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        threadId,
        provider: "codex",
        status: "connecting",
        resumeCursor,
      });
      expect(sessions[0]!.lastError).toContain("Independent Codex host recovery is unavailable");
      await expect(
        second.runtime.runPromise(
          provider.sendTurn({
            threadId,
            deliveryId: "must-not-dispatch",
            input: "must not restart an uncertain native turn",
          }),
        ),
      ).rejects.toThrow("Independent Codex host recovery is unavailable");
      await expect(
        second.runtime.runPromise(
          provider.startSession(threadId, {
            threadId,
            provider: "codex",
            runtimeMode: "approval-required",
            providerOptions: { codex: { runtimeHost: "backend" } },
          }),
        ),
      ).rejects.toThrow("Independent Codex host recovery is unavailable");
      expect(await second.runtime.runPromise(provider.getCapabilities("codex"))).toBeDefined();
      const journal = await second.runtime.runPromise(
        events.readThreadEvents({
          threadId,
          throughSequenceInclusive: Number.MAX_SAFE_INTEGER,
          limit: 100,
        }),
      );
      expect(journal.some(({ event }) => event.type === "runtime.warning")).toBe(true);
      expect(
        Option.getOrThrow(await second.runtime.runPromise(directory.getBinding(threadId))),
      ).toMatchObject({ lifecycleGeneration: generation, resumeCursor });
      await second.close();

      const third = makeBackend(root);
      backends.push(third);
      const thirdServices = await third.services();
      const retained = Option.getOrThrow(
        await third.runtime.runPromise(thirdServices.directory.getBinding(threadId)),
      );
      expect(retained).toMatchObject({ lifecycleGeneration: generation, resumeCursor });
      expect(retained.runtimePayload).toMatchObject({
        providerOptions: { codex: { runtimeHost: "persistent-native" } },
      });
      expect(readFileSync(descriptorPath, "utf8")).toBe("{}");
      expect(existsSync(path.join(root, "provider.pid"))).toBe(false);
      expect(existsSync(path.join(root, "protocol.ndjson"))).toBe(false);
    } finally {
      for (const backend of backends.toReversed()) await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
