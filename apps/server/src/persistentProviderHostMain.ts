/** Dedicated host executable. Never run the application's HTTP server in this process. */
import { runPersistentCodexHost } from "./provider/persistentHost/server.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: persistentProviderHostMain <private-host-directory>");
try {
  const host = await runPersistentCodexHost(directory);
  await host.closed;
} catch {
  // Credentials and provider input must never enter detached launch diagnostics.
  process.stderr.write("Persistent provider host failed; inspect its private state directory.\n");
  process.exitCode = 1;
}
