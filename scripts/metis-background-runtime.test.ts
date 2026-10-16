import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { resolveExecutable } from "@synara/shared/executable";
import { spawnProcess } from "@synara/shared/processRuntime";
import {
  acquireMetisBackgroundLock,
  ensureMetisBackground,
  prepareMetisBackgroundHome,
  requestMetisBackground,
  stopMetisOwnedChildren,
} from "./metis-background-runtime.mjs";

const homes: string[] = [];
const fixture = join(import.meta.dirname, "metis-background-fixture.mjs");
const runtime = resolveExecutable("bun")!;
function home() {
  const value = fs.mkdtempSync(join(tmpdir(), "mbg-"));
  fs.chmodSync(value, 0o700);
  homes.push(value);
  return value;
}
function options(value: string) {
  return {
    home: value,
    command: runtime,
    args: [fixture, value],
    cwd: import.meta.dirname,
    env: process.env,
    timeoutMs: 8000,
  };
}
afterEach(async () => {
  for (const value of homes.splice(0)) {
    await requestMetisBackground(value, "stop").catch(() => null);
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")(
  "Metis background lifecycle (isolated fake backend)",
  () => {
    it("survives launcher exit, attaches without duplicates, then drains on authenticated stop", async () => {
      const value = home();
      const client = spawnProcess(runtime, [fixture, value, "--client"], { stdio: "pipe" });
      let output = "";
      let errors = "";
      client.stdout.on("data", (chunk) => {
        output += chunk;
      });
      client.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const exit = await new Promise((resolveExit) => client.once("exit", resolveExit));
      expect(exit, errors).toBe(0);
      const service = JSON.parse(output) as { launcherPid: number; serverPid: number };
      expect(process.kill(service.launcherPid, 0)).toBe(true);
      expect(process.kill(service.serverPid, 0)).toBe(true);
      expect((await ensureMetisBackground(options(value))).launcherPid).toBe(service.launcherPid);
      expect(fs.readFileSync(join(value, "starts"), "utf8")).toBe("start\n");
      expect(await requestMetisBackground(value, "stop")).toEqual({ ready: false, stopped: true });
      expect(fs.readFileSync(join(value, "drained"), "utf8")).toBe("drained");
      expect(() => process.kill(service.serverPid, 0)).toThrow();
      expect(await requestMetisBackground(value, "status")).toBeNull();
    }, 15_000);

    it("serializes simultaneous starts and recovers a proven-dead launcher admission owner", async () => {
      const value = home();
      const dead = spawnProcess(runtime, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await new Promise((resolveExit) => dead.once("exit", resolveExit));
      const lock = join(value, "metis-background.lifecycle-lock");
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: dead.pid, token: randomUUID(), createdAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      const [first, second] = await Promise.all([
        ensureMetisBackground(options(value)),
        ensureMetisBackground(options(value)),
      ]);
      expect(first.launcherPid).toBe(second.launcherPid);
      expect(fs.readFileSync(join(value, "starts"), "utf8")).toBe("start\n");
    }, 15_000);

    it("refuses unauthenticated stop and never signals PIDs copied into stale state", async () => {
      const value = home();
      await ensureMetisBackground(options(value));
      const control = JSON.parse(fs.readFileSync(join(value, "metis-background.json"), "utf8")) as {
        socket: string;
      };
      const statusCode = await new Promise((resolveResponse, reject) => {
        const req = request(
          { socketPath: control.socket, method: "POST", path: "/stop" },
          (response) => {
            response.resume();
            response.once("end", () => resolveResponse(response.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(statusCode).toBe(403);
      expect(await requestMetisBackground(value, "status")).toEqual({
        ready: true,
        stopped: false,
      });
      await requestMetisBackground(value, "stop");
      fs.writeFileSync(
        join(value, "metis-service.json"),
        JSON.stringify({ launcherPid: process.pid, serverPid: process.pid }),
        { mode: 0o600 },
      );
      expect(await requestMetisBackground(value, "stop")).toBeNull();
      expect(process.kill(process.pid, 0)).toBe(true);
    }, 15_000);

    it("fails closed for private-file violations and live admission owners", async () => {
      const value = home();
      fs.chmodSync(value, 0o755);
      expect(() => prepareMetisBackgroundHome(value)).toThrow(/private/);
      fs.chmodSync(value, 0o700);
      const release = await acquireMetisBackgroundLock(value);
      await expect(acquireMetisBackgroundLock(value)).rejects.toThrow(/live/);
      await release();
      const external = join(value, "outside");
      fs.writeFileSync(external, "untouched");
      fs.symlinkSync(external, join(value, "metis-background.json"));
      await expect(requestMetisBackground(value, "stop")).rejects.toThrow(/private/);
      expect(fs.readFileSync(external, "utf8")).toBe("untouched");
      fs.rmSync(join(value, "metis-background.json"));
    });

    it("retains a directly owned child when graceful shutdown times out", async () => {
      const child = spawnProcess(
        runtime,
        [
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        { stdio: "pipe" },
      );
      await new Promise((resolveReady) => child.stdout.once("data", resolveReady));
      try {
        await expect(stopMetisOwnedChildren([child], 50)).rejects.toThrow(/ownership retained/);
        expect(child.signalCode).toBeNull();
        expect(process.kill(child.pid!, 0)).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await new Promise((resolveExit) => child.once("exit", resolveExit));
      }
    });
  },
);
