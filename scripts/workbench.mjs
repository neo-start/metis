// Local development entry point. Keep this fork's state separate from Synara.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const web = args.has("--web");
const dev = args.has("--dev");
const dryRun = args.has("--dry-run");
const stopBackground = args.has("--stop-background");
if ([...args].some((arg) => !["--web", "--dev", "--dry-run", "--stop-background"].includes(arg))) {
  throw new Error("Unknown Metis option.");
}
if (stopBackground && (web || dev))
  throw new Error("--stop-background cannot be combined with development modes.");
const environment = { ...process.env };
for (const key of [
  "SYNARA_DESKTOP_WS_URL",
  "SYNARA_AUTH_TOKEN",
  "SYNARA_PUBLIC_URL",
  "SYNARA_ALLOW_INSECURE_REMOTE",
  "VITE_WS_URL",
  "VITE_DEV_SERVER_URL",
]) {
  delete environment[key];
}
Object.assign(environment, {
  SYNARA_HOME: process.env.METIS_HOME?.trim()
    ? resolve(root, process.env.METIS_HOME.trim())
    : join(root, ".agent-workbench"),
  SYNARA_DESKTOP_FLAVOR: "development",
  SYNARA_HOST: "127.0.0.1",
  SYNARA_PORT: "4783",
  SYNARA_PORT_OFFSET: "110",
  SYNARA_DISABLE_AUTO_UPDATE: "1",
  SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
  SYNARA_NO_BROWSER: "1",
});
if (!dryRun) mkdirSync(environment.SYNARA_HOME, { recursive: true, mode: 0o700 });

const durable = !web && !dev && (process.platform === "darwin" || process.platform === "linux");
if (stopBackground || durable) {
  environment.METIS_HOME = environment.SYNARA_HOME;
  if (dryRun) {
    console.log(
      `Metis: ${stopBackground ? "stop authenticated background service" : "launch or attach authenticated durable background service, then desktop"}; home=${environment.SYNARA_HOME}; loopback port=${environment.METIS_PORT || "4785"}; no process started.`,
    );
    process.exit(0);
  }
  const preparation = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "exec",
      "--yes",
      "--package=bun@1.4.2",
      "--",
      "bun",
      "scripts/workbench-remote.ts",
      "--local",
      stopBackground ? "--stop" : "--background",
    ],
    { cwd: root, env: environment, stdio: "inherit" },
  );
  const code = await new Promise((resolvePreparation) => {
    preparation.once("error", (error) => {
      console.error(`Unable to prepare Metis background service: ${error.message}`);
      resolvePreparation(1);
    });
    preparation.once("exit", (exitCode) => resolvePreparation(exitCode ?? 1));
  });
  if (stopBackground || code !== 0) process.exit(code);
  // Fail closed if the service disappears between preparation and Electron boot.
  environment.METIS_REQUIRE_SHARED_SERVICE = "1";
} else if (!web && !dev && process.platform === "win32") {
  console.log(
    "Metis background lifecycle is not supported on Windows yet; this desktop owns and stops its backend on exit.",
  );
}

const script = web ? "dev" : dev ? "dev:desktop" : "start:desktop";
if (dryRun && script === "start:desktop") {
  console.log(
    `Metis: built desktop; home=${environment.SYNARA_HOME}; desktop-owned backend on this platform`,
  );
  process.exit(0);
}

const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  [
    "exec",
    "--yes",
    "--package=bun@1.4.2",
    "--",
    "bun",
    "run",
    script,
    ...(web || dev
      ? [
          "--home-dir",
          environment.SYNARA_HOME,
          "--port",
          "4783",
          "--host",
          "127.0.0.1",
          "--no-browser",
        ]
      : []),
    ...(dryRun ? ["--dry-run"] : []),
  ],
  { cwd: root, env: environment, stdio: "inherit" },
);

child.once("error", (error) => {
  console.error(`Unable to start Metis: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
