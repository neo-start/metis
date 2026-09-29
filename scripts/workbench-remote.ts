// One persistent web runtime for desktop browsers and paired phones.
// Retain this filename and WORKBENCH_* aliases for existing operator scripts.
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveExecutable } from "@synara/shared/executable";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  findMetisPairingUrl,
  METIS_DESKTOP_HOST_FILE,
  METIS_HOST_CAPABILITY_FD,
  metisDesktopHostBridge,
  metisRuntimeConfiguration,
  metisServerEnvironment,
} from "./lib/metis-runtime";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let config: ReturnType<typeof metisRuntimeConfiguration>;
try {
  config = metisRuntimeConfiguration(root, process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid Metis service configuration.");
  process.exit(1);
}
const { home, origin, tunnelToken, localOrigin } = config;
const pairingOrigin = origin ?? localOrigin;
const tunnelBinary = config.local ? undefined : resolveExecutable(config.tunnelCommand);
if (!config.local && !tunnelBinary) {
  console.error("cloudflared is required for remote access. See docs/workbench/remote-access.md.");
  process.exit(1);
}
if (
  !existsSync(join(root, "apps/server/dist/index.mjs")) ||
  !existsSync(join(root, "apps/web/dist/index.html"))
) {
  console.error("Build first: npm exec --yes --package=bun@1.4.2 -- bun run build:desktop");
  process.exit(1);
}
if (config.dryRun) {
  console.log(
    `Metis ${config.local ? "local" : "remote"} service: ${pairingOrigin}; home=${home}; listener=${localOrigin}; no process started.`,
  );
  process.exit(0);
}

// Synara's authoritative DB lifecycle lock still owns admission/recovery.
// This read-only preflight supplies a useful message before starting a child.
const databaseLock = join(home, "userdata/state.sqlite.lifecycle-lock/owner.json");
if (existsSync(databaseLock)) {
  try {
    const owner = JSON.parse(readFileSync(databaseLock, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0)
      throw new Error("Invalid database lock.");
    process.kill(Number(owner.pid), 0);
    console.error(
      "This Metis workspace is already open. Quit its desktop/service before switching modes; the database was not opened.",
    );
    process.exit(1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(
        "Cannot confirm that this workspace is idle. Its database lock was left untouched.",
      );
      process.exit(1);
    }
    // The database layer, never this launcher, recovers a proven-dead DB owner.
  }
}
mkdirSync(home, { recursive: true, mode: 0o700 });
const lockPath = join(home, "launcher.pid");
const pairingPath = join(home, "owner-pairing-url.txt");
const statusPath = join(home, "metis-service.json");
const hostPath = join(home, METIS_DESKTOP_HOST_FILE);
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  let absent = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      absent = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  if (!absent) throw new Error("Metis service is already running or its launcher lock is invalid.");
  rmSync(lockPath);
}
writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
rmSync(pairingPath, { force: true });
rmSync(statusPath, { force: true });
rmSync(hostPath, { force: true });
const authToken = randomBytes(32).toString("hex");
// The attached desktop serves browser/computer tools on these sockets and
// proves itself with this capability, as the desktop-owned backend does.
const hostBridge = metisDesktopHostBridge(home);
const hostCapability = randomBytes(32).toString("base64url");
if (hostBridge) {
  mkdirSync(hostBridge.directory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(hostBridge.directory);
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error("Metis host socket directory is not a private directory.");
  chmodSync(hostBridge.directory, 0o700);
  writeFileSync(
    hostPath,
    JSON.stringify(
      {
        launcherPid: process.pid,
        browserHostPipePath: hostBridge.browserHostPipePath,
        cuaHostSocket: hostBridge.cuaHostSocket,
        capability: hostCapability,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
} else {
  console.log("Browser and computer tools are unavailable for this home path on this platform.");
}
const children = new Set<ChildProcess>();
let stopping = false;
let stopPromise: Promise<void> | undefined;
let pairingExpiry: ReturnType<typeof setTimeout> | undefined;

function stop(code: number): Promise<void> {
  if (stopPromise) return stopPromise;
  stopping = true;
  clearTimeout(pairingExpiry);
  stopPromise = (async () => {
    await Promise.all(
      [...children].map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        // Allow the backend's existing finalizers to stop its provider children.
        child.kill("SIGTERM");
        for (
          let attempt = 0;
          attempt < 300 && child.exitCode === null && child.signalCode === null;
          attempt++
        )
          await delay(100);
        if (child.exitCode === null && child.signalCode === null) {
          console.error("Metis child did not stop gracefully; forcing it to exit.");
          child.kill("SIGKILL");
          for (
            let attempt = 0;
            attempt < 50 && child.exitCode === null && child.signalCode === null;
            attempt++
          )
            await delay(100);
        }
      }),
    );
    rmSync(pairingPath, { force: true });
    if (
      [...children].some(
        (child) => child.pid && child.exitCode === null && child.signalCode === null,
      )
    ) {
      console.error("A Metis child is still alive; the launcher lock and status were retained.");
      process.exitCode = 1;
      return;
    }
    rmSync(statusPath, { force: true });
    rmSync(hostPath, { force: true });
    // Never remove another launcher's lock, even after an unusual recovery.
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid))
      rmSync(lockPath);
    process.exitCode = code;
  })();
  return stopPromise;
}

function observe(child: ChildProcess, label: string): void {
  children.add(child);
  child.once("error", () => {
    console.error(`${label} failed to start.`);
    void stop(1);
  });
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped (${code ?? "signal"}); closing the Metis service.`);
      void stop(1);
    }
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => {
      if (label === "server" && !stopping) {
        const pairingUrl = findMetisPairingUrl(line, pairingOrigin);
        if (pairingUrl) {
          writeFileSync(pairingPath, pairingUrl, { mode: 0o600 });
          clearTimeout(pairingExpiry);
          pairingExpiry = setTimeout(() => rmSync(pairingPath, { force: true }), 5 * 60_000);
          pairingExpiry.unref();
          console.log(`Owner pairing link (expires in 5 minutes): ${pairingPath}`);
        }
      }
      let safeLine = line
        .replaceAll(authToken, "[redacted]")
        .replace(/([#?&]token=)[^\s"'<>]+/g, "$1[redacted]");
      if (tunnelToken) safeLine = safeLine.replaceAll(tunnelToken, "[redacted]");
      console.log(`[${label}] ${safeLine}`);
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => {
    void stop(0);
  });

try {
  const environment = metisServerEnvironment(process.env, config, root, authToken, hostBridge);
  const nodeBinary = resolveExecutable("node");
  if (!nodeBinary) throw new Error("Node is required for the built server.");
  const server = spawnProcess(nodeBinary, [join(root, "apps/server/dist/index.mjs")], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  observe(server, "server");
  const capabilityPipe = server.stdio[METIS_HOST_CAPABILITY_FD];
  if (capabilityPipe && "end" in capabilityPipe) {
    capabilityPipe.on("error", () => undefined);
    capabilityPipe.end(hostBridge ? hostCapability : "");
  }
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (stopping) break;
    try {
      const response = await fetch(`${localOrigin}/health`, { signal: AbortSignal.timeout(500) });
      const health = (await response.json()) as { startupReady?: boolean };
      // Require a pairing URL from our own child's output, not just an occupied port.
      if (
        response.ok &&
        health.startupReady &&
        existsSync(pairingPath) &&
        server.exitCode === null &&
        server.signalCode === null
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Listener may not have opened yet. */
    }
    await delay(200);
  }
  if (!ready || stopping) throw new Error("Metis backend did not become ready.");
  writeFileSync(
    statusPath,
    JSON.stringify(
      {
        launcherPid: process.pid,
        serverPid: server.pid,
        localOrigin,
        publicOrigin: origin,
        home,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (tunnelBinary && tunnelToken) {
    // Reuse T3 ManagedEndpointRuntime's outbound connector invocation.
    observe(
      spawnProcess(tunnelBinary, ["tunnel", "run"], {
        cwd: root,
        env: {
          ...environment,
          SYNARA_AUTH_TOKEN: undefined,
          SYNARA_BROWSER_HOST_PIPE_PATH: undefined,
          SYNARA_BROWSER_USE_PIPE_PATH: undefined,
          SYNARA_BROWSER_HOST_CAPABILITY_FD: undefined,
          SYNARA_CUA_HOST_SOCKET: undefined,
          TUNNEL_TOKEN: tunnelToken,
        },
        stdio: "pipe",
      }),
      "tunnel",
    );
    console.log(
      `Metis backend ready. Tunnel requested for ${origin}; route its hostname to ${localOrigin}. Public reachability is not yet verified.`,
    );
  } else {
    console.log(
      `Metis ready at ${localOrigin}. Open the private owner pairing file to sign in. Closing a browser tab keeps tasks running; Ctrl+C stops the service.`,
    );
  }
} catch {
  console.error(
    "Metis service could not start. Check the redacted logs and docs/workbench/remote-access.md.",
  );
  await stop(1);
}
