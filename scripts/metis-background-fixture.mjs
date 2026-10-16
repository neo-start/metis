// Isolated lifecycle fixture: never loads the real backend, database or providers.
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveExecutable } from "@synara/shared/executable";
import { createServer } from "node:http";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  acquireMetisBackgroundLock,
  ensureMetisBackground,
  startMetisBackgroundControl,
  stopMetisOwnedChildren,
} from "./metis-background-runtime.mjs";

const home = process.argv[2];
if (process.argv.includes("--client")) {
  const result = await ensureMetisBackground({
    home,
    command: process.execPath,
    args: [import.meta.filename, home],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 8000,
  });
  console.log(JSON.stringify(result));
} else {
  const release = await acquireMetisBackgroundLock(home);
  fs.appendFileSync(join(home, "starts"), "start\n");
  const child = spawnProcess(
    resolveExecutable("node"),
    [
      "-e",
      `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'drained'); process.exit(0); });
    setInterval(() => {}, 1000);
    console.log('ready');
  `,
      join(home, "drained"),
    ],
    { stdio: "pipe" },
  );
  await new Promise((resolveReady) => child.stdout.once("data", resolveReady));
  const health = createServer((_request, response) => response.end('{"startupReady":true}'));
  await new Promise((resolveListen) => health.listen(0, "127.0.0.1", resolveListen));
  let ready = false;
  let stopping;
  let closeControl;
  const stop = () =>
    (stopping ??= (async () => {
      ready = false;
      await stopMetisOwnedChildren([child], 1000);
      health.close();
      closeControl();
      fs.rmSync(join(home, "metis-service.json"), { force: true });
      await release();
    })());
  closeControl = await startMetisBackgroundControl(home, () => ready, stop);
  const localOrigin = `http://127.0.0.1:${health.address().port}`;
  fs.writeFileSync(
    join(home, "metis-service.json"),
    JSON.stringify({
      home,
      launcherPid: process.pid,
      serverPid: child.pid,
      localOrigin,
    }),
    { mode: 0o600 },
  );
  ready = true;
  process.on("SIGTERM", () => {
    void stop();
  });
}
