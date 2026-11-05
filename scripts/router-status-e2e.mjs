/** Run with bun. Exercises a fresh real server through the application's owner RPC.
 * No existing instance, database, settings or external messaging transport is used.
 * --live-worker additionally runs one real Codex task and checks result delivery.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { connectOwnerUrl } from "./computer-use-fixtures/packaged-client.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(tmpdir(), "metis-router-e2e-"));
const home = path.join(root, "home");
const token = randomUUID();
const modelSelection = { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex };
const runtimeMode = "approval-required";
const results = [];
const replays = [];
const liveWorker = process.argv.includes("--live-worker");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
let owner;
let server;
let serverOutput = "";
let serverError;
let exited;
let controller;
let activeWorker;
let passed = false;

async function startServer(port, env) {
  serverError = undefined;
  server = spawn(
    process.execPath,
    [
      "run",
      "apps/server/src/index.ts",
      "--home-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  exited = new Promise((resolve) => {
    server.once("exit", resolve);
    server.once("error", (error) => {
      serverError = error;
      resolve(null);
    });
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      serverOutput += chunk.toString();
    });
  await until(
    async () => {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error(`Server exited: ${serverOutput.slice(-4000)}`);
      return fetch(`http://127.0.0.1:${port}/api/health`).then(
        () => true,
        () => false,
      );
    },
    Boolean,
    "server startup",
    60_000,
  );
  owner = await connectOwnerUrl(`ws://127.0.0.1:${port}/?token=${token}`);
}
async function stopServer() {
  await owner?.close();
  owner = undefined;
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const ipv6 = createServer();
  await new Promise((resolve, reject) => {
    ipv6.once("error", reject);
    ipv6.listen({ host: "::1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => ipv6.close(resolve));
  return port;
}
async function until(read, predicate, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const rpc = (name, input) => owner.run(owner.api[name](input));
const dispatch = (command) => rpc("orchestration.dispatchCommand", command);
const detail = async (threadId) =>
  (await rpc("orchestration.getThreadDetailSnapshot", { threadId }))?.thread;
function turn(threadId, text, providerOptions) {
  const id = randomUUID();
  return {
    type: "thread.turn.start",
    commandId: id,
    threadId,
    routingMode: "auto",
    message: { messageId: `message-${id}`, role: "user", text, attachments: [] },
    runtimeMode,
    interactionMode: "default",
    dispatchMode: "queue",
    // Deliberately old to detect copying input time into the response.
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(providerOptions ? { providerOptions } : {}),
  };
}
async function request(threadId, text, expected, providerOptions, maxMs = 2_000) {
  const input = turn(threadId, text, providerOptions);
  const replyId = `router-${createHash("sha256").update(input.commandId).digest("hex")}`;
  const startedAt = Date.now();
  const started = performance.now();
  const admitted = await dispatch(input);
  const admissionMs = performance.now() - started;
  assert.equal(admitted.routed, true, "expected durable Router admission");
  const thread = await until(
    () => detail(threadId),
    (t) => t.messages.some((m) => m.id === replyId),
    text,
  );
  const response = thread.messages.find((message) => message.id === replyId);
  const elapsedMs = performance.now() - started;
  assert.match(response.text, expected);
  assert.ok(
    Date.parse(response.createdAt) >= startedAt,
    "response timestamp must reflect production time",
  );
  assert.ok(elapsedMs < maxMs, `${text} took ${elapsedMs.toFixed(0)} ms`);
  await dispatch(input);
  const replay = await detail(threadId);
  assert.equal(
    replay.messages.filter((m) => m.id === replyId).length,
    1,
    "retry must not duplicate reply",
  );
  assert.equal(
    replay.messages.filter((m) => m.id === input.message.messageId).length,
    1,
    "retry must not duplicate input",
  );
  replays.push({ threadId, input, response });
  results.push({
    text,
    admissionMs: Math.round(admissionMs),
    elapsedMs: Math.round(elapsedMs),
    response: response.text,
  });
  return { input, response };
}

try {
  const port = await freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("SYNARA_") && !key.startsWith("VITE_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  Object.assign(env, {
    SYNARA_HOME: home,
    SYNARA_AUTH_TOKEN: token,
    SYNARA_NO_BROWSER: "true",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  });
  const dryRun = execFileSync(
    process.execPath,
    [
      "scripts/dev-runner.ts",
      "dev:server",
      "--home-dir",
      home,
      "--port",
      String(port),
      "--no-browser",
      "--dry-run",
    ],
    { cwd: repo, env, encoding: "utf8" },
  );
  assert.ok(dryRun.includes(home), "dry run must select isolated home");
  await writeFile(path.join(root, "dry-run.txt"), dryRun.replaceAll(token, "<test-token>"));
  await startServer(port, env);
  await rpc("metis.control", { input: { action: "growth", enabled: false } });
  const identity = await rpc("metis.control", {
    input: { action: "open", modelSelection, runtimeMode },
  });
  controller = identity.threadId;
  assert.ok(controller);
  const source = await detail(controller);
  const ordinary = `router-e2e-${randomUUID()}`;
  await dispatch({
    type: "thread.create",
    commandId: randomUUID(),
    threadId: ordinary,
    projectId: source.projectId,
    title: "Isolated ordinary conversation",
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  const marker = path.join(root, "unexpected-provider-start");
  const sentinel = path.join(root, "provider-sentinel");
  // Only this test's request-level provider override sees the sentinel.
  await writeFile(sentinel, `#!/bin/sh\necho invoked >> '${marker}'\nsleep 3\nexit 97\n`, {
    mode: 0o700,
  });
  const providerOptions = { codex: { binaryPath: sentinel } };
  const local = ["进度如何", "优化进展如何？", "当前任务进展怎么样？", "status"];
  for (const text of local) await request(controller, text, /尚无已启动任务/, providerOptions);
  for (const text of [
    "现在有进行中的 Metis 会话吗",
    "当前 Metis 有哪些运行中的任务？",
    "目前有哪些正在进行的会话？",
    "show all running tasks",
  ]) {
    await request(controller, text, /当前 Metis 没有进行中的会话/, providerOptions);
  }
  await request(ordinary, "列出所有运行中的任务", /此会话无法读取全局/, providerOptions);
  assert.equal(await exists(marker), false, "fast paths must never start a model process");
  // A compound action must leave the fast path. The executable probe proves it did.
  const blocked = request(
    controller,
    "当前 Metis 有哪些运行中的任务？然后停止它们",
    /独立响应通道暂时不可用/,
    providerOptions,
    10_000,
  );
  void blocked.catch(() => {});
  await until(() => exists(marker), Boolean, "blocked classifier started");
  await request(controller, "优化进展如何？", /尚无已启动任务/, providerOptions);
  const pending = await request(
    controller,
    "list active sessions",
    /正在路由或提交/,
    providerOptions,
  );
  assert.match(pending.response.text, /没有进行中的会话/);
  await blocked;
  assert.equal(await exists(marker), true, "compound instruction must not be swallowed as status");

  if (liveWorker) {
    const input = turn(
      controller,
      "新任务：请只回复 ROUTER_E2E_WORKER_OK。不要调用工具，不要读取或修改文件。",
    );
    input.createdAt = new Date().toISOString();
    await dispatch(input);
    const snapshot = await until(
      () => rpc("orchestration.getSnapshot", {}),
      (s) =>
        s.threads.some((t) => t.sourceThreadId === controller && t.creationSource === "router"),
      "real worker creation",
      60_000,
    );
    activeWorker = snapshot.threads.find(
      (t) => t.sourceThreadId === controller && t.creationSource === "router",
    ).id;
    await until(
      () => detail(activeWorker),
      (t) =>
        t.session?.status === "running" ||
        t.session?.status === "starting" ||
        t.latestTurn?.state === "running",
      "real worker starting",
      30_000,
    );
    await request(controller, "优化进展如何？", /任务仍在运行|ROUTER_E2E_WORKER_OK/, undefined);
    const global = await request(
      controller,
      "当前 Metis 有哪些运行中的任务？",
      /个进行中的会话/,
      undefined,
    );
    assert.ok(
      global.response.text.includes(activeWorker),
      "global state must include actual independent worker",
    );
    await request(ordinary, "list active sessions", /无法读取全局/, providerOptions);
    await request(
      controller,
      `任务 ${activeWorker} 进度如何`,
      /任务仍在运行|ROUTER_E2E_WORKER_OK/,
      providerOptions,
    );
    const finished = await until(
      () => detail(activeWorker),
      (t) => t.latestTurn?.state === "completed" || t.latestTurn?.state === "failed",
      "live provider completion",
      120_000,
    );
    assert.equal(finished.latestTurn.state, "completed");
    assert.ok(
      finished.messages.some(
        (m) => m.role === "assistant" && m.text.includes("ROUTER_E2E_WORKER_OK"),
      ),
      "real model must return the expected output",
    );
    await until(
      () => detail(controller),
      (t) =>
        t.messages.some((m) => m.role === "assistant" && m.text.includes("ROUTER_E2E_WORKER_OK")),
      "completion delivered to original conversation",
      90_000,
    );
    results.push({ liveWorker: activeWorker, provider: modelSelection, completionDelivered: true });
  }
  await stopServer();
  await startServer(port, env);
  const saved = replays[0];
  await dispatch(saved.input);
  const afterRestart = await detail(saved.threadId);
  assert.deepEqual(
    afterRestart.messages.find((m) => m.id === saved.response.id),
    saved.response,
    "restart must preserve the exact saved reply including its timestamp",
  );
  assert.equal(afterRestart.messages.filter((m) => m.id === saved.response.id).length, 1);
  await request(controller, "进度如何", /尚无已启动任务|当前没有正在执行的任务/, providerOptions);
  results.push({ restartReplay: true });
  assert.match(serverOutput, /Router dispatch completed/);
  assert.match(serverOutput, /planMs/);
  assert.match(serverOutput, /queueWaitMs/);
  assert.match(serverOutput, /executionMs/);
  passed = true;
  console.log(JSON.stringify({ passed, root, liveWorker, results }, null, 2));
} finally {
  await stopServer();
  await writeFile(path.join(root, "server.log"), serverOutput.replaceAll(token, "<test-token>"));
  await writeFile(
    path.join(root, "results.json"),
    JSON.stringify({ passed, liveWorker, results }, null, 2),
  );
  console.log(`Evidence: ${root}`);
}
