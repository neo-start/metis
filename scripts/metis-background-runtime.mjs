// Launcher-only orchestration. Reuse Synara's lifecycle lock and process boundary.
import { Effect } from "effect";
import { spawnProcess } from "@synara/shared/processRuntime";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../apps/server/src/persistence/DatabaseLifecycleLock.ts";
import { readMetisSharedService, readPrivateFile } from "../apps/desktop/src/metisSharedService.ts";
import { requestMetisBackground } from "../apps/desktop/src/metisBackgroundControl.ts";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export { requestMetisBackground };

export function prepareMetisBackgroundHome(home) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "Metis background services are supported only on macOS and Linux; Windows ACL support is unfinished.",
    );
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid()
  )
    throw new Error("Metis background home must be a private directory owned by this user.");
}

export async function acquireMetisBackgroundLock(home) {
  prepareMetisBackgroundHome(home);
  // Separate launcher admission from the backend's authoritative database lock.
  // Its token/reaper protocol handles concurrent launches and proven-dead owners.
  const lock = await Effect.runPromise(
    acquireDatabaseLifecycleLock(join(home, "metis-background")),
  );
  return () => Effect.runPromise(releaseDatabaseLifecycleLock(lock));
}

export async function startMetisBackgroundControl(home, status, stop) {
  const directory = join(resolve(home), "run");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid()
  )
    throw new Error("Metis background socket directory must be private.");
  const socket = join(directory, "background.sock");
  if (Buffer.byteLength(socket) > 100)
    throw new Error("Metis home is too long for its background socket.");
  // Called only while holding launcher admission; never unlinks a live owner's socket.
  fs.rmSync(socket, { force: true });
  const token = randomBytes(32).toString("hex");
  const descriptor = join(home, "metis-background.json");
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ready: status(), stopped: false }));
    } else if (request.method === "POST" && request.url === "/stop") {
      // Reply only after the owned children exit and durable ownership is released.
      void stop().then(
        () => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ready: false, stopped: true }));
        },
        () => response.writeHead(500).end(),
      );
    } else response.writeHead(404).end();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  fs.chmodSync(socket, 0o600);
  // Atomic replacement, private modes, no writes through stale symlinks.
  const temporary = `${descriptor}.${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ socket, token }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, descriptor);
  } catch (error) {
    server.close();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return () => {
    // Stop accepting new requests without waiting for this stop request to finish.
    server.close();
    fs.rmSync(descriptor, { force: true });
  };
}

export async function ensureMetisBackground({ home, command, args, cwd, env, timeoutMs = 45_000 }) {
  prepareMetisBackgroundHome(home);
  const readReady = async () => {
    let service;
    try {
      service = readMetisSharedService(home);
    } catch (error) {
      if (error.message.includes("starting or stopping")) return null;
      throw error;
    }
    if (!service) return null;
    // New services prove launcher identity; old services retain their existing
    // private-file + health attachment flow and are never signalled by PID.
    if (readPrivateFile(home, "metis-background.json")) {
      const control = await requestMetisBackground(home, "status");
      if (!control?.ready) return null;
    }
    try {
      const response = await fetch(`${service.localOrigin}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).startupReady === true) return service;
    } catch {
      /* Still starting. */
    }
    return null;
  };
  const existing = await readReady();
  if (existing) return existing;
  const log = fs.openSync(
    join(home, "metis-background.log"),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
    0o600,
  );
  let child;
  let spawnError;
  try {
    const stat = fs.fstatSync(log);
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid())
      throw new Error("Metis background log must be a private regular file.");
    child = spawnProcess(command, args, {
      cwd,
      env,
      ownProcessGroup: true,
      stdio: ["ignore", log, log],
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const service = await readReady();
    if (service) return service;
    // A concurrent launcher may have won admission; its readiness is shared.
    await delay(100);
  }
  throw new Error(
    `Metis background service did not become ready. Inspect ${join(home, "metis-background.log")}; no existing process was stopped.`,
  );
}

const ownedChildAlive = (child) =>
  child.pid && child.exitCode === null && child.signalCode === null;

export async function stopMetisOwnedChildren(children, graceMs = 30_000) {
  await Promise.all(
    [...children].map(async (child) => {
      if (!ownedChildAlive(child)) return;
      child.kill("SIGTERM");
      const deadline = Date.now() + graceMs;
      while (ownedChildAlive(child) && Date.now() < deadline) await delay(25);
      // Killing only the backend root can strand provider children. Keep the
      // controller and admission lock alive so the user can inspect/retry safely.
      if (ownedChildAlive(child))
        throw new Error(
          "Metis child did not stop gracefully; ownership retained. Inspect the log and retry shutdown.",
        );
    }),
  );
}
