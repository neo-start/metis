import { readFileSync } from "node:fs";
import { PersistentCodexHostClient } from "../client.ts";
const [directory, inputFile] = process.argv.slice(2);
const client = await PersistentCodexHostClient.connect(directory!);
const input = JSON.parse(readFileSync(inputFile!, "utf8"));
await client.call("startSession", [input], "controller-session");
void client
  .call(
    "sendTurn",
    [{ threadId: input.threadId, input: "controller process turn" }],
    "controller-turn",
  )
  .catch(() => undefined);
// Simulate backend death, not a polite host detach or a protocol interrupt.
setTimeout(() => process.exit(0), 70);
