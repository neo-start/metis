/** Persistent host platform policy. Windows ACL/service lifetime is deliberately unsupported. */
import { spawnProcess } from "@synara/shared/processRuntime";
import type { ChildProcess } from "node:child_process";

export function assertPersistentHostPlatform(platform = process.platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      "Persistent provider hosts currently require macOS or Linux; use the ordinary provider lifecycle on this platform",
    );
  }
}

export function spawnPersistentHost(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ChildProcess> {
  assertPersistentHostPlatform();
  return new Promise((resolve, reject) => {
    const child = spawnProcess(input.executable, input.args, {
      ownProcessGroup: true,
      stdio: "ignore",
      ...(input.env ? { env: input.env } : {}),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child);
    });
  });
}
