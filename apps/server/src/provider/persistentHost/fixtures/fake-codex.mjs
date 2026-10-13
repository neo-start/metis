#!/usr/bin/env node
// Real stdio process; never imports a model SDK or opens a network connection.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  if (process.env.METIS_FAKE_VERSION_DELAY)
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.METIS_FAKE_VERSION_DELAY)),
    );
  console.log("codex-cli 0.155.0");
  process.exit(0);
}
const directory = process.env.METIS_FAKE_PROTOCOL_DIRECTORY;
writeFileSync(`${directory}/provider.pid`, String(process.pid));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turn = 0;
let streaming;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(`${directory}/protocol.ndjson`, `${line}\n`);
  const { id, method } = message;
  if (method === "initialize") send({ id, result: { userAgent: "fake-codex" } });
  else if (method === "account/read")
    send({ id, result: { account: { type: "chatgpt", planType: "plus" } } });
  else if (method === "thread/start")
    send({ id, result: { thread: { id: "native-thread", turns: [] } } });
  else if (method === "turn/start") {
    turn++;
    const turnId = `native-turn-${turn}`;
    const notify = (method, params) =>
      send({ method, params: { threadId: "native-thread", turnId, ...params } });
    // Delay the acceptance response so a replacement controller adopts a pending RPC.
    setTimeout(() => send({ id, result: { turn: { id: turnId } } }), 180);
    setTimeout(() => notify("turn/started", { turn: { id: turnId } }), 200);
    setTimeout(
      () => notify("item/agentMessage/delta", { itemId: "message", delta: "before detach" }),
      220,
    );
    if (message.params.input[0]?.text === "overflow") {
      streaming = setInterval(
        () =>
          notify("item/agentMessage/delta", { itemId: "message", delta: "x".repeat(16 * 1024) }),
        25,
      );
    } else if (message.params.input[0]?.text !== "idle") {
      setTimeout(
        () =>
          send({
            id: "approve",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "native-thread",
              turnId,
              itemId: "tool",
              command: "fake safe command",
            },
          }),
        250,
      );
    }
  } else if (id === "approve" && !method) {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "native-thread",
        turnId: `native-turn-${turn}`,
        itemId: "message",
        delta: "after approval",
      },
    });
    send({
      id: "input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-thread",
        turnId: `native-turn-${turn}`,
        itemId: "input-tool",
        questions: [
          {
            id: "q",
            header: "Choice",
            question: "Continue?",
            options: [{ label: "yes", description: "Continue the fake turn" }],
          },
        ],
      },
    });
  } else if (id === "input" && !method) {
    send({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: `native-turn-${turn}`, status: "completed" },
      },
    });
  } else if (method === "turn/interrupt") {
    clearInterval(streaming);
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: `native-turn-${turn}`, status: "interrupted" },
      },
    });
  } else if (method === "thread/read") {
    send({
      id,
      result: {
        thread: {
          id: "native-thread",
          turns: [{ id: `native-turn-${turn}`, items: [], status: "inProgress" }],
        },
      },
    });
  } else if (id !== undefined) send({ id, result: {} });
});
