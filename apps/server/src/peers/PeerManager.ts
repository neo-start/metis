import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import { Bonjour } from "bonjour-service";
import { generate } from "selfsigned";
import { Effect, Schema } from "effect";
import {
  isPeerChatRequest,
  PeerId,
  PeerMessage,
  PeerTask,
  PeerRemoteRequest,
  PeerRemoteReply,
  PeerProjectUpdate,
  type PeerControlInput,
  type PeerControlResult,
  type PeerOverview,
  type PeerTaskResponse,
} from "@synara/contracts";
import type { PeerChatExecution } from "./PeerChatExecution.ts";
import {
  PublishedProjectUpdate,
  projectUpdateMessage,
  readPublishedProjectUpdate,
} from "./projectUpdates.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  discoverCertificate,
  instanceId,
  isLanAddress,
  parsePeerAddress,
  peerAddress,
  peerRequest,
  readPeerJson,
  type PeerIdentity,
} from "./peerTransport.ts";

const TrustedPeer = Schema.Struct({
  id: PeerId,
  name: Schema.String,
  address: Schema.String,
  cert: Schema.String,
});
type TrustedPeer = typeof TrustedPeer.Type;
const Outbox = Schema.Struct({ peerId: PeerId, request: PeerRemoteRequest });
const ProjectUpdateRule = Schema.Struct({
  ...PeerProjectUpdate.fields,
  generation: Schema.String,
  pending: Schema.NullOr(PublishedProjectUpdate),
});
type ProjectUpdateRule = typeof ProjectUpdateRule.Type;
const State = Schema.Struct({
  projectUpdates: Schema.optional(Schema.Array(ProjectUpdateRule)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  chatRequests: Schema.optional(Schema.Record(Schema.String, Schema.String)).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  name: Schema.String,
  port: Schema.optional(Schema.Number),
  templateThreadId: Schema.NullOr(Schema.String),
  peers: Schema.Array(TrustedPeer),
  tasks: Schema.Array(PeerTask),
  messages: Schema.Array(PeerMessage),
  outbox: Schema.Array(Outbox),
  notified: Schema.Array(Schema.String),
});
type State = typeof State.Type;
const PairRequest = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  port: Schema.Number,
});
const PairReply = Schema.Struct({ approved: Schema.Boolean, name: Schema.String });
type Pending = TrustedPeer & {
  requestId: string;
  code: string;
  incoming: boolean;
  expiresAt: number;
};
const terminal = (task: PeerTask) => ["completed", "error", "interrupted"].includes(task.state);
const taskKey = (task: PeerTask) => `${task.direction}:${task.peerId}:${task.id}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PeerExecution {
  templates(): Promise<Array<{ id: string; title: string }>>;
  project(template: string | null): Promise<string | null>;
  submit(task: PeerTask, template: string): Promise<string>;
  status(
    threadId: string,
  ): Promise<
    Pick<PeerTask, "state" | "result" | "attention" | "updatedAt" | "localRecovery" | "observedAt">
  >;
  respond?(threadId: string, request: PeerTaskResponse): Promise<void>;
  cancel(threadId: string, requestId: string): Promise<void>;
  notify(task: PeerTask): Promise<void>;
  deliver(threadId: string, message: PeerMessage): Promise<void>;
}

/** One independent backend owns this state. No shared databases or owner tokens
 * cross the LAN. Only this narrow mTLS listener is exposed when enabled. */
export class PeerManager {
  private state: State = {
    projectUpdates: [],
    chatRequests: {},
    version: 1,
    enabled: false,
    name: hostname(),
    templateThreadId: null,
    peers: [],
    tasks: [],
    messages: [],
    outbox: [],
    notified: [],
  };
  private identity!: PeerIdentity;
  private id = "";
  private server: https.Server | undefined;
  private bonjour: Bonjour | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private port: number | null = null;
  private error: string | null = null;
  private readonly nearby = new Map<string, { id: string; name: string; address: string }>();
  private readonly chatSupport = new Map<string, boolean>();
  private readonly health = new Map<
    string,
    {
      online: boolean;
      error: string | null;
      lastSeenAt?: string;
      capabilities?: readonly string[];
    }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly taskSync = new Map<string, string>();
  private readonly taskObservations = new Map<
    string,
    {
      observedAt?: string;
      localObservedAt: number | null;
      stale: boolean;
    }
  >();
  private writes: Promise<void> = Promise.resolve();
  private lastSaved: string | undefined;
  private incoming: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private tickFinished: Promise<void> = Promise.resolve();
  private closing = false;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private projectUpdateCheckedAt = 0;

  constructor(
    private readonly root: string,
    private readonly execution: PeerExecution,
    private readonly options: {
      discovery?: boolean;
      host?: string;
      autoTick?: boolean;
      chats?: PeerChatExecution;
      publishedProjectUpdate?: typeof readPublishedProjectUpdate;
      projectRepositoryPath?: string;
    } = {},
  ) {}

  async initialize(): Promise<void> {
    try {
      const identity = Schema.decodeUnknownSync(
        Schema.Struct({ cert: Schema.String, private: Schema.String }),
      )(JSON.parse(await readFile(path.join(this.root, "identity.json"), "utf8")));
      this.identity = { ...identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = await generate([{ name: "commonName", value: "Metis peer" }], {
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true },
          { name: "keyUsage", digitalSignature: true, keyEncipherment: true, keyCertSign: true },
          { name: "extKeyUsage", serverAuth: true, clientAuth: true },
        ],
        notAfterDate: new Date(Date.now() + 10 * 365 * 86400000),
      });
      this.identity = { cert: generated.cert, private: generated.private };
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: path.join(this.root, "identity.json"),
          contents: JSON.stringify(this.identity),
        }),
      );
    }
    this.id = instanceId(this.identity.cert);
    try {
      this.state = Schema.decodeUnknownSync(State)(
        JSON.parse(await readFile(path.join(this.root, "state.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save(): Promise<void> {
    const contents = JSON.stringify(this.state);
    const write = this.writes.then(async () => {
      if (contents === this.lastSaved) return;
      await Effect.runPromise(
        writeFileStringAtomically({ filePath: path.join(this.root, "state.json"), contents }),
      );
      this.lastSaved = contents;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async start(): Promise<void> {
    if (!this.state.enabled || this.server) return;
    // Bun's IncomingMessage.socket does not expose the client certificate.
    // Refuse to listen rather than weaken mutual authentication. The desktop
    // and metis:serve launchers already run the built backend under Node.
    if (process.versions.bun)
      throw new Error("局域网协作需要 Node.js 后端，请使用 npm run metis 或 npm run metis:serve。");
    this.closing = false;
    const server = https.createServer(
      {
        cert: this.identity.cert,
        key: this.identity.private,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        maxHeaderSize: 8192,
      },
      (req, res) => {
        const handle = async () => {
          if (
            !this.state.enabled ||
            req.method !== "POST" ||
            !["/pair", "/pair-status", "/rpc"].includes(req.url ?? "")
          )
            throw new Error("设备协作未开启或请求无效。");
          const socket = req.socket as TLSSocket;
          const raw = socket.getPeerCertificate().raw;
          if (!raw || !isLanAddress(socket.remoteAddress ?? ""))
            throw new Error("需要局域网设备证书。");
          const cert = new X509Certificate(raw).toString();
          const remoteId = instanceId(cert);
          if (remoteId === this.id) throw new Error("不能连接同一个实例。");
          const body = await readPeerJson(req);
          if (req.url === "/pair") {
            const pair = Schema.decodeUnknownSync(PairRequest)(body);
            this.expirePending();
            if (!this.pending.has(pair.requestId) && this.pending.size >= 20)
              throw new Error("配对请求过多，请稍后重试。");
            const previous = this.pending.get(pair.requestId);
            if (previous && previous.id !== remoteId) throw new Error("配对请求身份不匹配。");
            if (!previous)
              this.pending.set(pair.requestId, {
                id: remoteId,
                name: pair.name,
                address: peerAddress(socket.remoteAddress!, pair.port),
                cert,
                requestId: pair.requestId,
                incoming: true,
                code: this.pairCode(remoteId, pair.requestId),
                expiresAt: Date.now() + 300000,
              });
            return { approved: false, name: this.state.name };
          }
          if (req.url === "/pair-status") {
            const { requestId } = Schema.decodeUnknownSync(
              Schema.Struct({ requestId: Schema.String }),
            )(body);
            this.expirePending();
            const pending = this.pending.get(requestId);
            if (!pending || pending.id !== remoteId || !pending.incoming)
              throw new Error("配对已过期或被拒绝。");
            return {
              approved: this.state.peers.some((peer) => peer.id === remoteId && peer.cert === cert),
              name: this.state.name,
            };
          }
          const trusted = this.state.peers.find(
            (peer) => peer.id === remoteId && peer.cert === cert,
          );
          if (!trusted) throw new Error("设备未配对或授权已撤销。");
          const request = Schema.decodeUnknownSync(PeerRemoteRequest)(body);
          const run = this.incoming.then(() => this.receive(trusted.id, request));
          this.incoming = run.catch(() => {});
          return run;
        };
        void handle().then(
          (result) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          },
          (error) => {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: errorText(error) }));
          },
        );
      },
    );
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.timeout = 15000;
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.state.port ?? 0, this.options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.port = address && typeof address !== "string" ? address.port : null;
    this.state = { ...this.state, port: this.port! };
    await this.save();
    server.on("error", (error) => {
      this.error = errorText(error);
    });
    if (this.options.discovery !== false) {
      try {
        this.bonjour = new Bonjour({}, (error: unknown) => {
          this.error = `局域网发现不可用，可手动输入地址：${errorText(error)}`;
        });
        const published = this.bonjour.publish({
          name: this.id,
          type: "metis-peer",
          port: this.port!,
          txt: { id: this.id, name: this.state.name, v: "1" },
        });
        published.on("error", (error: unknown) => {
          this.error = errorText(error);
        });
        const browser = this.bonjour.find({ type: "metis-peer" });
        browser.on("up", (service) => {
          const id = String(service.txt?.id ?? "");
          if (!/^metis-[a-f0-9]{32}$/.test(id) || id === this.id || service.txt?.v !== "1") return;
          const host = service.addresses?.find(
            (candidate) => isLanAddress(candidate) && !candidate.includes(":"),
          );
          if (!host || this.nearby.size >= 256) return;
          this.nearby.set(id, {
            id,
            name: String(service.txt?.name ?? id).slice(0, 100),
            address: peerAddress(host, service.port),
          });
        });
        browser.on("down", (service) => this.nearby.delete(String(service.txt?.id ?? "")));
      } catch (error) {
        this.error = `局域网发现不可用：${errorText(error)}`;
      }
    }
    if (this.options.autoTick !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch((error) => {
          this.error = errorText(error);
        });
      }, 2000);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.bonjour?.destroy();
    this.bonjour = undefined;
    const server = this.server;
    this.server = undefined;
    this.port = null;
    this.nearby.clear();
    this.pending.clear();
    this.health.clear();
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    await this.tickFinished;
    await this.incoming;
    await this.writes;
  }

  private expirePending() {
    for (const [key, value] of this.pending)
      if (value.expiresAt <= Date.now()) this.pending.delete(key);
  }
  private pairCode(peerId: string, requestId: string): string {
    return createHash("sha256")
      .update([...[this.id, peerId].toSorted(), requestId].join(":"))
      .digest("hex")
      .slice(0, 12)
      .toUpperCase()
      .match(/.{4}/g)!
      .join("-");
  }
  private requireEnabled() {
    if (!this.state.enabled || !this.port) throw new Error("请先开启局域网协作。");
  }
  private trusted(id: string) {
    const peer = this.state.peers.find((entry) => entry.id === id);
    if (!peer) throw new Error("设备未配对。");
    return peer;
  }
  private address(peer: TrustedPeer) {
    return this.nearby.get(peer.id)?.address ?? peer.address;
  }

  async overview(): Promise<PeerOverview> {
    this.expirePending();
    return {
      instanceId: this.id,
      name: this.state.name,
      enabled: this.state.enabled,
      listeningPort: this.port,
      addresses:
        this.port === null
          ? []
          : Object.values(networkInterfaces()).flatMap((list) =>
              (list ?? [])
                .filter(
                  (entry) =>
                    entry.family === "IPv4" && !entry.internal && isLanAddress(entry.address),
                )
                .map((entry) => peerAddress(entry.address, this.port!)),
            ),
      error: this.error,
      templateThreadId: this.state.templateThreadId,
      templates: await this.execution.templates(),
      nearby: [...this.nearby.values()],
      peers: this.state.peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        address: this.address(peer),
        ...(this.health.get(peer.id) ?? { online: false, error: null }),
      })),
      pending: [...this.pending.values()]
        .filter(
          (entry) => !entry.incoming || !this.state.peers.some((peer) => peer.id === entry.id),
        )
        .map((entry) => ({
          id: entry.requestId,
          peerId: entry.id,
          name: entry.name,
          code: entry.code,
          incoming: entry.incoming,
          expiresAt: entry.expiresAt,
        })),
      tasks: this.state.tasks.slice(-100).map((task) => this.taskSnapshot(task)),
      messages: this.state.messages.slice(-100),
      projectUpdates: (this.state.projectUpdates ?? []).map(
        ({ pending: _pending, generation: _generation, ...view }) => view,
      ),
      ...(this.options.projectRepositoryPath
        ? { projectUpdateRepositoryPath: this.options.projectRepositoryPath }
        : {}),
    };
  }

  /** Observation age is measured on the executor and anchored to receipt on this
   * machine. Never subtract clocks on different machines or renew it on HTTP 200. */
  private taskSnapshot(task: PeerTask): PeerTask {
    const observation = this.taskObservations.get(taskKey(task));
    // Queued work has not entered the engine: this manager is its authoritative
    // observer, so reading its queue is a current observation (unlike running work).
    const queuedHere = task.direction === "incoming" && task.state === "queued";
    const observedAt = queuedHere
      ? new Date(Date.now()).toISOString()
      : (observation?.observedAt ?? task.observedAt);
    const localObservedAt = queuedHere
      ? Date.now()
      : observation
        ? observation.localObservedAt
        : task.direction === "incoming"
          ? Date.parse(observedAt ?? "")
          : null;
    const age = localObservedAt === null ? NaN : Date.now() - localObservedAt;
    const observationAgeMs = Number.isFinite(age) && age >= 0 ? age : null;
    const syncedAt = this.taskSync.get(taskKey(task)) ?? task.syncedAt;
    return {
      ...task,
      ...(observedAt ? { observedAt } : {}),
      ...(syncedAt ? { syncedAt } : {}),
      observationAgeMs,
      stale:
        observation?.stale === true ||
        observationAgeMs === null ||
        observationAgeMs > 15000 ||
        (task.direction === "outgoing" &&
          (!this.state.enabled || !this.health.get(task.peerId)?.online)),
    };
  }

  async control(input: PeerControlInput): Promise<PeerControlResult> {
    let reply: PeerRemoteReply | null = null;
    if (input.action === "configure") {
      const configure = this.lifecycle.then(async () => {
        if (
          input.enabled &&
          input.templateThreadId &&
          !(await this.execution.templates()).some((entry) => entry.id === input.templateThreadId)
        )
          throw new Error("请选择有效的本机会话配置。");
        this.state = {
          ...this.state,
          enabled: input.enabled,
          name: input.name.trim().slice(0, 100),
          templateThreadId: input.templateThreadId,
        };
        await this.save();
        await this.stop();
        this.error = null;
        await this.start();
      });
      this.lifecycle = configure.catch(() => {});
      await configure;
    } else if (input.action === "project-updates.configure") {
      this.trusted(input.peerId);
      const repositoryPath = path.resolve(input.repositoryPath.trim());
      if (input.enabled) {
        this.requireEnabled();
        await (this.options.publishedProjectUpdate ?? readPublishedProjectUpdate)(
          repositoryPath,
          input.peerId,
        );
      }
      const previous = this.state.projectUpdates?.find((rule) => rule.peerId === input.peerId);
      const pendingId = previous?.pending?.eventId;
      const preserve = previous?.repositoryPath === repositoryPath;
      this.state = {
        ...this.state,
        projectUpdates: [
          ...(this.state.projectUpdates ?? []).filter((rule) => rule.peerId !== input.peerId),
          {
            peerId: input.peerId,
            repositoryPath,
            enabled: input.enabled,
            status: "watching",
            lastCommit: preserve ? previous.lastCommit : null,
            chatId: preserve ? previous.chatId : null,
            result: preserve ? previous.result : "",
            error: null,
            updatedAt: new Date().toISOString(),
            generation: randomUUID(),
            pending: null,
          },
        ],
        outbox: this.state.outbox.filter(
          (entry) =>
            !(
              entry.peerId === input.peerId &&
              "id" in entry.request &&
              (entry.request.id === pendingId || entry.request.id === `${pendingId}:send`)
            ),
        ),
      };
      this.projectUpdateCheckedAt = 0;
      await this.save();
    } else if (input.action === "pair") {
      this.requireEnabled();
      if (input.peerId === this.id) throw new Error("不能与自己配对。");
      if (this.state.peers.some((peer) => peer.id === input.peerId))
        throw new Error("设备已经配对；需要更新地址时请解除配对后重新添加。");
      const address = input.address?.trim() || this.nearby.get(input.peerId)?.address;
      if (!address)
        throw new Error(
          "暂未在局域网找到这个实例；请确认两端已开启协作，或输入对方显示的 IP:端口。",
        );
      const normalized = parsePeerAddress(address).origin;
      const cert = await discoverCertificate(normalized, input.peerId, this.identity);
      const requestId = randomUUID();
      const result = Schema.decodeUnknownSync(PairReply)(
        await peerRequest(normalized, cert, this.identity, "/pair", {
          requestId,
          name: this.state.name,
          port: this.port,
        }),
      );
      this.pending.set(requestId, {
        id: input.peerId,
        name: result.name,
        address: normalized,
        cert,
        requestId,
        incoming: false,
        code: this.pairCode(input.peerId, requestId),
        expiresAt: Date.now() + 300000,
      });
    } else if (input.action === "approve" || input.action === "reject") {
      this.requireEnabled();
      this.expirePending();
      const pending = this.pending.get(input.requestId);
      if (!pending || !pending.incoming) throw new Error("配对请求已失效。");
      if (input.action === "reject") this.pending.delete(input.requestId);
      else {
        this.state = {
          ...this.state,
          peers: [
            ...this.state.peers.filter((peer) => peer.id !== pending.id),
            { id: pending.id, name: pending.name, cert: pending.cert, address: pending.address },
          ],
        };
        await this.save();
      }
    } else if (input.action === "revoke") {
      const revoke = this.incoming.then(async () => {
        await this.options.chats?.revoke(input.peerId);
        this.state = {
          ...this.state,
          peers: this.state.peers.filter((peer) => peer.id !== input.peerId),
          projectUpdates: (this.state.projectUpdates ?? []).filter(
            (rule) => rule.peerId !== input.peerId,
          ),
          outbox: this.state.outbox.filter((item) => item.peerId !== input.peerId),
          tasks: this.state.tasks.map((task) =>
            task.peerId === input.peerId && task.state === "queued"
              ? { ...task, state: "interrupted", result: "配对已解除，尚未开始的任务已停止。" }
              : task,
          ),
        };
        for (const [key, value] of this.pending)
          if (value.id === input.peerId) this.pending.delete(key);
        this.health.delete(input.peerId);
        this.chatSupport.delete(input.peerId);
        await this.save();
      });
      this.incoming = revoke.catch(() => {});
      await revoke;
    } else if (input.action === "remote") reply = await this.remote(input.peerId, input.request);
    return { overview: await this.overview(), reply };
  }

  async remote(
    peerId: string,
    request: PeerRemoteRequest,
    sourceThreadId: string | null = null,
  ): Promise<PeerRemoteReply> {
    this.requireEnabled();
    this.trusted(peerId);
    if (isPeerChatRequest(request) && this.chatSupport.get(peerId) === false)
      throw new Error("另一台电脑需要更新 Metis 才能使用主控对话。");
    if (request.action === "respond") {
      // Only the owner control surface can answer; agent tools cannot grant approvals.
      if (sourceThreadId !== null) throw new Error("远程审批和回答只能由所有者操作。");
      const task = this.state.tasks.find(
        (entry) =>
          entry.direction === "outgoing" && entry.peerId === peerId && entry.id === request.taskId,
      );
      if (!task) throw new Error("任务不存在或不属于此设备。");
      // Negotiate afresh before sending a new action to a version-1 peer.
      const status = await this.remote(peerId, { action: "status", taskId: request.taskId });
      if (!status.capabilities?.includes("task-responses-v1"))
        throw new Error("对方版本不支持远程审批或回答，请在执行设备处理。");
      const current = this.state.tasks.find((entry) => taskKey(entry) === taskKey(task));
      if (!current || this.taskSnapshot(current).stale)
        throw new Error("执行状态已过期或观测时间未知，请等待执行设备刷新后再处理。");
    }
    // An inbound worker can communicate, but cannot recursively delegate work.
    if (
      request.action === "task" &&
      sourceThreadId &&
      this.state.tasks.some(
        (task) => task.direction === "incoming" && task.threadId === sourceThreadId,
      )
    )
      throw new Error("远程委派任务不能再次转派；请向发起方返回结果。");
    if (request.action === "message" || request.action === "task") {
      const conflictingKind =
        request.action === "task"
          ? this.state.messages.some(
              (entry) => entry.id === request.id && entry.direction === "outgoing",
            )
          : this.state.tasks.some(
              (entry) => entry.id === request.id && entry.direction === "outgoing",
            );
      if (conflictingKind) throw new Error("请求 ID 已用于另一种操作。");
      const exists =
        request.action === "task"
          ? this.state.tasks.find((task) => task.id === request.id && task.direction === "outgoing")
          : this.state.messages.find(
              (message) => message.id === request.id && message.direction === "outgoing",
            );
      if (
        exists &&
        (exists.peerId !== peerId ||
          exists.text !== request.text ||
          (request.action === "message" &&
            ("taskId" in exists ? exists.taskId : undefined) !== request.taskId))
      )
        throw new Error("请求 ID 已用于其他内容。");
      if (!exists) {
        if (this.state.outbox.length >= 500) throw new Error("待发送请求过多，请等待设备上线。");
        if (request.action === "task")
          this.state = {
            ...this.state,
            tasks: [
              ...this.state.tasks,
              {
                id: request.id,
                peerId,
                direction: "outgoing",
                text: request.text,
                sourceThreadId,
                threadId: null,
                state: "queued",
                result: "",
                createdAt: new Date(Date.now()).toISOString(),
              },
            ],
          };
        else
          this.state = {
            ...this.state,
            messages: [
              ...this.state.messages,
              {
                id: request.id,
                peerId,
                direction: "outgoing",
                text: request.text,
                ...(request.taskId ? { taskId: request.taskId } : {}),
                delivered: false,
                createdAt: new Date(Date.now()).toISOString(),
              },
            ],
          };
        this.state = { ...this.state, outbox: [...this.state.outbox, { peerId, request }] };
        await this.save();
      }
    }
    if (request.action === "chat.open" || request.action === "chat.send") {
      const key = `out:${peerId}:${request.id}`;
      const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const prior = this.state.chatRequests?.[key];
      if (prior && prior !== digest) throw new Error("请求 ID 已用于其他内容。");
      this.state = { ...this.state, chatRequests: { ...this.state.chatRequests, [key]: digest } };
      const pending = this.state.outbox.find(
        (entry) =>
          entry.peerId === peerId && "id" in entry.request && entry.request.id === request.id,
      );
      if (pending && JSON.stringify(pending.request) !== JSON.stringify(request))
        throw new Error("请求 ID 已用于其他内容。");
      if (!pending) {
        if (this.state.outbox.length >= 500) throw new Error("待发送请求过多，请等待设备上线。");
        this.state = { ...this.state, outbox: [...this.state.outbox, { peerId, request }] };
        await this.save();
      }
    }
    const peer = this.trusted(peerId);
    try {
      const requestStartedAt = Date.now();
      const reply = Schema.decodeUnknownSync(PeerRemoteReply)(
        await peerRequest(this.address(peer), peer.cert, this.identity, "/rpc", request),
      );
      // Revocation during a network request must not resurrect its authority.
      this.trusted(peerId);
      this.chatSupport.set(peerId, reply.chatProtocol === 1 || reply.chat !== undefined);
      await this.mergeReply(peerId, reply, Math.max(0, Date.now() - requestStartedAt));
      if (
        request.action === "task" ||
        request.action === "message" ||
        request.action === "chat.open" ||
        request.action === "chat.send"
      ) {
        this.state = {
          ...this.state,
          outbox: this.state.outbox.filter(
            (entry) =>
              !(
                entry.peerId === peerId &&
                "id" in entry.request &&
                entry.request.id === request.id
              ),
          ),
          messages: this.state.messages.map((entry) =>
            request.action === "message" &&
            entry.peerId === peerId &&
            entry.direction === "outgoing" &&
            entry.id === request.id
              ? { ...entry, delivered: true }
              : entry,
          ),
        };
        await this.save();
      }
      this.health.set(peerId, {
        online: true,
        error: null,
        lastSeenAt: new Date(Date.now()).toISOString(),
        capabilities: reply.capabilities ?? [],
      });
      return reply;
    } catch (error) {
      this.health.set(peerId, {
        ...this.health.get(peerId),
        online: false,
        error: errorText(error),
      });
      throw error;
    }
  }

  private async mergeReply(peerId: string, reply: PeerRemoteReply, transitMs: number) {
    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((task) => {
        const remote = reply.tasks.find(
          (entry) =>
            entry.id === task.id && entry.direction === "incoming" && entry.peerId === this.id,
        );
        if (task.direction !== "outgoing" || task.peerId !== peerId || !remote) return task;
        const now = new Date(Date.now()).toISOString();
        this.taskSync.set(taskKey(task), now);
        const knownObservation =
          reply.capabilities?.includes("task-observation-v1") &&
          remote.observationAgeMs != null &&
          remote.observedAt &&
          Number.isFinite(Date.parse(remote.observedAt));
        this.taskObservations.set(taskKey(task), {
          ...(remote.observedAt ? { observedAt: remote.observedAt } : {}),
          localObservedAt: knownObservation
            ? Date.now() - remote.observationAgeMs! - transitMs
            : null,
          stale: remote.stale === true || !knownObservation,
        });
        const changed =
          task.state !== remote.state ||
          task.result !== remote.result ||
          task.threadId !== remote.threadId ||
          task.updatedAt !== (remote.updatedAt ?? task.updatedAt) ||
          JSON.stringify(task.attention ?? []) !== JSON.stringify(remote.attention ?? []) ||
          JSON.stringify(task.localRecovery ?? []) !== JSON.stringify(remote.localRecovery ?? []);
        return {
          ...task,
          threadId: remote.threadId,
          state: remote.state,
          result: remote.result,
          updatedAt: remote.updatedAt ?? (changed ? now : (task.updatedAt ?? task.createdAt)),
          // Heartbeats are in memory; durable snapshots change only with task data.
          syncedAt: changed || !task.syncedAt ? now : task.syncedAt,
          attention: remote.attention ?? [],
          localRecovery: remote.localRecovery ?? [],
          ...(remote.observedAt && (changed || !task.observedAt)
            ? { observedAt: remote.observedAt }
            : {}),
        };
      }),
    };
    await this.save();
  }

  private async receive(peerId: string, request: PeerRemoteRequest): Promise<PeerRemoteReply> {
    this.requireEnabled();
    this.trusted(peerId);
    if (isPeerChatRequest(request)) {
      if (!this.options.chats) throw new Error("此设备尚不支持远端主控对话，请更新 Metis。");
      if ("id" in request) {
        const key = `in:${peerId}:${request.id}`;
        const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
        const previous = this.state.chatRequests?.[key];
        if (previous && previous !== digest) throw new Error("请求 ID 已用于其他内容。");
        if (!previous) {
          this.state = {
            ...this.state,
            chatRequests: { ...this.state.chatRequests, [key]: digest },
          };
          await this.save();
        }
      }
      const chat = await this.options.chats.handle(peerId, request);
      this.trusted(peerId);
      return {
        name: this.state.name,
        project: null,
        tasks: [],
        messages: [],
        chat,
        chatProtocol: 1,
      };
    }
    if (
      request.action === "task" &&
      this.state.messages.some(
        (entry) =>
          entry.direction === "incoming" && entry.peerId === peerId && entry.id === request.id,
      )
    )
      throw new Error("请求 ID 已用于消息。");
    if (
      request.action === "message" &&
      this.state.tasks.some(
        (entry) =>
          entry.direction === "incoming" && entry.peerId === peerId && entry.id === request.id,
      )
    )
      throw new Error("请求 ID 已用于任务。");
    if (request.action === "respond") {
      const task = this.state.tasks.find(
        (entry) =>
          entry.direction === "incoming" && entry.peerId === peerId && entry.id === request.taskId,
      );
      if (!task?.threadId) throw new Error("任务不存在或不属于此设备。");
      if (terminal(task) || task.state === "queued") throw new Error("任务当前不可回答。");
      if (this.taskSnapshot(task).stale)
        throw new Error("执行状态已过期，请等待本机刷新后再处理。");
      if (!this.execution.respond) throw new Error("此设备不支持远程审批或回答。");
      // Adapter validates the live interaction generation before dispatching through
      // the ordinary execution-side engine. Responses never enter the retry outbox.
      await this.execution.respond(task.threadId, request);
      this.updateTaskStatus(task, await this.execution.status(task.threadId));
      await this.save();
    } else if (request.action === "message") {
      if (request.taskId && !this.messageTarget(peerId, request.taskId))
        throw new Error("消息关联的任务不存在或不属于此设备。");
      const existing = this.state.messages.find(
        (entry) =>
          entry.direction === "incoming" && entry.peerId === peerId && entry.id === request.id,
      );
      if (existing && (existing.text !== request.text || existing.taskId !== request.taskId))
        throw new Error("请求 ID 内容冲突。");
      if (!existing) {
        this.state = {
          ...this.state,
          messages: [
            ...this.state.messages,
            {
              id: request.id,
              peerId,
              direction: "incoming",
              text: request.text,
              ...(request.taskId ? { taskId: request.taskId } : {}),
              delivered: !request.taskId,
              createdAt: new Date(Date.now()).toISOString(),
            },
          ],
        };
        await this.save();
      }
    } else if (request.action === "task") {
      if (!this.state.templateThreadId) throw new Error("对方尚未选择接收任务的会话配置。");
      const existing = this.state.tasks.find(
        (task) => task.direction === "incoming" && task.peerId === peerId && task.id === request.id,
      );
      if (existing && existing.text !== request.text) throw new Error("请求 ID 内容冲突。");
      if (!existing) {
        if (
          this.state.tasks.filter((task) => task.direction === "incoming" && !terminal(task))
            .length >= 50
        )
          throw new Error("对方任务队列已满。");
        const threadId = `peer-${createHash("sha256").update(`${peerId}:${request.id}`).digest("hex").slice(0, 32)}`;
        this.state = {
          ...this.state,
          tasks: [
            ...this.state.tasks,
            {
              id: request.id,
              peerId,
              direction: "incoming",
              text: request.text,
              threadId,
              sourceThreadId: null,
              state: "queued",
              result: "",
              createdAt: new Date(Date.now()).toISOString(),
            },
          ],
        };
        await this.save();
      }
    } else if (request.action === "cancel") {
      const task = this.state.tasks.find(
        (entry) =>
          entry.direction === "incoming" && entry.peerId === peerId && entry.id === request.taskId,
      );
      if (!task) throw new Error("任务不存在或不属于此设备。");
      if (!terminal(task)) {
        if (task.state !== "queued" && task.threadId) {
          await this.execution.cancel(task.threadId, task.id);
          const status = await this.execution.status(task.threadId);
          this.updateTaskStatus(task, status);
        } else
          this.state = {
            ...this.state,
            tasks: this.state.tasks.map((entry) =>
              entry === task
                ? { ...task, state: "interrupted", observedAt: new Date(Date.now()).toISOString() }
                : entry,
            ),
          };
        await this.save();
      }
    }
    return {
      capabilities: this.execution.respond
        ? ["task-status-v1", "task-responses-v1", "task-observation-v1"]
        : ["task-status-v1", "task-observation-v1"],
      name: this.state.name,
      ...(this.options.chats ? { chatProtocol: 1 as const } : {}),
      project: await this.execution.project(this.state.templateThreadId),
      tasks: this.state.tasks
        .filter(
          (task) =>
            task.direction === "incoming" &&
            task.peerId === peerId &&
            (!("taskId" in request) || !request.taskId || task.id === request.taskId),
        )
        .slice(-50)
        .map((task) => this.taskSnapshot(task)),
      messages: this.state.messages.filter((message) => message.peerId === peerId).slice(-20),
    };
  }

  private updateTaskStatus(task: PeerTask, status: Awaited<ReturnType<PeerExecution["status"]>>) {
    const now = new Date(Date.now()).toISOString();
    const observedAt = status.observedAt ?? now;
    this.taskObservations.set(taskKey(task), {
      observedAt,
      localObservedAt: Date.parse(observedAt),
      stale: false,
    });
    const changed =
      task.state !== status.state ||
      task.result !== status.result ||
      JSON.stringify(task.attention ?? []) !== JSON.stringify(status.attention ?? []) ||
      JSON.stringify(task.localRecovery ?? []) !== JSON.stringify(status.localRecovery ?? []);
    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((entry) =>
        entry === task
          ? {
              ...task,
              ...status,
              attention: status.attention ?? [],
              localRecovery: status.localRecovery ?? [],
              observedAt: changed || !task.observedAt ? observedAt : task.observedAt,
              updatedAt: status.updatedAt ?? (changed ? now : (task.updatedAt ?? task.createdAt)),
              syncedAt: changed || !task.syncedAt ? now : task.syncedAt,
            }
          : entry,
      ),
    };
  }

  private messageTarget(peerId: string, taskId: string): string | null {
    const task = this.state.tasks.find((entry) => entry.peerId === peerId && entry.id === taskId);
    return task ? (task.direction === "incoming" ? task.threadId : task.sourceThreadId) : null;
  }

  private async checkProjectUpdates(): Promise<void> {
    if (Date.now() - this.projectUpdateCheckedAt < 15000) return;
    this.projectUpdateCheckedAt = Date.now();
    const current = (rule: ProjectUpdateRule) =>
      !this.closing &&
      this.state.enabled &&
      this.state.projectUpdates?.some(
        (entry) =>
          entry.peerId === rule.peerId && entry.generation === rule.generation && entry.enabled,
      ) &&
      this.state.peers.some((peer) => peer.id === rule.peerId);
    const update = async (rule: ProjectUpdateRule, changes: Partial<ProjectUpdateRule>) => {
      if (!current(rule)) return;
      this.state = {
        ...this.state,
        projectUpdates: (this.state.projectUpdates ?? []).map((entry) =>
          entry.peerId === rule.peerId
            ? { ...entry, ...changes, updatedAt: new Date().toISOString() }
            : entry,
        ),
      };
      await this.save();
    };
    for (const rule of this.state.projectUpdates ?? []) {
      if (!current(rule)) continue;
      try {
        // Wait for this machine's previous update turn before sending another.
        // Read-only observation never injects remote output into a local agent turn.
        if (!rule.pending && rule.chatId && ["sent", "running", "waiting"].includes(rule.status)) {
          const reply = await this.remote(rule.peerId, {
            action: "chat.read",
            chatId: rule.chatId,
          });
          const thread = reply.chat?.thread;
          if (!thread) throw new Error("无法读取更新会话，请在远端会话查看执行结果。");
          const waiting =
            thread.hasPendingApprovals || thread.hasPendingUserInput || thread.claudeCacheReview;
          const turn = thread.latestTurn;
          const result =
            thread.messages.findLast((message) => message.role === "assistant")?.text ?? "";
          const status = waiting
            ? "waiting"
            : !turn
              ? "sent"
              : turn.state === "running"
                ? "running"
                : turn.state === "completed"
                  ? "completed"
                  : "error";
          await update(rule, { status, result: result.slice(-4000), error: null });
          if (["sent", "running", "waiting"].includes(status)) continue;
        }
        const published =
          rule.pending ??
          (await (this.options.publishedProjectUpdate ?? readPublishedProjectUpdate)(
            rule.repositoryPath,
            rule.peerId,
          ));
        if (!current(rule)) continue;
        if (!published || published.commit === rule.lastCommit) {
          if (rule.error) await update(rule, { error: null });
          continue;
        }
        // Save the exact event before either network call. The ordinary chat outbox
        // and engine receipts make retries after offline periods or restart idempotent.
        await update(rule, { pending: published, status: "pending", error: null });
        if (!current(rule)) continue;
        await this.remote(rule.peerId, {
          action: "chat.open",
          id: published.eventId,
          title: `Metis 更新 · ${published.commit.slice(0, 8)}`,
        });
        if (!current(rule)) continue;
        await this.remote(rule.peerId, {
          action: "chat.send",
          chatId: published.eventId,
          id: `${published.eventId}:send`,
          text: projectUpdateMessage(published),
        });
        await update(rule, {
          pending: null,
          lastCommit: published.commit,
          chatId: published.eventId,
          status: "sent",
          result: "",
          error: null,
        });
      } catch (error) {
        await update(rule, { error: errorText(error) });
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.closing || !this.state.enabled) return;
    this.ticking = true;
    let finish!: () => void;
    this.tickFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      this.expirePending();
      await this.checkProjectUpdates();
      for (const pending of [...this.pending.values()].filter((entry) => !entry.incoming)) {
        try {
          const result = Schema.decodeUnknownSync(PairReply)(
            await peerRequest(pending.address, pending.cert, this.identity, "/pair-status", {
              requestId: pending.requestId,
            }),
          );
          if (result.approved && this.pending.has(pending.requestId) && !this.closing) {
            this.state = {
              ...this.state,
              peers: [
                ...this.state.peers.filter((peer) => peer.id !== pending.id),
                { id: pending.id, name: result.name, address: pending.address, cert: pending.cert },
              ],
            };
            await this.save();
            this.pending.delete(pending.requestId);
          }
        } catch {
          /* Pairing stays visible until its explicit expiry. */
        }
      }
      for (const peer of this.state.peers) {
        if (this.closing) return;
        try {
          for (const item of this.state.outbox
            .filter((entry) => entry.peerId === peer.id)
            .slice(0, 10)) {
            if (this.closing) return;
            try {
              await this.remote(peer.id, item.request);
            } catch (error) {
              const request = item.request;
              if (request.action === "task") {
                this.state = {
                  ...this.state,
                  tasks: this.state.tasks.map((task) =>
                    task.direction === "outgoing" &&
                    task.peerId === peer.id &&
                    task.id === request.id &&
                    task.state === "queued"
                      ? { ...task, result: `等待重试：${errorText(error)}` }
                      : task,
                  ),
                };
                await this.save();
              }
            }
          }
          await this.remote(peer.id, { action: "status" });
          // The summary is bounded; older outstanding tasks still need updates.
          for (const task of this.state.tasks.filter(
            (entry) =>
              entry.direction === "outgoing" && entry.peerId === peer.id && !terminal(entry),
          )) {
            if (this.closing) return;
            await this.remote(peer.id, { action: "status", taskId: task.id });
          }
        } catch {
          /* Durable outbox retries after reconnect; expose last error. */
        }
      }
      // Serialize admission and cancellation with the queue runner.
      const run = this.incoming.then(async () => {
        if (this.closing) return;
        for (const message of this.state.messages.filter(
          (entry) => entry.direction === "incoming" && !entry.delivered && entry.taskId,
        )) {
          if (!this.state.peers.some((peer) => peer.id === message.peerId)) continue;
          const target = this.messageTarget(message.peerId, message.taskId!);
          // A queued worker has not been created yet; try on the next pass.
          if (
            !target ||
            this.state.tasks.some((task) => task.threadId === target && task.state === "queued")
          )
            continue;
          try {
            await this.execution.deliver(target, message);
            this.state = {
              ...this.state,
              messages: this.state.messages.map((entry) =>
                entry === message ? { ...message, delivered: true } : entry,
              ),
            };
          } catch (error) {
            this.error = `消息已收到，投递会话等待重试：${errorText(error)}`;
          }
        }
        const active = this.state.tasks.filter(
          (task) => task.direction === "incoming" && task.state !== "queued" && !terminal(task),
        );
        for (const task of active) {
          if (!task.threadId) continue;
          const status = await this.execution.status(task.threadId);
          this.updateTaskStatus(task, status);
        }
        const busy = this.state.tasks.some(
          (task) => task.direction === "incoming" && task.state !== "queued" && !terminal(task),
        );
        const next = this.state.tasks.find(
          (task) =>
            task.direction === "incoming" &&
            task.state === "queued" &&
            this.state.peers.some((peer) => peer.id === task.peerId),
        );
        if (!busy && next && this.state.templateThreadId) {
          try {
            const threadId = await this.execution.submit(next, this.state.templateThreadId);
            this.state = {
              ...this.state,
              tasks: this.state.tasks.map((task) =>
                task === next
                  ? {
                      ...task,
                      threadId,
                      state: "running",
                      updatedAt: new Date(Date.now()).toISOString(),
                      observedAt: new Date(Date.now()).toISOString(),
                    }
                  : task,
              ),
            };
          } catch (error) {
            this.error = `任务接入失败，将重试：${errorText(error)}`;
          }
        }
        await this.save();
      });
      this.incoming = run.catch(() => {});
      await run;
      for (const task of this.state.tasks.filter(
        (entry) =>
          entry.direction === "outgoing" &&
          terminal(entry) &&
          entry.sourceThreadId &&
          !this.state.notified.includes(entry.id),
      )) {
        if (this.closing || !this.state.peers.some((peer) => peer.id === task.peerId)) continue;
        try {
          await this.execution.notify(task);
          this.state = { ...this.state, notified: [...this.state.notified, task.id] };
          await this.save();
        } catch (error) {
          this.error = `任务结果仍保留在设备列表，回传原会话失败：${errorText(error)}`;
        }
      }
    } finally {
      this.ticking = false;
      finish();
    }
  }
}
