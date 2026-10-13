import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { Schema } from "effect";
import {
  PERSISTENT_PROVIDER_HOST_ABI,
  PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES,
  PERSISTENT_PROVIDER_HOST_VERSION,
  PersistentHostDescriptor,
  PersistentHostEvent,
  PersistentHostResponse,
  PersistentHostSnapshot,
  type PersistentHostMethod,
  type PersistentHostRequest,
} from "@synara/contracts/persistentProviderHost";
import { JsonRpcStdioFramer, JsonRpcStdioWriter } from "@synara/shared/jsonrpc-stdio";
import {
  assertPersistentHostPlatform,
  spawnPersistentHost,
} from "../../platform/persistentHostProcess.ts";
import { privateDirectory, readPrivateFile, removePrivateFile } from "./storage.ts";

const decodeDescriptor = Schema.decodeUnknownSync(PersistentHostDescriptor);
const decodeResponse = Schema.decodeUnknownSync(PersistentHostResponse);
const decodeSnapshot = Schema.decodeUnknownSync(PersistentHostSnapshot);
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(PersistentHostEvent));

export function readHostDescriptor(directory: string): PersistentHostDescriptor {
  privateDirectory(directory);
  const descriptor = decodeDescriptor(
    JSON.parse(readPrivateFile(path.join(directory, "descriptor.json"), 4096)),
  );
  if (
    !Number.isSafeInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65535 ||
    !Number.isSafeInteger(descriptor.pid) ||
    descriptor.pid < 1 ||
    !/^[a-f0-9]{64}$/.test(descriptor.token)
  )
    throw new Error("Invalid persistent host identity");
  return descriptor;
}

/** Only a missing exclusive launch record permits spawning. Ambiguous/dead hosts fail closed. */
export async function launchOrConnectCodexHost(input: {
  readonly directory: string;
  readonly executable: string;
  /** Runtime arguments and the dedicated host entry point; directory is appended by this function. */
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<PersistentCodexHostClient> {
  assertPersistentHostPlatform();
  privateDirectory(input.directory);
  if (existsSync(path.join(input.directory, "descriptor.json")))
    return PersistentCodexHostClient.connect(input.directory);
  const launchPath = path.join(input.directory, "launch.json");
  let created = false;
  try {
    const fd = openSync(launchPath, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          version: PERSISTENT_PROVIDER_HOST_VERSION,
          abi: PERSISTENT_PROVIDER_HOST_ABI,
          instanceId: randomUUID(),
          token: randomBytes(32).toString("hex"),
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) {
    try {
      await spawnPersistentHost({
        executable: input.executable,
        args: [...input.args, input.directory],
        ...(input.env ? { env: input.env } : {}),
      });
    } catch (error) {
      removePrivateFile(launchPath);
      throw error;
    }
  }
  const deadline = Date.now() + Math.min(30_000, Math.max(100, input.timeoutMs ?? 10_000));
  while (Date.now() < deadline) {
    if (existsSync(path.join(input.directory, "descriptor.json")))
      return PersistentCodexHostClient.connect(input.directory);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Persistent host launch remains uncertain; retained the ownership fence and did not launch a competing provider",
  );
}

/** Explicit event ACKs belong after durable projection, never after TCP delivery. */
export class PersistentCodexHostClient {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly writer: JsonRpcStdioWriter;
  private readonly framer = new JsonRpcStdioFramer(PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES);
  private lease: string | undefined;
  private closed = false;
  readonly detached: Promise<void>;
  private constructor(
    private readonly socket: Socket,
    readonly descriptor: PersistentHostDescriptor,
  ) {
    this.writer = new JsonRpcStdioWriter(
      socket,
      PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES,
      8 * 1024 * 1024,
    );
    this.detached = new Promise((resolve) => socket.once("close", () => resolve()));
    const fail = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
      this.framer.close();
      this.writer.close(error);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of this.framer.push(chunk)) {
          const response = decodeResponse(JSON.parse(line));
          const request = this.pending.get(response.id);
          if (!request) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timeout);
          if (response.ok) request.resolve(response.value);
          else request.reject(new Error(response.error ?? "Persistent host rejected operation"));
        }
      } catch {
        fail(new Error("Invalid persistent host response"));
      }
    });
    socket.on("error", fail);
    socket.on("close", () =>
      fail(
        new Error(
          "Persistent host connection lost; command outcome may be uncertain. Reattach with the same operation ID",
        ),
      ),
    );
  }

  static async connect(directory: string): Promise<PersistentCodexHostClient> {
    assertPersistentHostPlatform();
    const descriptor = readHostDescriptor(directory);
    const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
    const client = new PersistentCodexHostClient(socket, descriptor);
    try {
      const result = await client.request(
        {
          action: "attach",
          version: descriptor.version,
          instanceId: descriptor.instanceId,
          token: descriptor.token,
        },
        5000,
      );
      const decoded = Schema.decodeUnknownSync(
        Schema.Struct({ lease: Schema.String, snapshot: PersistentHostSnapshot }),
      )(result);
      if (
        decoded.snapshot.hostPid !== descriptor.pid ||
        decoded.snapshot.instanceId !== descriptor.instanceId
      )
        throw new Error("Persistent host process identity mismatch");
      client.lease = decoded.lease;
      return client;
    } catch (error) {
      client.disconnect();
      throw error;
    }
  }

  private request(
    request: Omit<PersistentHostRequest, "id">,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Persistent host client is detached"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending host commands"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Persistent host request timed out; inspect its receipt before retrying with the same operation ID",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      void this.writer
        .write({ ...request, id, ...(this.lease ? { lease: this.lease } : {}) })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        });
    });
  }

  async snapshot(): Promise<PersistentHostSnapshot> {
    return decodeSnapshot(await this.request({ action: "snapshot" }));
  }
  call(
    method: PersistentHostMethod,
    args: readonly unknown[],
    operationId: string,
  ): Promise<unknown> {
    return this.request({ action: "call", method, args, operationId });
  }
  async events(after?: number): Promise<readonly PersistentHostEvent[]> {
    return decodeEvents(
      await this.request({ action: "events", ...(after === undefined ? {} : { sequence: after }) }),
    );
  }
  async acknowledge(sequence: number): Promise<void> {
    await this.request({ action: "ack", sequence });
  }
  async acknowledgeOperation(operationId: string): Promise<void> {
    await this.request({ action: "forget", operationId });
  }
  async detach(): Promise<void> {
    try {
      await this.request({ action: "detach" });
    } finally {
      this.disconnect();
      await this.detached;
    }
  }
  /** Abrupt controller loss, including an in-flight RPC, never stops the host. */
  disconnect(): void {
    this.socket.destroy();
  }
  async terminate(): Promise<void> {
    await this.request({ action: "terminate" });
    await this.detached;
  }
}

/** One bounded batch. The callback must commit idempotently by event.id before resolving. */
export async function projectPersistentHostEvents(
  client: PersistentCodexHostClient,
  persist: (entry: PersistentHostEvent) => Promise<void>,
): Promise<number> {
  const events = await client.events();
  for (const entry of events) await persist(entry);
  const last = events.at(-1);
  if (last) await client.acknowledge(last.sequence);
  return events.length;
}
