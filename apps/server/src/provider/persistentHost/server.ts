import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { Schema } from "effect";
import type { ProviderEvent } from "@synara/contracts";
import {
  PERSISTENT_PROVIDER_HOST_ABI,
  PERSISTENT_PROVIDER_HOST_VERSION,
  PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES,
  PersistentHostRequest,
  type PersistentHostDescriptor,
  type PersistentHostMethod,
  type PersistentHostSnapshot,
} from "@synara/contracts/persistentProviderHost";
import { JsonRpcStdioFramer, JsonRpcStdioWriter } from "@synara/shared/jsonrpc-stdio";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { assertPersistentHostPlatform } from "../../platform/persistentHostProcess.ts";
import { invokeCodexHost } from "./codexRuntime.ts";
import { PersistentHostJournal } from "./journal.ts";
import {
  privateDirectory,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from "./storage.ts";

interface Receipt {
  id: string;
  method: PersistentHostMethod;
  fingerprint: string;
  state: "pending" | "completed" | "failed" | "acknowledged";
  value?: unknown;
  error?: string;
}
const decodeRequest = Schema.decodeUnknownSync(PersistentHostRequest);
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : "Persistent host operation failed").slice(0, 4096);

export async function runPersistentCodexHost(
  directory: string,
  limits?: { readonly journalBytes?: number; readonly receiptCount?: number },
) {
  assertPersistentHostPlatform();
  privateDirectory(directory);
  const bootstrap = JSON.parse(readPrivateFile(path.join(directory, "launch.json"))) as {
    token?: unknown;
    instanceId?: unknown;
    version?: unknown;
    abi?: unknown;
  };
  if (
    bootstrap.version !== PERSISTENT_PROVIDER_HOST_VERSION ||
    bootstrap.abi !== PERSISTENT_PROVIDER_HOST_ABI ||
    typeof bootstrap.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(bootstrap.token) ||
    typeof bootstrap.instanceId !== "string"
  ) {
    throw new Error("Incompatible persistent host launch identity");
  }
  // A second entry process cannot publish over the first, even if invoked directly.
  const processLock = openSync(path.join(directory, "process.lock"), "wx", 0o600);
  try {
    writeFileSync(
      processLock,
      JSON.stringify({ pid: process.pid, instanceId: bootstrap.instanceId }),
    );
  } finally {
    closeSync(processLock);
  }
  const instanceId = bootstrap.instanceId;
  const secret = Buffer.from(bootstrap.token);
  const manager = new CodexAppServerManager();
  const journal = new PersistentHostJournal(directory, limits?.journalBytes);
  const receipts = new Map<string, Receipt>();
  const pending = new Map<string, Promise<unknown>>();
  const busy = new Set<string>();
  const startups = new Map<string, Promise<unknown>>();
  const stoppingThreads = new Set<string>();
  let stoppingAll = false;
  const sockets = new Set<Socket>();
  let owner: { socket: Socket; lease: string; delivered: number } | undefined;
  let failure: string | null = null;
  let terminating = false;
  let terminationComplete = false;
  let stopAfterFailure: Promise<void> | undefined;
  const persistReceipts = () => {
    const value = JSON.stringify([...receipts.values()]);
    if (Buffer.byteLength(value) > 16 * 1024 * 1024)
      throw new Error("Persistent host receipt storage is full");
    writePrivateFile(path.join(directory, "receipts.json"), value);
  };
  const stopOwnedSessions = async () => {
    // A start can still be awaiting executable/env preparation when stop arrives.
    // Stop visible children first to unblock RPCs, then join starts and stop again.
    await Promise.allSettled([manager.stopAll()]);
    await Promise.allSettled(startups.values());
    await manager.stopAll();
  };
  const fail = (cause: unknown) => {
    if (failure !== null) return;
    failure = errorText(cause);
    try {
      writePrivateFile(path.join(directory, "failure.json"), JSON.stringify({ failure }));
    } catch {
      /* Keep live failure observable even when storage itself failed. */
    }
    stopAfterFailure = stopOwnedSessions().catch((error: unknown) => {
      failure = `${failure}; cleanup unproven: ${errorText(error)}`;
    });
  };
  const writeReceipts = () => {
    try {
      persistReceipts();
    } catch (error) {
      fail(error);
      throw error;
    }
  };
  const onEvent = (event: ProviderEvent) => {
    if (failure !== null) return;
    try {
      journal.append(event);
    } catch (error) {
      fail(error);
    }
  };
  manager.on("event", onEvent);
  const snapshot = (): PersistentHostSnapshot => ({
    instanceId,
    hostPid: process.pid,
    acknowledgedSequence: journal.acknowledgedSequence,
    latestSequence: journal.latestSequence,
    failure,
    sessions: manager.inspectPersistentSessions(),
    operations: [...receipts.values()].map(({ id, method, state }) => ({ id, method, state })),
  });
  const invoke = (request: PersistentHostRequest): Promise<unknown> => {
    const { operationId: id, method, args } = request;
    if (!id || id.length > 200 || !method || !args)
      throw new Error("A bounded stable operation ID, method and arguments are required");
    const fingerprint = createHash("sha256").update(JSON.stringify({ method, args })).digest("hex");
    const previous = receipts.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Operation ID already belongs to different arguments");
      if (previous.state === "acknowledged")
        throw new Error("Operation was acknowledged; it will not execute again");
      if (previous.state === "failed") throw new Error(previous.error);
      return pending.get(id) ?? Promise.resolve(previous.value);
    }
    if (failure !== null) throw new Error(failure);
    if (stoppingAll) throw new Error("Persistent host is stopping its sessions");
    if (receipts.size >= (limits?.receiptCount ?? 8192))
      throw new Error(
        "Persistent host receipt limit reached; explicitly terminate the idle host before creating another",
      );
    if (pending.size >= 64) throw new Error("Persistent host is busy");
    const input = args[0] as { threadId?: unknown } | undefined;
    const threadKey = String(typeof args[0] === "string" ? args[0] : input?.threadId);
    if (stoppingThreads.has(threadKey)) throw new Error("Persistent host is stopping this session");
    const scope =
      method === "startSession" || method === "sendTurn" || method === "steerTurn"
        ? `turn:${String(input?.threadId)}`
        : method === "respondToUserInput" || method === "respondToRequest"
          ? `interaction:${String(args[0])}:${String(args[1])}`
          : undefined;
    if (scope && busy.has(scope))
      throw new Error("An operation for this turn or interaction is still pending");
    const receipt: Receipt = { id, method, fingerprint, state: "pending" };
    receipts.set(id, receipt);
    try {
      writeReceipts();
    } catch (error) {
      receipts.delete(id);
      fail(error);
      throw error;
    }
    if (scope) busy.add(scope);
    if (method === "stopAll") stoppingAll = true;
    if (method === "stopSession") stoppingThreads.add(threadKey);
    // Persist acceptance before dispatch. A backend can recover this very promise by ID.
    const result = Promise.resolve()
      .then(async () => {
        if (method === "stopAll") return stopOwnedSessions();
        if (method === "stopSession") {
          await startups.get(threadKey)?.catch(() => undefined);
          return invokeCodexHost(manager, method, args);
        }
        if (failure !== null || terminating || stoppingAll || stoppingThreads.has(threadKey)) {
          throw new Error(failure ?? "Persistent host stopped before command dispatch");
        }
        return invokeCodexHost(manager, method, args);
      })
      .then(
        (value) => {
          receipt.state = "completed";
          receipt.value = value ?? null;
          writeReceipts();
          return receipt.value;
        },
        (error: unknown) => {
          receipt.state = "failed";
          receipt.error = errorText(error);
          writeReceipts();
          throw new Error(receipt.error);
        },
      )
      .catch((error: unknown) => {
        if (receipt.state !== "failed") fail(error);
        throw error;
      })
      .finally(() => {
        pending.delete(id);
        if (scope) busy.delete(scope);
        if (method === "startSession") startups.delete(threadKey);
        if (method === "stopAll") stoppingAll = false;
        if (method === "stopSession") stoppingThreads.delete(threadKey);
      });
    pending.set(id, result);
    if (method === "startSession") startups.set(threadKey, result);
    return result;
  };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((socket) => {
    if (sockets.size >= 8) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const framer = new JsonRpcStdioFramer(PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES);
    const writer = new JsonRpcStdioWriter(
      socket,
      PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES,
      8 * 1024 * 1024,
    );
    const handshakeTimer = setTimeout(() => {
      if (owner?.socket !== socket) socket.destroy();
    }, 5000);
    let requests = 0;
    const handle = async (request: PersistentHostRequest) => {
      if (request.id.length > 200) throw new Error("Invalid request ID");
      if (request.action === "attach") {
        const supplied = Buffer.from(request.token ?? "");
        if (
          supplied.length !== secret.length ||
          !timingSafeEqual(supplied, secret) ||
          request.instanceId !== instanceId ||
          request.version !== PERSISTENT_PROVIDER_HOST_VERSION
        )
          throw new Error("Persistent host authentication or version mismatch");
        if (owner || terminating) throw new Error("Persistent host already has a live owner");
        owner = { socket, lease: randomUUID(), delivered: journal.acknowledgedSequence };
        clearTimeout(handshakeTimer);
        return { lease: owner.lease, snapshot: snapshot() };
      }
      if (owner?.socket !== socket || request.lease !== owner.lease)
        throw new Error("Stale persistent host owner");
      if (terminating) throw new Error("Persistent host is terminating");
      switch (request.action) {
        case "snapshot":
          return snapshot();
        case "call":
          return invoke(request);
        case "events": {
          const after = request.sequence ?? journal.acknowledgedSequence;
          // A writer may only advance across contiguous delivered events.
          if (after > owner.delivered) throw new Error("Cannot skip undelivered events");
          const events = journal.read(after);
          owner.delivered = Math.max(owner.delivered, events.at(-1)?.sequence ?? after);
          return events;
        }
        case "ack": {
          if (request.sequence === undefined || request.sequence > owner.delivered)
            throw new Error("Cannot acknowledge undelivered events");
          journal.acknowledge(request.sequence);
          return null;
        }
        case "forget": {
          const receipt = receipts.get(request.operationId ?? "");
          if (!receipt || receipt.state === "pending")
            throw new Error("Only settled operations can be acknowledged");
          receipt.state = "acknowledged";
          delete receipt.value;
          delete receipt.error;
          writeReceipts();
          return null;
        }
        case "detach":
          owner = undefined;
          return null;
        case "terminate": {
          terminating = true;
          try {
            await stopAfterFailure;
            await stopOwnedSessions();
            await Promise.allSettled(pending.values());
            writePrivateFile(
              path.join(directory, "terminated.json"),
              JSON.stringify({ instanceId, hostPid: process.pid, at: new Date().toISOString() }),
            );
            // Keep the launch fence until owned child teardown has been verified.
            removePrivateFile(path.join(directory, "descriptor.json"));
            removePrivateFile(path.join(directory, "process.lock"));
            removePrivateFile(path.join(directory, "launch.json"));
            terminationComplete = true;
            return null;
          } catch (error) {
            terminating = false;
            throw error;
          }
        }
      }
    };
    const dispatch = async (line: string) => {
      let request: PersistentHostRequest;
      try {
        request = decodeRequest(JSON.parse(line));
      } catch {
        socket.destroy();
        return;
      }
      if (++requests > 64) {
        socket.destroy();
        return;
      }
      try {
        const value = await handle(request);
        await writer.write({ id: request.id, ok: true, value });
        if (request.action === "detach") socket.end();
      } catch (error) {
        await writer
          .write({ id: request.id, ok: false, error: errorText(error) })
          .catch(() => socket.destroy());
        if (request.action === "attach") socket.end();
      } finally {
        // Cleanup belongs to the accepted terminate operation, even if its caller died.
        if (request.action === "terminate" && terminationComplete) {
          manager.off("event", onEvent);
          for (const connection of sockets) connection.destroy();
          server.close(() => resolveClosed());
        }
        requests--;
      }
    };
    socket.on("data", (data: Buffer) => {
      try {
        for (const line of framer.push(data)) void dispatch(line).catch(() => socket.destroy());
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (owner?.socket === socket) owner = undefined;
      sockets.delete(socket);
      framer.close();
      writer.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Persistent host did not bind loopback");
  const descriptor: PersistentHostDescriptor = {
    version: PERSISTENT_PROVIDER_HOST_VERSION,
    abi: PERSISTENT_PROVIDER_HOST_ABI,
    instanceId,
    token: bootstrap.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: address.port,
  };
  writePrivateFile(path.join(directory, "descriptor.json"), JSON.stringify(descriptor));
  return { closed };
}
