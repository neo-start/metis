import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import { readCodexAccountEmail } from "./codexAccountIdentity.ts";

const homes: string[] = [];
function codexHome(auth?: unknown): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "synara-codex-identity-"));
  homes.push(home);
  if (auth !== undefined) {
    writeFileSync(path.join(home, "auth.json"), JSON.stringify(auth), "utf8");
  }
  return home;
}
const idToken = (claims: object) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("readCodexAccountEmail", () => {
  it("reads the email claim of the ChatGPT id_token", async () => {
    const home = codexHome({ tokens: { id_token: idToken({ email: "two@example.com" }) } });
    assert.equal(await readCodexAccountEmail(home, {}), "two@example.com");
  });

  it("returns undefined without a ChatGPT login", async () => {
    assert.equal(await readCodexAccountEmail(codexHome(), {}), undefined);
    assert.equal(await readCodexAccountEmail(codexHome({ OPENAI_API_KEY: "x" }), {}), undefined);
    assert.equal(
      await readCodexAccountEmail(codexHome({ tokens: { id_token: "not-a-jwt" } }), {}),
      undefined,
    );
  });
});
