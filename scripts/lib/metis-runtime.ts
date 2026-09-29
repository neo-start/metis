import { normalizeSecureRelayUrl } from "@synara/shared/workbenchRemote";
import { isAbsolute, join, resolve } from "node:path";

/** Share the existing desktop data unless the operator explicitly opts out. */
export function metisRuntimeConfiguration(
  root: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  const supported = new Set(["--local", "--isolated", "--dry-run"]);
  if (args.some((arg) => !supported.has(arg))) throw new Error("Unknown Metis service option.");
  const local = args.includes("--local");
  const isolated = args.includes("--isolated");
  if (isolated && environment.METIS_HOME?.trim()) {
    throw new Error("Use either METIS_HOME or --isolated, not both.");
  }
  const requestedHome = environment.METIS_HOME?.trim();
  const home = requestedHome
    ? isAbsolute(requestedHome)
      ? requestedHome
      : resolve(root, requestedHome)
    : join(root, isolated ? ".agent-workbench-remote" : ".agent-workbench");
  const rawPort = environment.METIS_PORT?.trim() || "4785";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) {
    throw new Error("METIS_PORT must be an integer from 1024 to 65535.");
  }
  const port = Number(rawPort);
  const origin = local
    ? null
    : normalizeSecureRelayUrl(
        environment.METIS_PUBLIC_URL ?? environment.WORKBENCH_PUBLIC_URL ?? "",
      );
  const tunnelToken = local
    ? undefined
    : (environment.METIS_TUNNEL_TOKEN ?? environment.WORKBENCH_TUNNEL_TOKEN)?.trim();
  if (!local && (!origin || !tunnelToken)) {
    throw new Error(
      "Remote service needs METIS_PUBLIC_URL (root HTTPS URL) and METIS_TUNNEL_TOKEN.",
    );
  }
  return {
    local,
    isolated,
    home,
    port,
    origin,
    tunnelToken,
    tunnelCommand:
      environment.METIS_CLOUDFLARED_PATH ?? environment.WORKBENCH_CLOUDFLARED_PATH ?? "cloudflared",
    localOrigin: `http://127.0.0.1:${port}`,
    dryRun: args.includes("--dry-run"),
  };
}

/** A child log can contain many URLs. Persist only this server's pairing URL. */
export function findMetisPairingUrl(line: string, origin: string): string | undefined {
  for (const match of line.matchAll(/https?:\/\/[^\s"'<>]+\/pair#token=[A-Z0-9]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.origin === origin && url.pathname === "/pair") return url.toString();
    } catch {
      // Provider and startup logs are untrusted text.
    }
  }
  return undefined;
}

/** File the attached desktop reads to serve browser/computer tools for this service. */
export const METIS_DESKTOP_HOST_FILE = "desktop-host.json";
/** Same one-shot descriptor the desktop-owned backend uses for the host capability. */
export const METIS_HOST_CAPABILITY_FD = 3;
// Darwin caps sockaddr_un paths near 104 bytes.
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export interface MetisDesktopHostBridge {
  readonly directory: string;
  readonly browserHostPipePath: string;
  readonly cuaHostSocket: string;
}

/**
 * Fixed per-workspace sockets the attached desktop listens on. The server dials
 * them per call, so the desktop may attach after the service starts.
 */
export function metisDesktopHostBridge(
  home: string,
  platform: NodeJS.Platform = process.platform,
): MetisDesktopHostBridge | null {
  if (platform === "win32") return null;
  const directory = join(home, "run");
  const browserHostPipePath = join(directory, "browser-host.sock");
  const cuaHostSocket = join(directory, "cua-host.sock");
  if (
    Buffer.byteLength(browserHostPipePath) > MAX_UNIX_SOCKET_PATH_BYTES ||
    Buffer.byteLength(cuaHostSocket) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    return null;
  }
  return { directory, browserHostPipePath, cuaHostSocket };
}

/** Do not pass connector credentials or inherited desktop capabilities to agents. */
export function metisServerEnvironment(
  environment: NodeJS.ProcessEnv,
  config: ReturnType<typeof metisRuntimeConfiguration>,
  root: string,
  authToken: string,
  hostBridge: MetisDesktopHostBridge | null = null,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (
      key.startsWith("METIS_") ||
      key.startsWith("WORKBENCH_") ||
      key.startsWith("SYNARA_DESKTOP_") ||
      key.startsWith("SYNARA_BROWSER_HOST_") ||
      [
        "SYNARA_BROWSER_USE_PIPE_PATH",
        "SYNARA_CUA_HOST_SOCKET",
        "TUNNEL_TOKEN",
        "SYNARA_ALLOW_INSECURE_REMOTE",
        "SYNARA_PUBLIC_URL",
        "VITE_DEV_SERVER_URL",
        "VITE_WS_URL",
        "SYNARA_DEV_URL",
        "ELECTRON_RUN_AS_NODE",
      ].includes(key)
    )
      delete next[key];
  }
  return {
    ...next,
    SYNARA_HOME: config.home,
    SYNARA_MODE: "web",
    SYNARA_HOST: "127.0.0.1",
    SYNARA_PORT: String(config.port),
    ...(config.origin ? { SYNARA_PUBLIC_URL: config.origin } : {}),
    SYNARA_AUTH_TOKEN: authToken,
    SYNARA_NO_BROWSER: "1",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    SYNARA_STATIC_DIR: join(root, "apps/web/dist"),
    // The capability itself travels only through the one-shot descriptor, never
    // the environment that provider CLIs inherit.
    ...(hostBridge
      ? {
          SYNARA_BROWSER_HOST_PIPE_PATH: hostBridge.browserHostPipePath,
          SYNARA_BROWSER_USE_PIPE_PATH: hostBridge.browserHostPipePath,
          SYNARA_BROWSER_HOST_CAPABILITY_FD: String(METIS_HOST_CAPABILITY_FD),
          SYNARA_CUA_HOST_SOCKET: hostBridge.cuaHostSocket,
        }
      : {}),
  };
}
