import { randomBytes } from "node:crypto";
import { linkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrivateFile } from "@synara/shared/privateServiceFile";

const filename = "desktop-host.key";

/** Install one private key per Metis home, publishing only a complete file. */
export function loadMetisHostCapability(home: string): string {
  const existing = readPrivateFile(home, filename);
  if (existing) return validate(existing.text);

  const key = randomBytes(32).toString("base64url");
  const temporary = join(home, `${filename}.${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(temporary, key, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporary, join(home, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return validate(readPrivateFile(home, filename)?.text);
  } finally {
    rmSync(temporary);
  }
}

function validate(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value) || value.length !== 43)
    throw new Error("Invalid Metis desktop host key.");
  return value;
}
