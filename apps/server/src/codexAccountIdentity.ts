// FILE: codexAccountIdentity.ts
// Purpose: Reads the non-secret account email of a Codex home for display, so two
//          Codex accounts can be told apart in the UI.
// Layer: Server utility

import fs from "node:fs/promises";
import path from "node:path";

import { resolveBaseCodexHomePath } from "./codexHomePaths.ts";

/**
 * Returns the `email` claim of the ChatGPT id_token stored in `<CODEX_HOME>/auth.json`,
 * or undefined when the home has no ChatGPT login. The token is only decoded for display,
 * never verified or returned.
 */
export async function readCodexAccountEmail(
  homePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const authPath = path.join(resolveBaseCodexHomePath(env, homePath), "auth.json");
    const record = JSON.parse(await fs.readFile(authPath, "utf8")) as {
      tokens?: { id_token?: unknown };
    };
    const idToken = record.tokens?.id_token;
    if (typeof idToken !== "string") return undefined;
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof claims.email === "string" && claims.email.trim()
      ? claims.email.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
