import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  METIS_MEMORY_BODY_MAX_BYTES,
  METIS_MEMORY_SCOPE_MAX_ENTRIES,
  METIS_MEMORY_SOUL_MAX_BYTES,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  containsCredentialLikeText,
  deleteMetisMemoryFile,
  isValidMetisMemoryName,
  listMetisMemoryProjectDirectoriesSync,
  metisMemoryFilePath,
  metisMemoryProjectKey,
  parseMetisMemoryFile,
  readMetisMemoryDocumentSync,
  readMetisMemorySoulSync,
  resolveMetisMemoryScope,
  scanMetisMemoryDirectorySync,
  serializeMetisMemoryFile,
  writeMetisMemoryFile,
  writeMetisMemorySoul,
} from "./memoryFiles.ts";
import { MetisMemoryError } from "./Services/MetisMemory.ts";

const roots: string[] = [];

function makeRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "metis-memory-files-"));
  fs.chmodSync(base, 0o700);
  roots.push(base);
  return path.join(base, "memory");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const baseWrite = (rootDir: string) => ({
  rootDir,
  scope: "global" as const,
  projectId: null,
  name: "prefers-bun",
  description: "User runs scripts with bun run",
  type: "feedback" as const,
  body: "Use `bun run test`, never `bun test`.",
  rejectCredentials: true,
});

function failureOf<A>(effect: Effect.Effect<A, MetisMemoryError>) {
  return Effect.runPromise(Effect.flip(effect));
}

describe("metis memory names and paths", () => {
  it("accepts slugs and rejects traversal, separators, and odd characters", () => {
    for (const name of ["a", "prefers-bun", "user_role", "x1", "a".repeat(64)]) {
      expect(isValidMetisMemoryName(name), name).toBe(true);
    }
    for (const name of [
      "",
      "../etc",
      "..",
      ".",
      "a/b",
      "a\\b",
      "Upper",
      "-lead",
      "has space",
      "dot.md",
      "a".repeat(65),
    ]) {
      expect(isValidMetisMemoryName(name), name).toBe(false);
      expect(() => metisMemoryFilePath("/tmp/memory/global", name)).toThrow(MetisMemoryError);
    }
  });

  it("keeps ordinary project ids readable and hashes anything path-like", () => {
    expect(metisMemoryProjectKey("0f5c2b7e-1d2a-4c6b-9a8e-6f1f0d2c3b4a")).toBe(
      "0f5c2b7e-1d2a-4c6b-9a8e-6f1f0d2c3b4a",
    );
    for (const hostile of ["../../etc", "a/b", "..", "project.with.dots", "x".repeat(200)]) {
      const key = metisMemoryProjectKey(hostile);
      expect(key).toMatch(/^p-[0-9a-f]{32}$/);
    }
    const root = "/tmp/memory";
    const resolved = resolveMetisMemoryScope(root, "project", "../../etc");
    expect(path.dirname(resolved.directory)).toBe(path.join(root, "projects"));
    expect(() => resolveMetisMemoryScope(root, "project", "  ")).toThrow(MetisMemoryError);
  });
});

describe("metis memory frontmatter", () => {
  it("round-trips serialized memories and tolerates hand-written files", () => {
    const text = serializeMetisMemoryFile({
      name: "deploy-notes",
      description: 'Deploys use "make ship"\nnot npm',
      type: "project",
      updatedAt: "2026-09-28T10:00:00.000Z",
      projectId: "project-1",
      projectTitle: "Metis",
      body: "Run `make ship`.",
    });
    const parsed = parseMetisMemoryFile(text);
    expect(parsed.frontmatter).toEqual({
      name: "deploy-notes",
      description: 'Deploys use "make ship" not npm',
      type: "project",
      updatedAt: "2026-09-28T10:00:00.000Z",
      projectId: "project-1",
      projectTitle: "Metis",
    });
    expect(parsed.body).toBe("Run `make ship`.\n");

    const handWritten = parseMetisMemoryFile(
      "---\r\ndescription: 'It''s plain'\r\ntype: user\r\n---\r\nBody line\r\n",
    );
    expect(handWritten.frontmatter.description).toBe("It's plain");
    expect(handWritten.body).toBe("Body line\n");
    expect(parseMetisMemoryFile("# No frontmatter\ntext").frontmatter).toEqual({});
  });
});

describe.skipIf(process.platform === "win32")("metis memory file store", () => {
  it("writes, lists, reads, and deletes global and project memories privately", async () => {
    const rootDir = makeRoot();
    const entry = await Effect.runPromise(
      writeMetisMemoryFile({ ...baseWrite(rootDir), now: () => new Date("2026-09-01T00:00:00Z") }),
    );
    expect(entry).toMatchObject({
      scope: "global",
      projectId: null,
      name: "prefers-bun",
      description: "User runs scripts with bun run",
      type: "feedback",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(fs.statSync(entry.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(rootDir, "global")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(rootDir).mode & 0o777).toBe(0o700);

    const project = await Effect.runPromise(
      writeMetisMemoryFile({
        ...baseWrite(rootDir),
        scope: "project",
        projectId: "project-1",
        projectTitle: "Workbench",
        name: "release-flow",
        description: "Release goes through canary first",
        type: "project",
      }),
    );
    expect(project.projectId).toBe("project-1");
    expect(path.dirname(project.path)).toBe(path.join(rootDir, "projects", "project-1"));

    const global = scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, "global", null));
    expect(global.map((item) => item.name)).toEqual(["prefers-bun"]);
    const document = readMetisMemoryDocumentSync({
      ...resolveMetisMemoryScope(rootDir, "project", "project-1"),
      name: "release-flow",
    });
    expect(document?.body).toContain("bun run test");
    expect(listMetisMemoryProjectDirectoriesSync(rootDir)).toEqual([
      {
        projectKey: "project-1",
        directory: path.join(rootDir, "projects", "project-1"),
        projectId: "project-1",
        projectTitle: "Workbench",
      },
    ]);

    // Replacing keeps a single file and picks up the new content despite caching.
    await Effect.runPromise(
      writeMetisMemoryFile({ ...baseWrite(rootDir), description: "Updated summary" }),
    );
    const replaced = scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, "global", null));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.description).toBe("Updated summary");

    expect(
      await Effect.runPromise(
        deleteMetisMemoryFile({ rootDir, scope: "global", projectId: null, name: "prefers-bun" }),
      ),
    ).toEqual({ deleted: true });
    expect(
      await Effect.runPromise(
        deleteMetisMemoryFile({ rootDir, scope: "global", projectId: null, name: "prefers-bun" }),
      ),
    ).toEqual({ deleted: false });
    expect(scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, "global", null))).toEqual(
      [],
    );
  });

  it("reflects hand edits and skips symlinks and invalid file names", () => {
    const rootDir = makeRoot();
    const globalDir = path.join(rootDir, "global");
    fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(globalDir, "manual.md"), "# Prefers dark mode\nDetails.\n");
    fs.writeFileSync(path.join(globalDir, "Bad Name.md"), "ignored");
    const outside = path.join(path.dirname(rootDir), "outside.md");
    fs.writeFileSync(outside, "secret outside the tree");
    fs.symlinkSync(outside, path.join(globalDir, "linked.md"));

    const first = scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, "global", null));
    expect(first.map((entry) => [entry.name, entry.description, entry.type])).toEqual([
      ["manual", "Prefers dark mode", "reference"],
    ]);
    expect(
      readMetisMemoryDocumentSync({
        ...resolveMetisMemoryScope(rootDir, "global", null),
        name: "linked",
      }),
    ).toBeNull();

    fs.writeFileSync(
      path.join(globalDir, "manual.md"),
      "---\ndescription: Edited by hand, now longer\ntype: user\n---\nNew body\n",
    );
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(globalDir, "manual.md"), future, future);
    const second = scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, "global", null));
    expect(second[0]).toMatchObject({ description: "Edited by hand, now longer", type: "user" });
  });

  it("rejects invalid input, oversize bodies, credentials, and full scopes", async () => {
    const rootDir = makeRoot();
    expect(
      (await failureOf(writeMetisMemoryFile({ ...baseWrite(rootDir), name: "../escape" }))).code,
    ).toBe("invalid-input");
    expect(
      (await failureOf(writeMetisMemoryFile({ ...baseWrite(rootDir), description: "  " }))).code,
    ).toBe("invalid-input");
    expect(
      (
        await failureOf(
          writeMetisMemoryFile({
            ...baseWrite(rootDir),
            body: "x".repeat(METIS_MEMORY_BODY_MAX_BYTES + 1),
          }),
        )
      ).code,
    ).toBe("limit-exceeded");
    expect(
      (
        await failureOf(
          writeMetisMemoryFile({
            ...baseWrite(rootDir),
            body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          }),
        )
      ).code,
    ).toBe("invalid-input");
    // User-authored writes are trusted as written.
    await Effect.runPromise(
      writeMetisMemoryFile({
        ...baseWrite(rootDir),
        name: "user-note",
        body: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        rejectCredentials: false,
      }),
    );
    expect(
      (
        await failureOf(
          writeMetisMemoryFile({ ...baseWrite(rootDir), scope: "project", projectId: null }),
        )
      ).code,
    ).toBe("invalid-input");

    const globalDir = path.join(rootDir, "global");
    for (let index = 0; index < METIS_MEMORY_SCOPE_MAX_ENTRIES; index += 1) {
      fs.writeFileSync(path.join(globalDir, `filler-${index}.md`), "x");
    }
    expect(
      (await failureOf(writeMetisMemoryFile({ ...baseWrite(rootDir), name: "one-more" }))).code,
    ).toBe("limit-exceeded");
  });

  it("stores soul.md privately and caps its size", async () => {
    const rootDir = makeRoot();
    expect(readMetisMemorySoulSync(rootDir)).toEqual({
      path: path.join(rootDir, "soul.md"),
      content: "",
      updatedAt: null,
    });
    const soul = await Effect.runPromise(
      writeMetisMemorySoul({ rootDir, content: "Be direct.\r\nPrefer small diffs." }),
    );
    expect(soul.content).toBe("Be direct.\nPrefer small diffs.");
    expect(fs.statSync(soul.path).mode & 0o777).toBe(0o600);
    expect(
      (
        await failureOf(
          writeMetisMemorySoul({ rootDir, content: "x".repeat(METIS_MEMORY_SOUL_MAX_BYTES + 1) }),
        )
      ).code,
    ).toBe("limit-exceeded");
  });
});

describe("credential detection", () => {
  it("flags token shapes but not ordinary prose about secrets", () => {
    for (const text of [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdef",
      "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ]) {
      expect(containsCredentialLikeText(text), text).toBe(true);
    }
    for (const text of [
      "The user keeps passwords in 1Password.",
      "Tokens live in the macOS keychain; never print them.",
      "Use sk-style prefixes in examples only",
    ]) {
      expect(containsCredentialLikeText(text), text).toBe(false);
    }
  });
});
