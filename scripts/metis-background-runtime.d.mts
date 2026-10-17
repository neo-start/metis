export const METIS_BACKEND_STARTUP_TIMEOUT_MS: number;
export function prepareMetisBackgroundHome(home: string): void;
export function acquireMetisBackgroundLock(home: string): Promise<() => Promise<void>>;
export function startMetisBackgroundControl(
  home: string,
  status: () => boolean,
  stop: () => Promise<void>,
): Promise<() => void>;
export function requestMetisBackground(
  home: string,
  action: "status" | "stop",
): Promise<{ ready: boolean; stopped: boolean } | null>;
export function ensureMetisBackground(options: {
  home: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ launcherPid: number; serverPid: number; localOrigin: string; origin: string }>;

export function stopMetisOwnedChildren(
  children: Iterable<import("node:child_process").ChildProcess>,
  graceMs?: number,
): Promise<void>;
