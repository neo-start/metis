// Attach the existing Electron shell to Metis's separately owned web runtime.
// Reuse Synara's private-file checks and one-time /pair authentication protocol.
import * as fs from "node:fs";
import * as path from "node:path";

export interface MetisSharedService {
  readonly launcherPid: number;
  readonly serverPid: number;
  readonly localOrigin: string;
  readonly origin: string;
}

function assertPrivate(stat: fs.Stats, directory: boolean): void {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Metis shared-service files must be private and owned by this user.");
  }
}

export function readPrivateFile(
  home: string,
  name: string,
): { text: string; modifiedAt: number } | null {
  const file = path.join(home, name);
  if (!fs.existsSync(file)) return null;
  // POSIX ownership is verified here. Windows attachment needs an ACL-aware
  // credential reader before enabling this opt-in mode there.
  if (process.platform === "win32") {
    throw new Error("Shared-service desktop attachment is not available on Windows yet.");
  }
  const directory = fs.lstatSync(home);
  assertPrivate(directory, true);
  const before = fs.lstatSync(file);
  assertPrivate(before, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    assertPrivate(current, false);
    if (before.dev !== current.dev || before.ino !== current.ino || current.size > 16_384) {
      throw new Error("Metis shared-service file changed while opening it.");
    }
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(home);
    if (directory.dev !== after.dev || directory.ino !== after.ino) {
      throw new Error("Metis shared-service directory changed while opening it.");
    }
    return { text, modifiedAt: current.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("Cannot verify the Metis shared-service process.", { cause: error });
  }
}

// A workspace reached through a symlink (e.g. after renaming the checkout)
// is still the same workspace.
function canonicalHome(home: string): string {
  try {
    return fs.realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}

export function readMetisSharedService(home: string): MetisSharedService | null {
  const file = readPrivateFile(home, "metis-service.json");
  if (!file) return null;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(file.text) as Record<string, unknown>;
    if (!state || typeof state !== "object") throw new Error();
  } catch {
    throw new Error("Invalid Metis shared-service state.");
  }
  const { launcherPid, serverPid, localOrigin, publicOrigin } = state;
  if (
    !Number.isSafeInteger(launcherPid) ||
    !Number.isSafeInteger(serverPid) ||
    Number(launcherPid) <= 0 ||
    Number(serverPid) <= 0 ||
    typeof state.home !== "string" ||
    canonicalHome(state.home) !== canonicalHome(home) ||
    typeof localOrigin !== "string"
  ) {
    throw new Error("Metis shared-service state does not match this workspace.");
  }
  let local: URL;
  let origin: URL;
  try {
    local = new URL(localOrigin);
    origin = new URL(typeof publicOrigin === "string" ? publicOrigin : localOrigin);
  } catch {
    throw new Error("Invalid Metis shared-service address.");
  }
  if (
    local.protocol !== "http:" ||
    local.hostname !== "127.0.0.1" ||
    !local.port ||
    localOrigin !== local.origin ||
    (publicOrigin != null &&
      (typeof publicOrigin !== "string" ||
        origin.protocol !== "https:" ||
        publicOrigin !== origin.origin))
  ) {
    throw new Error("Metis shared service requires loopback HTTP and a root HTTPS public address.");
  }
  const launcherAlive = isAlive(Number(launcherPid));
  const serverAlive = isAlive(Number(serverPid));
  if (!launcherAlive && !serverAlive) return null;
  if (!launcherAlive || !serverAlive) {
    throw new Error(
      "Metis shared service is still starting or stopping; reopen the desktop shortly.",
    );
  }
  return {
    launcherPid: Number(launcherPid),
    serverPid: Number(serverPid),
    localOrigin: local.origin,
    origin: origin.origin,
  };
}

export interface MetisDesktopHostBridge {
  readonly browserHostPipePath: string;
  readonly cuaHostSocket: string;
  readonly capability: string;
}

/**
 * Sockets and capability the shared service's backend dials for browser and
 * computer tools. Only this launcher's private `run/` sockets are accepted.
 */
export function readMetisDesktopHostBridge(
  home: string,
  service: Pick<MetisSharedService, "launcherPid">,
): MetisDesktopHostBridge | null {
  const file = readPrivateFile(home, "desktop-host.json");
  if (!file) return null;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(file.text) as Record<string, unknown>;
    if (!state || typeof state !== "object") throw new Error();
  } catch {
    throw new Error("Invalid Metis desktop host state.");
  }
  const runDirectory = path.join(path.resolve(home), "run");
  const { launcherPid, browserHostPipePath, cuaHostSocket, capability } = state;
  if (
    launcherPid !== service.launcherPid ||
    typeof browserHostPipePath !== "string" ||
    typeof cuaHostSocket !== "string" ||
    browserHostPipePath !== path.join(runDirectory, "browser-host.sock") ||
    cuaHostSocket !== path.join(runDirectory, "cua-host.sock") ||
    typeof capability !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(capability)
  ) {
    throw new Error("Metis desktop host state does not match this shared service.");
  }
  assertPrivate(fs.lstatSync(runDirectory), true);
  return { browserHostPipePath, cuaHostSocket, capability };
}

export function isMetisSharedNavigationAllowed(origin: string, target: string): boolean {
  try {
    const url = new URL(target);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readMetisOwnerPairingUrl(home: string, origin: string): string | null {
  const file = readPrivateFile(home, "owner-pairing-url.txt");
  if (!file || Date.now() - file.modifiedAt >= 5 * 60_000) return null;
  return parseMetisPairingUrl(origin, file.text);
}

export function parseMetisPairingUrl(origin: string, value: string): string | null {
  if (value.length > 16_384) return null;
  try {
    const url = new URL(value.trim());
    const params = new URLSearchParams(url.hash.slice(1));
    if (
      !isMetisSharedNavigationAllowed(origin, url.href) ||
      url.pathname !== "/pair" ||
      url.search ||
      params.size !== 1 ||
      !/^[A-Z0-9]+$/.test(params.get("token") ?? "")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
