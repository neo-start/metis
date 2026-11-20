import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadMetisHostCapability } from "./metis-host-capability";

it.skipIf(process.platform === "win32")(
  "reuses the private key across launches and isolates homes",
  () => {
    const home = mkdtempSync(join(tmpdir(), "metis-key-"));
    try {
      const key = loadMetisHostCapability(home);
      expect(loadMetisHostCapability(home) === key).toBe(true);
      expect(statSync(join(home, "desktop-host.key")).mode & 0o777).toBe(0o600);
      const other = join(home, "other");
      mkdirSync(other, { mode: 0o700 });
      expect(loadMetisHostCapability(other) === key).toBe(false);
      chmodSync(join(home, "desktop-host.key"), 0o644);
      expect(() => loadMetisHostCapability(home)).toThrow(/private/);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  },
);

it.skipIf(process.platform === "win32")("rejects damaged keys and symbolic links", () => {
  const home = mkdtempSync(join(tmpdir(), "metis-key-"));
  const file = join(home, "desktop-host.key");
  try {
    writeFileSync(file, "invalid", { mode: 0o600 });
    expect(() => loadMetisHostCapability(home)).toThrow(/Invalid/);
    expect(readFileSync(file, "utf8")).toBe("invalid");
    rmSync(file);
    symlinkSync(join(home, "missing"), file);
    expect(() => loadMetisHostCapability(home)).toThrow();
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
