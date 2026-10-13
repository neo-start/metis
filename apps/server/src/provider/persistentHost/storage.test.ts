import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateDirectory, readPrivateFile, writePrivateFile } from "./storage.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "host capability storage",
  () => {
    it("rejects public or redirected capability paths without reading or changing their targets", () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "host-capability-test-"));
      directories.push(directory);
      privateDirectory(directory);
      const target = path.join(directory, "outside");
      writeFileSync(target, "unchanged", { mode: 0o600 });
      symlinkSync(target, path.join(directory, "token"));
      expect(() => readPrivateFile(path.join(directory, "token"))).toThrow();
      symlinkSync(target, path.join(directory, "journal.next"));
      expect(() => writePrivateFile(path.join(directory, "journal"), "overwrite")).toThrow();
      expect(readFileSync(target, "utf8")).toBe("unchanged");
      chmodSync(target, 0o644);
      expect(() => readPrivateFile(target)).toThrow("Unsafe");
      const publicDirectory = path.join(directory, "public");
      mkdirSync(publicDirectory, { mode: 0o755 });
      expect(() => privateDirectory(publicDirectory)).toThrow("owner-only");
    });
  },
);
