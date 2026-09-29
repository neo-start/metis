import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMetisSharedNavigationAllowed,
  readMetisDesktopHostBridge,
  readMetisOwnerPairingUrl,
  readMetisSharedService,
} from "./metisSharedService";

describe.skipIf(process.platform === "win32")("Metis shared desktop attachment", () => {
  let home: string;
  const origin = "https://metis.example.com";
  const writeState = (patch: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(home, "metis-service.json"),
      JSON.stringify({
        launcherPid: process.pid,
        serverPid: process.pid,
        home,
        localOrigin: "http://127.0.0.1:4785",
        publicOrigin: origin,
        ...patch,
      }),
      { mode: 0o600 },
    );
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "metis-attach-"));
    fs.chmodSync(home, 0o700);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("attaches only to a live service in the same workspace", () => {
    expect(readMetisSharedService(home)).toBeNull();
    writeState();
    expect(readMetisSharedService(home)?.origin).toBe(origin);
    writeState({ home: path.join(home, "another-workspace") });
    expect(() => readMetisSharedService(home)).toThrow(/workspace/);
  });

  it("ignores a stale service without deleting its state", () => {
    writeState();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not running"), { code: "ESRCH" });
    });
    expect(readMetisSharedService(home)).toBeNull();
    expect(fs.existsSync(path.join(home, "metis-service.json"))).toBe(true);
  });

  it.each([
    { localOrigin: "http://192.0.2.1:4785" },
    { localOrigin: "http://127.0.0.1:4785/other" },
    { publicOrigin: "http://metis.example.com" },
    { publicOrigin: "https://user:secret@metis.example.com" },
    { publicOrigin: "https://metis.example.com/path" },
    { publicOrigin: 123 },
    { serverPid: -1 },
  ])("rejects unsafe service configuration %j", (patch) => {
    writeState(patch);
    expect(() => readMetisSharedService(home)).toThrow();
  });

  it("supports the local shared service without a public origin", () => {
    writeState({ publicOrigin: null });
    expect(readMetisSharedService(home)?.origin).toBe("http://127.0.0.1:4785");
  });

  it("does not fall back to database ownership while one service process is alive", () => {
    writeState({ serverPid: process.pid + 1 });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === process.pid) return true;
      throw Object.assign(new Error("not running"), { code: "ESRCH" });
    });
    expect(() => readMetisSharedService(home)).toThrow(/starting or stopping/);
  });

  it("rejects readable-by-others files and symlinks", () => {
    writeState();
    const file = path.join(home, "metis-service.json");
    fs.chmodSync(file, 0o644);
    expect(() => readMetisSharedService(home)).toThrow(/private/);
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, `${file}.real`);
    fs.symlinkSync(`${file}.real`, file);
    expect(() => readMetisSharedService(home)).toThrow(/private/);
  });

  it("rejects a shared home accessible by other users", () => {
    writeState();
    fs.chmodSync(home, 0o755);
    expect(() => readMetisSharedService(home)).toThrow(/private/);
  });

  it("accepts only fresh pairing credentials for the selected origin", () => {
    const file = path.join(home, "owner-pairing-url.txt");
    const pair = `${origin}/pair#token=ABC123`;
    fs.writeFileSync(file, pair, { mode: 0o600 });
    expect(readMetisOwnerPairingUrl(home, origin)).toBe(pair);
    expect(readMetisOwnerPairingUrl(home, "https://another.example.com")).toBeNull();
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(readMetisOwnerPairingUrl(home, origin)).toBeNull();
  });

  it.each([
    `${origin}/pair?token=ABC123`,
    `${origin}/other#token=ABC123`,
    `${origin}/pair#token=ABC123&redirect=https://evil.example.com`,
    "https://user:pass@metis.example.com/pair#token=ABC123",
  ])("does not load malformed pairing URLs", (url) => {
    fs.writeFileSync(path.join(home, "owner-pairing-url.txt"), url, { mode: 0o600 });
    expect(readMetisOwnerPairingUrl(home, origin)).toBeNull();
  });

  it("keeps the privileged window on the configured origin", () => {
    expect(isMetisSharedNavigationAllowed(origin, `${origin}/workbench`)).toBe(true);
    for (const target of [
      "https://metis.example.com.evil.test/",
      "http://metis.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:password@metis.example.com/",
    ])
      expect(isMetisSharedNavigationAllowed(origin, target)).toBe(false);
  });

  describe("desktop host bridge", () => {
    const capability = "c".repeat(43);
    const writeBridge = (patch: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.join(home, "run"), { mode: 0o700 });
      fs.writeFileSync(
        path.join(home, "desktop-host.json"),
        JSON.stringify({
          launcherPid: 1234,
          browserHostPipePath: path.join(home, "run", "browser-host.sock"),
          cuaHostSocket: path.join(home, "run", "cua-host.sock"),
          capability,
          ...patch,
        }),
        { mode: 0o600 },
      );
    };

    it("reads the launcher's private sockets and capability", () => {
      expect(readMetisDesktopHostBridge(home, { launcherPid: 1234 })).toBeNull();
      writeBridge();
      expect(readMetisDesktopHostBridge(home, { launcherPid: 1234 })).toEqual({
        browserHostPipePath: path.join(home, "run", "browser-host.sock"),
        cuaHostSocket: path.join(home, "run", "cua-host.sock"),
        capability,
      });
    });

    it.each([
      { launcherPid: 999 },
      { browserHostPipePath: "/tmp/elsewhere.sock" },
      { cuaHostSocket: "/tmp/elsewhere.sock" },
      { capability: "short" },
      { capability: 42 },
    ])("rejects state that does not belong to this service: %o", (patch) => {
      writeBridge(patch);
      expect(() => readMetisDesktopHostBridge(home, { launcherPid: 1234 })).toThrow(
        /does not match/,
      );
    });

    it("rejects a socket directory other users can reach", () => {
      writeBridge();
      fs.chmodSync(path.join(home, "run"), 0o755);
      expect(() => readMetisDesktopHostBridge(home, { launcherPid: 1234 })).toThrow(/private/);
    });
  });
});
