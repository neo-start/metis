import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  expandCodexHomePath,
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveSynaraCodexHomeOverlayPath,
} from "./codexHomePaths.ts";

describe("Codex home paths", () => {
  it("resolves the source home using explicit, environment, then default precedence", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
    assert.ok(resolveBaseCodexHomePath({}).endsWith(`${path.sep}.codex`));
  });

  it("anchors the overlay under SYNARA_HOME", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath(
        { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" },
        "/users/me/.codex",
      ),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay beside the source home", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath({ CODEX_HOME: "/users/me/.codex" }, "/users/me/.codex"),
      path.join("/users/me", ".synara", "runtime", "codex-home-overlay"),
    );
  });

  it("uses the isolated overlay as Codex's write home", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" },
        homePath: "/users/me/.codex",
      }),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("allowlists source and overlay homes when distinct", () => {
    assert.deepEqual(
      resolveCodexHomeAllowlistCandidates({
        env: { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" },
        homePath: "/users/me/.codex",
      }),
      ["/users/me/.codex", path.join("/synara/runtime", "codex-home-overlay")],
    );
  });

  it("gives each non-default source home its own overlay so accounts never share auth", () => {
    const env = { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" };
    const primary = resolveSynaraCodexHomeOverlayPath(env, "/users/me/.codex");
    const secondary = resolveSynaraCodexHomeOverlayPath(env, "/users/me/.codex-secondary");
    const other = resolveSynaraCodexHomeOverlayPath(env, "/users/me/.codex-other");
    assert.equal(primary, path.join("/synara/runtime", "codex-home-overlay"));
    assert.match(path.basename(secondary), /^codex-home-overlay-[0-9a-f]{12}$/);
    assert.notEqual(secondary, primary);
    assert.notEqual(secondary, other);
    assert.equal(resolveSynaraCodexHomeOverlayPath(env, "/users/me/.codex-secondary"), secondary);
  });

  it("expands a leading tilde in configured homes", () => {
    assert.equal(
      resolveBaseCodexHomePath({}, "~/.codex-secondary"),
      path.join(homedir(), ".codex-secondary"),
    );
    assert.equal(expandCodexHomePath("/abs/.codex"), "/abs/.codex");
  });
});
