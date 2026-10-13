import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ThreadId } from "@synara/contracts";
import { spawnProcess } from "@synara/shared/processRuntime";
import {
  PERSISTENT_PROVIDER_HOST_VERSION,
  type PersistentHostEvent,
} from "@synara/contracts/persistentProviderHost";
import {
  launchOrConnectCodexHost,
  PersistentCodexHostClient,
  readHostDescriptor,
  projectPersistentHostEvents,
} from "./client.ts";
import { assertPersistentHostPlatform } from "../../platform/persistentHostProcess.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
const contexts: Array<{ directory: string; client?: PersistentCodexHostClient }> = [];
const supported = process.platform === "darwin" || process.platform === "linux";
async function waitUntil<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("Bounded fake-protocol wait timed out");
}
async function setup(small = false, environment: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "metis-provider-host-"));
  chmodSync(directory, 0o700);
  const context: { directory: string; client?: PersistentCodexHostClient } = { directory };
  contexts.push(context);
  const binary = path.join(directory, "fake codex.mjs");
  copyFileSync(path.join(fixtures, "fake-codex.mjs"), binary);
  chmodSync(binary, 0o700);
  const home = path.join(directory, "codex-home");
  mkdirSync(home);
  writeFileSync(path.join(home, "config.toml"), "");
  const launch = {
    directory: path.join(directory, "host"),
    executable: !small && process.env.METIS_HOST_TEST_BUILT_ENTRY ? process.execPath : "bun",
    args: [
      !small && process.env.METIS_HOST_TEST_BUILT_ENTRY
        ? process.env.METIS_HOST_TEST_BUILT_ENTRY
        : path.join(fixtures, "host.ts"),
    ],
    env: {
      ...process.env,
      ...environment,
      SYNARA_HOME: path.join(directory, "synara"),
      CODEX_HOME: home,
      METIS_FAKE_PROTOCOL_DIRECTORY: directory,
      ...(small ? { METIS_FAKE_SMALL_JOURNAL: "1" } : {}),
    },
  };
  context.client = await launchOrConnectCodexHost(launch);
  const start = {
    threadId: ThreadId.makeUnsafe("test-thread"),
    cwd: directory,
    runtimeMode: "approval-required",
    gatewayMode: "native-only",
    providerOptions: { codex: { binaryPath: binary, homePath: home } },
  };
  return { context, launch, start, client: context.client };
}
async function reconnect(context: { directory: string; client?: PersistentCodexHostClient }) {
  const directory = path.join(context.directory, "host");
  // TCP close notification can trail the old controller's local close event.
  const client = await waitUntil(
    async () => {
      try {
        return await PersistentCodexHostClient.connect(directory);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("live owner")) throw error;
        return undefined;
      }
    },
    (client) => client !== undefined,
  );
  if (!client) throw new Error("Host attachment did not complete");
  context.client = client;
  return client;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const protocol = (
  directory: string,
): Array<{ id?: string; method?: string; params?: unknown; result?: unknown }> =>
  readFileSync(path.join(directory, "protocol.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const approval = (events: readonly PersistentHostEvent[]) =>
  events.find(({ event }) => event.method === "item/commandExecution/requestApproval");

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    if (context.client) {
      context.client.disconnect();
      await context.client.detached;
    }
    if (existsSync(path.join(context.directory, "host/descriptor.json"))) {
      const client = await reconnect(context);
      await client.terminate();
    }
    rmSync(context.directory, { recursive: true, force: true });
  }
});

describe.skipIf(!supported)("independent persistent Codex host", () => {
  it("adopts the same PID, pending turn, events and human responders without replaying protocol input", async () => {
    const { client, context, start } = await setup();
    await client.call("startSession", [start], "start");
    const before = await client.snapshot();
    const turnArgs = [{ threadId: start.threadId, input: "one paid prompt" }];
    const uncertain = client
      .call("sendTurn", turnArgs, "turn-once")
      .catch((error: unknown) => error);
    await waitUntil(
      () => protocol(context.directory),
      (messages) => messages.some((item) => item.method === "turn/start"),
    );
    client.disconnect();
    await client.detached;
    expect(await uncertain).toBeInstanceOf(Error);
    let replacement = await reconnect(context);
    expect(await replacement.call("sendTurn", turnArgs, "turn-once")).toMatchObject({
      turnId: "native-turn-1",
    });
    const after = await replacement.snapshot();
    expect(after.hostPid).toBe(before.hostPid);
    expect(after.sessions[0]?.providerPid).toBe(before.sessions[0]?.providerPid);
    expect(after.sessions[0]?.sessionAttemptId).toBe(before.sessions[0]?.sessionAttemptId);
    expect(after.sessions[0]?.session.activeTurnId).toBe("native-turn-1");
    await expect(replacement.call("sendTurn", turnArgs, "duplicate-new-id")).rejects.toThrow(
      "existing turn",
    );
    const firstEvents = await waitUntil(
      () => replacement.events(),
      (events) => approval(events) !== undefined,
    );
    const requestId = approval(firstEvents)!.event.requestId!;
    expect((await replacement.snapshot()).sessions[0]?.awaitingHuman).toBe(true);
    // Merely receiving an event is not a commit. It reappears with exactly the same ID.
    await replacement.detach();
    replacement = await reconnect(context);
    expect(await replacement.events()).toEqual(firstEvents);
    const decision = [start.threadId, requestId, "accept"];
    await replacement.call("respondToRequest", decision, "approval-once");
    await replacement.detach();
    replacement = await reconnect(context);
    await replacement.call("respondToRequest", decision, "approval-once");
    await expect(
      replacement.call("respondToRequest", [start.threadId, requestId, "decline"], "approval-once"),
    ).rejects.toThrow("different arguments");
    const withInput = await waitUntil(
      () => replacement.events(),
      (events) => events.some(({ event }) => event.method === "item/tool/requestUserInput"),
    );
    const inputId = withInput.find(({ event }) => event.method === "item/tool/requestUserInput")!
      .event.requestId!;
    await replacement.detach();
    replacement = await reconnect(context);
    await replacement.call(
      "respondToUserInput",
      [start.threadId, inputId, { q: "yes" }],
      "input-once",
    );
    const completed = await waitUntil(
      () => replacement.events(),
      (events) => events.some(({ event }) => event.method === "turn/completed"),
    );
    expect(new Set(completed.map(({ event }) => event.id)).size).toBe(completed.length);
    const end = completed.at(-1)!.sequence;
    await replacement.acknowledge(end);
    await replacement.acknowledgeOperation("turn-once");
    await replacement.detach();
    replacement = await reconnect(context);
    expect(await replacement.events()).toEqual([]);
    await expect(replacement.call("sendTurn", turnArgs, "turn-once")).rejects.toThrow(
      "acknowledged",
    );
    const messages = protocol(context.directory);
    expect(messages.filter((item) => item.method === "initialize")).toHaveLength(1);
    expect(messages.filter((item) => item.method === "thread/start")).toHaveLength(1);
    expect(messages.filter((item) => item.method === "thread/resume")).toHaveLength(0);
    expect(messages.filter((item) => item.method === "turn/start")).toHaveLength(1);
    expect(messages.filter((item) => item.id === "approve" && item.result)).toHaveLength(1);
    expect(messages.filter((item) => item.id === "input" && item.result)).toHaveLength(1);
    await replacement.terminate();
    await waitUntil(
      () => alive(before.hostPid) || alive(before.sessions[0]!.providerPid),
      (running) => !running,
    );
    expect(existsSync(path.join(context.directory, "host/descriptor.json"))).toBe(false);
    expect(existsSync(path.join(context.directory, "host/launch.json"))).toBe(false);
  });

  it("survives an actual backend process exit while the provider's request is pending", async () => {
    const { client, context, start, launch } = await setup();
    const hostPid = (await client.snapshot()).hostPid;
    await client.detach();
    const inputFile = path.join(context.directory, "controller-input.json");
    writeFileSync(inputFile, JSON.stringify(start), { mode: 0o600 });
    const controller = spawnProcess(
      "bun",
      [path.join(fixtures, "controller.ts"), launch.directory, inputFile],
      { stdio: "pipe" },
    );
    let errors = "";
    controller.stderr.on("data", (data: Buffer) => {
      errors += data.toString();
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      controller.once("exit", resolve);
      controller.once("error", reject);
    });
    expect(exit, errors).toBe(0);
    const replacement = await reconnect(context);
    const state = await replacement.snapshot();
    expect(state.hostPid).toBe(hostPid);
    expect(alive(state.sessions[0]!.providerPid)).toBe(true);
    expect(
      await replacement.call(
        "sendTurn",
        [{ threadId: start.threadId, input: "controller process turn" }],
        "controller-turn",
      ),
    ).toMatchObject({ turnId: "native-turn-1" });
    await waitUntil(
      () => replacement.events(),
      (events) => approval(events) !== undefined,
    );
    expect(
      protocol(context.directory).filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
    // Terminate while the provider is parked on a human decision, not just after completion.
    await replacement.terminate();
    await waitUntil(
      () => alive(hostPid) || alive(state.sessions[0]!.providerPid),
      (running) => !running,
    );
  });

  it("does not acknowledge past failed persistence and replays stable event IDs for an idempotent consumer", async () => {
    const { client, context, start } = await setup();
    await client.call("startSession", [start], "start");
    const original = await client.events();
    const committed = new Set<string>();
    await expect(
      projectPersistentHostEvents(client, async (entry) => {
        committed.add(entry.event.id);
        throw new Error("isolated commit/ACK interruption");
      }),
    ).rejects.toThrow("interruption");
    expect((await client.snapshot()).acknowledgedSequence).toBe(0);
    await client.detach();
    const replacement = await reconnect(context);
    expect(await replacement.events()).toEqual(original);
    await projectPersistentHostEvents(replacement, async (entry) => {
      committed.add(entry.event.id);
    });
    expect(committed.size).toBe(original.length);
    expect(await replacement.events()).toEqual([]);
  });

  it("retains the launch fence when ownership is ambiguous instead of spawning a second process", async () => {
    const { client, context, launch } = await setup();
    await client.terminate();
    // Simulate a launch whose publisher died before publishing its descriptor.
    writeFileSync(path.join(launch.directory, "launch.json"), "{}", { mode: 0o600 });
    await expect(
      launchOrConnectCodexHost({ ...launch, executable: "/never-execute", timeoutMs: 100 }),
    ).rejects.toThrow("uncertain");
    expect(readFileSync(path.join(launch.directory, "launch.json"), "utf8")).toBe("{}");
    expect(existsSync(path.join(context.directory, "provider.pid"))).toBe(false);
  });

  it("terminates starts in flight even when the terminating controller loses its connection", async () => {
    const { client, start, context, launch } = await setup(false, {
      METIS_FAKE_VERSION_DELAY: "350",
    });
    const hostPid = (await client.snapshot()).hostPid;
    const startup = client
      .call("startSession", [start], "slow-start")
      .catch((error: unknown) => error);
    await waitUntil(
      () => client.snapshot(),
      (snapshot) =>
        snapshot.operations.some((op) => op.id === "slow-start" && op.state === "pending"),
    );
    const terminated = client.terminate().catch((error: unknown) => error);
    await expect(client.snapshot()).rejects.toThrow("terminating");
    client.disconnect();
    await client.detached;
    expect(await startup).toBeInstanceOf(Error);
    await terminated;
    await waitUntil(
      () => alive(hostPid),
      (running) => !running,
    );
    expect(existsSync(path.join(launch.directory, "terminated.json"))).toBe(true);
    if (existsSync(path.join(context.directory, "provider.pid"))) {
      expect(
        alive(Number(readFileSync(path.join(context.directory, "provider.pid"), "utf8"))),
      ).toBe(false);
    }
  });

  it("uses exclusive authenticated ownership and rejects stale leases and incompatible identities", async () => {
    const { client, context, launch } = await setup();
    await expect(launchOrConnectCodexHost(launch)).rejects.toThrow("live owner");
    const descriptor = readHostDescriptor(launch.directory);
    expect(lstatSync(launch.directory).mode & 0o777).toBe(0o700);
    for (const file of ["launch.json", "descriptor.json", "events.ndjson", "process.lock"])
      expect(lstatSync(path.join(launch.directory, file)).mode & 0o777).toBe(0o600);
    const raw = async (message: Record<string, unknown>) => {
      const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
      return await new Promise<string>((resolve, reject) => {
        socket.once("connect", () =>
          socket.write(`${JSON.stringify({ id: randomUUID(), ...message })}\n`),
        );
        socket.once("data", (data) => {
          socket.destroy();
          resolve(data.toString());
        });
        socket.once("error", reject);
      });
    };
    expect(await raw({ action: "snapshot", lease: "stale" })).toContain(
      "Stale persistent host owner",
    );
    expect(
      await raw({
        action: "attach",
        token: "0".repeat(64),
        version: PERSISTENT_PROVIDER_HOST_VERSION,
        instanceId: descriptor.instanceId,
      }),
    ).toContain("authentication");
    expect(
      await raw({
        action: "attach",
        token: descriptor.token,
        version: 999,
        instanceId: descriptor.instanceId,
      }),
    ).toContain("version mismatch");
    await expect(client.acknowledge(1)).rejects.toThrow("undelivered");
    await client.detach();
    const adopted = await launchOrConnectCodexHost({
      ...launch,
      executable: "/will/not/be/launched",
    });
    context.client = adopted;
    expect((await adopted.snapshot()).hostPid).toBe(descriptor.pid);
  });

  it("fences an old lease even when the stale controller knows the host token", async () => {
    const { client, launch, context } = await setup();
    const descriptor = readHostDescriptor(launch.directory);
    await client.detach();
    const attachRaw = async () => {
      const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
      const exchange = (message: Record<string, unknown>) =>
        new Promise<{ ok: boolean; error?: string; value?: { lease: string } }>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              socket.destroy();
              reject(new Error("Raw host request timeout"));
            }, 2000);
            socket.once("data", (data) => {
              clearTimeout(timeout);
              resolve(JSON.parse(data.toString()));
            });
            socket.write(`${JSON.stringify({ id: randomUUID(), ...message })}\n`);
          },
        );
      const attached = await exchange({
        action: "attach",
        token: descriptor.token,
        instanceId: descriptor.instanceId,
        version: descriptor.version,
      });
      expect(attached.ok).toBe(true);
      return { socket, exchange, lease: attached.value!.lease };
    };
    const first = await attachRaw();
    await first.exchange({ action: "detach", lease: first.lease });
    first.socket.destroy();
    const second = await attachRaw();
    expect(second.lease).not.toBe(first.lease);
    expect(await second.exchange({ action: "snapshot", lease: first.lease })).toMatchObject({
      ok: false,
      error: "Stale persistent host owner",
    });
    expect(await second.exchange({ action: "snapshot", lease: second.lease })).toMatchObject({
      ok: true,
    });
    await second.exchange({ action: "detach", lease: second.lease });
    second.socket.destroy();
    await reconnect(context);
  });

  it("bounds operation receipts without forgetting idempotency tombstones", async () => {
    const { client } = await setup(true);
    for (let index = 0; index < 12; index++) {
      await client.call("stopAll", [], `receipt-${index}`);
      await client.acknowledgeOperation(`receipt-${index}`);
    }
    expect((await client.snapshot()).operations).toHaveLength(12);
    await expect(client.call("stopAll", [], "receipt-0")).rejects.toThrow("acknowledged");
    await expect(client.call("stopAll", [], "receipt-13")).rejects.toThrow("receipt limit");
  });

  it("refuses accidental gateway removal and cannot silently replace an existing session", async () => {
    const { client, start } = await setup();
    const { gatewayMode: _gatewayMode, ...missingOptIn } = start;
    await expect(client.call("startSession", [missingOptIn], "no-opt-in")).rejects.toThrow();
    await expect(
      client.call("startSession", [{ ...start, enableComputerControl: true }], "computer"),
    ).rejects.toThrow();
    await client.call("startSession", [start], "start");
    await expect(client.call("startSession", [start], "replacement")).rejects.toThrow(
      "already exists",
    );
  });

  it("routes bounded stalled-turn cleanup to the existing manager without replaying work", async () => {
    const { client, start, context } = await setup();
    await client.call("startSession", [start], "start");
    await client.call("sendTurn", [{ threadId: start.threadId, input: "idle" }], "idle-turn");
    await waitUntil(
      () => client.events(),
      (events) => events.some(({ event }) => event.method === "item/agentMessage/delta"),
    );
    await expect(
      client.call(
        "abandonTurn",
        [start.threadId, "native-turn-1", "x".repeat(4097)],
        "bad-abandon",
      ),
    ).rejects.toThrow("4096");
    const args = [start.threadId, "native-turn-1", "Fake watchdog idle timeout"];
    await client.call("abandonTurn", args, "watchdog-once");
    await client.call("abandonTurn", args, "watchdog-once");
    const state = await client.snapshot();
    expect(state.sessions[0]?.session.activeTurnId).toBeUndefined();
    expect(state.sessions[0]?.routable).toBe(true);
    expect(
      protocol(context.directory).filter((message) => message.method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(
      protocol(context.directory).filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
  });

  it("fails closed when a receipt cannot be persisted, before dispatching a new prompt", async () => {
    const { client, start, launch, context } = await setup();
    await client.call("startSession", [start], "start");
    const pid = (await client.snapshot()).sessions[0]!.providerPid;
    const sentinel = path.join(context.directory, "protected-sentinel");
    writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    symlinkSync(sentinel, path.join(launch.directory, "receipts.json.next"));
    await expect(
      client.call(
        "sendTurn",
        [{ threadId: start.threadId, input: "must not dispatch" }],
        "blocked-receipt",
      ),
    ).rejects.toThrow();
    expect((await client.snapshot()).failure).not.toBeNull();
    await waitUntil(
      () => alive(pid),
      (running) => !running,
    );
    expect(protocol(context.directory).some((message) => message.method === "turn/start")).toBe(
      false,
    );
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
  });

  it("fails visibly and stops the provider when its durable event budget is exhausted", async () => {
    const { client, context, start } = await setup(true);
    await client.call("startSession", [start], "start");
    const pid = (await client.snapshot()).sessions[0]!.providerPid;
    await client
      .call("sendTurn", [{ threadId: start.threadId, input: "overflow" }], "overflow")
      .catch(() => undefined);
    const state = await waitUntil(
      () => client.snapshot(),
      (snapshot) => snapshot.failure !== null,
    );
    expect(state.failure).toContain("journal is full");
    await waitUntil(
      () => alive(pid),
      (running) => !running,
    );
    expect(lstatSync(path.join(context.directory, "host/events.ndjson")).size).toBeLessThanOrEqual(
      64 * 1024,
    );
    await expect(
      client.call("sendTurn", [{ threadId: start.threadId, input: "retry" }], "new-id"),
    ).rejects.toThrow("journal is full");
  });
});

it("declares unsupported persistent-host platforms explicitly", () => {
  expect(() => assertPersistentHostPlatform("win32")).toThrow("macOS or Linux");
});
