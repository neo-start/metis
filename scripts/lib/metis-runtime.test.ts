import { describe, expect, it } from "vitest";
import {
  findMetisPairingUrl,
  metisDesktopHostBridge,
  metisRuntimeConfiguration,
  metisServerEnvironment,
} from "./metis-runtime";

describe("Metis shared service", () => {
  it("uses the existing desktop home for local and remote modes", () => {
    const local = metisRuntimeConfiguration("/workspace", ["--local"], {});
    const remote = metisRuntimeConfiguration("/workspace", [], {
      METIS_PUBLIC_URL: "https://metis.example.test",
      METIS_TUNNEL_TOKEN: "test-tunnel",
    });
    expect(local.home).toBe(remote.home);
    expect(local.home).toBe("/workspace/.agent-workbench");
    expect(local.origin).toBeNull();
  });

  it("keeps the previous isolated profile accessible explicitly", () => {
    const config = metisRuntimeConfiguration("/workspace", ["--local", "--isolated"], {});
    expect(config.home).toBe("/workspace/.agent-workbench-remote");
    expect(() =>
      metisRuntimeConfiguration("/workspace", ["--local", "--isolated"], {
        METIS_HOME: "/other",
      }),
    ).toThrow();
  });

  it.each(["0", "-1", "80", "65536", "NaN", "4785.5", "4e3"])("rejects invalid port %s", (port) => {
    expect(() =>
      metisRuntimeConfiguration("/workspace", ["--local"], { METIS_PORT: port }),
    ).toThrow();
  });

  it("supports isolated temporary state and strict HTTPS remote origins", () => {
    const config = metisRuntimeConfiguration("/workspace", ["--local", "--dry-run"], {
      METIS_HOME: "scratch",
      METIS_PORT: "54785",
      METIS_PUBLIC_URL: "https://ignored.example.test",
      METIS_TUNNEL_TOKEN: "ignored",
    });
    expect(config.home).toBe("/workspace/scratch");
    expect(config.port).toBe(54785);
    expect(config.dryRun).toBe(true);
    expect(config.origin).toBeNull();
    expect(config.tunnelToken).toBeUndefined();
    expect(() =>
      metisRuntimeConfiguration("/workspace", [], {
        METIS_PUBLIC_URL: "http://insecure.example.test",
        METIS_TUNNEL_TOKEN: "test",
      }),
    ).toThrow();
    expect(() => metisRuntimeConfiguration("/workspace", ["--unknown"], {})).toThrow();
  });

  it("strips tunnel credentials and inherited desktop/dev access settings from server children", () => {
    const config = metisRuntimeConfiguration("/workspace", ["--local"], {});
    const env = metisServerEnvironment(
      {
        PATH: "/bin",
        METIS_TUNNEL_TOKEN: "private",
        WORKBENCH_TUNNEL_TOKEN: "old-private",
        TUNNEL_TOKEN: "inherited",
        SYNARA_AUTH_TOKEN: "wrong",
        SYNARA_PUBLIC_URL: "https://wrong.test",
        SYNARA_DESKTOP_SHUTDOWN_TOKEN: "desktop",
        SYNARA_BROWSER_HOST_CAPABILITY_FD: "3",
        SYNARA_ALLOW_INSECURE_REMOTE: "1",
        VITE_DEV_SERVER_URL: "http://localhost:1234",
      },
      config,
      "/workspace",
      "new-server-secret",
    );
    expect(env.PATH).toBe("/bin");
    expect(env.SYNARA_MODE).toBe("web");
    expect(env.SYNARA_HOST).toBe("127.0.0.1");
    expect(env.SYNARA_AUTH_TOKEN).toBe("new-server-secret");
    for (const key of [
      "METIS_TUNNEL_TOKEN",
      "WORKBENCH_TUNNEL_TOKEN",
      "TUNNEL_TOKEN",
      "SYNARA_PUBLIC_URL",
      "SYNARA_DESKTOP_SHUTDOWN_TOKEN",
      "SYNARA_BROWSER_HOST_CAPABILITY_FD",
      "SYNARA_ALLOW_INSECURE_REMOTE",
      "VITE_DEV_SERVER_URL",
    ])
      expect(env[key]).toBeUndefined();
  });

  it("captures only the expected local or remote pairing origin", () => {
    const url = "http://127.0.0.1:4785/pair#token=ABC234";
    expect(findMetisPairingUrl(`pairingUrl: "${url}"`, "http://127.0.0.1:4785")).toBe(url);
    expect(
      findMetisPairingUrl("https://evil.test/pair#token=ABC234", "https://metis.example.test"),
    ).toBeUndefined();
    expect(
      findMetisPairingUrl(
        "https://metis.example.test/pair#token=ABC234",
        "https://metis.example.test",
      ),
    ).toBe("https://metis.example.test/pair#token=ABC234");
  });

  it("hands the desktop host sockets to the server without the capability", () => {
    const config = metisRuntimeConfiguration("/workspace", ["--local"], {});
    const bridge = metisDesktopHostBridge(config.home, "darwin");
    expect(bridge).toEqual({
      directory: "/workspace/.agent-workbench/run",
      browserHostPipePath: "/workspace/.agent-workbench/run/browser-host.sock",
      cuaHostSocket: "/workspace/.agent-workbench/run/cua-host.sock",
    });
    const env = metisServerEnvironment(
      { PATH: "/bin", SYNARA_BROWSER_HOST_CAPABILITY: "inherited-capability-that-must-not-leak" },
      config,
      "/workspace",
      "server-auth",
      bridge,
    );
    expect(env.SYNARA_BROWSER_HOST_PIPE_PATH).toBe(bridge?.browserHostPipePath);
    expect(env.SYNARA_CUA_HOST_SOCKET).toBe(bridge?.cuaHostSocket);
    expect(env.SYNARA_BROWSER_HOST_CAPABILITY_FD).toBe("3");
    expect(env.SYNARA_BROWSER_HOST_CAPABILITY).toBeUndefined();
    expect(
      metisServerEnvironment(
        { SYNARA_CUA_HOST_SOCKET: "/inherited.sock" },
        config,
        "/workspace",
        "server-auth",
      ).SYNARA_CUA_HOST_SOCKET,
    ).toBeUndefined();
  });

  it("offers no bridge where sockets cannot be addressed", () => {
    expect(metisDesktopHostBridge("/workspace/.agent-workbench", "win32")).toBeNull();
    expect(metisDesktopHostBridge(`/${"a".repeat(90)}`, "darwin")).toBeNull();
  });
});
