/** Isolated owner-RPC E2E. Default: deterministic provider process fixture.
 * --live --model <selected-model> exercises actual model routing and worker completion.
 * ROUTER_E2E_CODEX_HOME selects the operator's account only in the isolated instance.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { connectOwnerUrl } from "./computer-use-fixtures/packaged-client.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(tmpdir(), "metis-router-conversation-e2e-"));
const home = path.join(root, "home");
const token = randomUUID();
const argument = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const liveWorker = process.argv.includes("--live");
const modelSelection = {
  provider: liveWorker ? "codexSecondary" : "codex",
  model: process.argv.includes("--model") ? argument("--model") : DEFAULT_MODEL_BY_PROVIDER.codex,
};
const runtimeMode = "approval-required";
const results = [];
const replays = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
async function request(threadId, text, expected, providerOptions, maxMs = 60_000) {
  const input = turn(threadId, text, providerOptions);
  const replyId = `router-${createHash("sha256").update(input.commandId).digest("hex")}`;
  const startedAt = Date.now();
  const started = performance.now();
  const admitted = await dispatch(input);
  const admissionMs = performance.now() - started;
  assert.equal(admitted.routed, true, "expected durable Router admission");
  const thread = await until(
    () => detail(threadId),
    (t) => {
      const failure = t.messages.find(
        (m) => m.id === replyId.replace("router-", "router-failure-"),
      );
      if (failure) throw new Error(failure.text);
      return t.messages.some((m) => m.id === replyId);
    },
    text,
    maxMs,
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
  console.log(JSON.stringify({ text, elapsedMs: Math.round(elapsedMs) }));
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
  assert.ok(dryRun.includes(home));
  const marker = path.join(root, "provider-calls.jsonl");
  const binary = path.join(root, "provider-fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
const prompt=await Bun.stdin.text();
const args=process.argv.slice(2);
const id=crypto.randomUUID();
appendFileSync(${JSON.stringify(marker)},JSON.stringify({id,pid:process.pid,presentation:prompt.includes('PRESENTATION MODE:'),completion:prompt.includes('PRESENTATION MODE: completion')})+'\\n');
const output=args[args.indexOf('--output-last-message')+1];
if(!output)process.exit(2);
const answer=JSON.stringify({route:'reply',targetTaskId:'',reply:'ROUTER_GENERATED_'+id});
writeFileSync(output,answer);
if(args.includes('--json')) {
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answer}}));
 console.log(JSON.stringify({type:'turn.completed'}));
 setTimeout(()=>process.exit(0),10000);
}
`,
    { mode: 0o700 },
  );
  await startServer(port, env);
  await rpc("server.updateSettings", {
    providers: {
      [modelSelection.provider]: {
        enabled: true,
        ...(liveWorker
          ? process.env.ROUTER_E2E_CODEX_HOME
            ? { homePath: process.env.ROUTER_E2E_CODEX_HOME }
            : {}
          : { binaryPath: binary }),
      },
    },
  });
  await rpc("metis.control", { input: { action: "growth", enabled: false } });
  controller = (
    await rpc("metis.control", { input: { action: "open", modelSelection, runtimeMode } })
  ).threadId;
  assert.ok(controller);
  const responsePattern = liveWorker ? /\S/ : /^ROUTER_GENERATED_/;
  const providerOptions = liveWorker ? undefined : { codex: { binaryPath: binary } };
  for (const text of ["你好", "查好了吗", "当前 Metis 有哪些运行中的任务？", "解释一下队列"]) {
    const response = await request(controller, text, responsePattern, providerOptions);
    assert.notEqual(response.response.text, "我在，收到你的消息了。");
  }
  const conversationalSnapshot = await rpc("orchestration.getSnapshot", {});
  assert.equal(
    conversationalSnapshot.threads.filter(
      (t) => t.sourceThreadId === controller && t.creationSource === "router",
    ).length,
    0,
    "simple conversation must finish with Router replies, without creating workers",
  );
  results.push({ simpleConversationCreatesNoWorker: true });
  if (!liveWorker) {
    await request(controller, "停止", responsePattern, providerOptions);
    await request(controller, "任务 unavailable 修改成中文", responsePattern, providerOptions);
    const calls = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(
      calls.length,
      6,
      "every input invokes generation exactly once; retries never regenerate",
    );
    assert.equal(calls.filter((c) => c.presentation).length, 5);
    assert.ok(
      results.filter((r) => r.elapsedMs !== undefined).every((r) => r.elapsedMs < 5000),
      "completed replies must not wait for the fixture's ten-second shutdown delay",
    );
    for (const call of calls) assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
    results.push({ providerProcessCalls: calls.length, allResponsesGenerated: true });
  } else {
    const created = await request(
      controller,
      "新任务：这是回传测试，不要调用工具或读写文件。请回复以下测试数据：ROUTER_LIVE_WORKER_OK；示例计算：2+3=5；验证范围：仅文本回传；限制：未做真实部署。",
      /\S/,
    );
    const snapshot = await until(
      () => rpc("orchestration.getSnapshot", {}),
      (s) =>
        s.threads.some((t) => t.sourceThreadId === controller && t.creationSource === "router"),
      "worker created",
      60000,
    );
    activeWorker = snapshot.threads.find(
      (t) => t.sourceThreadId === controller && t.creationSource === "router",
    ).id;
    const complete = await until(
      () => detail(controller),
      (t) => t.messages.some((m) => m.id === `router-completion:${activeWorker}`),
      "generated completion",
      180000,
    );
    const final = complete.messages.find((m) => m.id === `router-completion:${activeWorker}`);
    assert.ok(final.text.trim());
    assert.ok(
      complete.messages.findIndex((m) => m.id === created.response.id) <
        complete.messages.findIndex((m) => m.id === final.id),
      "initial Router acknowledgement must precede the completion report",
    );
    assert.match(final.text, /2\s*\+\s*3\s*=\s*5/);
    assert.match(final.text, /部署/);
    assert.notEqual(final.text, created.response.text);
    assert.ok(created.response.text.length < final.text.length, "initial reply should be brief");
    const worker = await detail(activeWorker);
    assert.equal(worker.latestTurn?.state, "completed");
    assert.ok(
      worker.messages.some(
        (m) => m.role === "assistant" && m.text.includes("ROUTER_LIVE_WORKER_OK"),
      ),
    );
    results.push({
      worker: activeWorker,
      realWorkerCompleted: true,
      briefReplyBeforeDetailedResult: true,
      generatedCompletion: final.text,
      requestId: created.input.commandId,
    });
    await request(controller, `任务 ${activeWorker} 进度如何`, /\S/);
  }
  await stopServer();
  await startServer(port, env);
  const saved = replays[0];
  await dispatch(saved.input);
  const after = await detail(saved.threadId);
  assert.deepEqual(
    after.messages.find((m) => m.id === saved.response.id),
    saved.response,
  );
  assert.equal(after.messages.filter((m) => m.id === saved.response.id).length, 1);
  if (!liveWorker) assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 6);
  results.push({ restartReplay: true });
  passed = true;
} catch (error) {
  results.push({ error: String(error) });
  process.exitCode = 1;
} finally {
  await stopServer();
  await writeFile(path.join(root, "server.log"), serverOutput.replaceAll(token, "<test-token>"));
  await writeFile(
    path.join(root, "results.json"),
    JSON.stringify({ passed, liveWorker, modelSelection, results }, null, 2),
  );
  console.log(JSON.stringify({ passed, liveWorker, root, results }, null, 2));
}
