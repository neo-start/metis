/**
 * File layout, validation, and I/O for Metis long-term memory.
 *
 *   <root>/soul.md                         identity and working style (user-authored)
 *   <root>/global/<name>.md                memories that apply everywhere
 *   <root>/projects/<projectKey>/<name>.md memories for one project
 *
 * Each memory is one markdown file with a small frontmatter block (name,
 * description, type, updatedAt; project files also record projectId and
 * projectTitle). Files are plain text so the user can edit them directly.
 * Reads are synchronous and cached by (mtime, size) so a provider session can
 * render its memory index without awaiting I/O; writes go through the shared
 * private atomic-write helper.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  METIS_MEMORY_BODY_MAX_BYTES,
  METIS_MEMORY_DESCRIPTION_MAX_CHARS,
  METIS_MEMORY_NAME_PATTERN,
  METIS_MEMORY_SCOPE_MAX_BYTES,
  METIS_MEMORY_SCOPE_MAX_ENTRIES,
  METIS_MEMORY_SOUL_MAX_BYTES,
  ProjectId,
  type MetisMemoryEntry,
  type MetisMemoryScope,
  type MetisMemorySoul,
  type MetisMemoryType,
} from "@synara/contracts";
import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { MetisMemoryError } from "./Services/MetisMemory.ts";

export const METIS_MEMORY_DIRECTORY_NAME = "memory";
export const METIS_MEMORY_SOUL_FILE_NAME = "soul.md";
export const METIS_MEMORY_GLOBAL_DIRECTORY_NAME = "global";
export const METIS_MEMORY_PROJECTS_DIRECTORY_NAME = "projects";

const MEMORY_FILE_EXTENSION = ".md";
const MEMORY_NAME_REGEX = new RegExp(METIS_MEMORY_NAME_PATTERN);
const SAFE_PROJECT_KEY_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const MEMORY_TYPES: ReadonlySet<string> = new Set(["user", "feedback", "project", "reference"]);
const DEFAULT_MEMORY_TYPE: MetisMemoryType = "reference";

export function metisMemoryRootDir(stateDir: string): string {
  return path.join(stateDir, METIS_MEMORY_DIRECTORY_NAME);
}

export function metisMemorySoulPath(rootDir: string): string {
  return path.join(rootDir, METIS_MEMORY_SOUL_FILE_NAME);
}

export function metisMemoryGlobalDir(rootDir: string): string {
  return path.join(rootDir, METIS_MEMORY_GLOBAL_DIRECTORY_NAME);
}

export function metisMemoryProjectsDir(rootDir: string): string {
  return path.join(rootDir, METIS_MEMORY_PROJECTS_DIRECTORY_NAME);
}

export function isValidMetisMemoryName(name: unknown): name is string {
  return typeof name === "string" && MEMORY_NAME_REGEX.test(name);
}

export function isMetisMemoryType(value: unknown): value is MetisMemoryType {
  return typeof value === "string" && MEMORY_TYPES.has(value);
}

/**
 * Stable directory key for a project. Ordinary ids (UUIDs and slugs) are used
 * verbatim so the tree stays readable; anything else is hashed so a project id
 * can never introduce separators, dots, or traversal into a path.
 */
export function metisMemoryProjectKey(projectId: string): string {
  if (SAFE_PROJECT_KEY_REGEX.test(projectId)) return projectId;
  return `p-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

export function metisMemoryProjectDir(rootDir: string, projectId: string): string {
  return path.join(metisMemoryProjectsDir(rootDir), metisMemoryProjectKey(projectId));
}

function invalidInput(message: string): MetisMemoryError {
  return new MetisMemoryError({ code: "invalid-input", message });
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  const trimmed = projectId?.trim();
  return trimmed ? trimmed : null;
}

export interface ResolvedMetisMemoryScope {
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null;
  readonly directory: string;
}

export function resolveMetisMemoryScope(
  rootDir: string,
  scope: MetisMemoryScope,
  projectId: string | null | undefined,
): ResolvedMetisMemoryScope {
  if (scope === "global") {
    return { scope, projectId: null, directory: metisMemoryGlobalDir(rootDir) };
  }
  if (scope !== "project") {
    throw invalidInput('Memory scope must be "global" or "project".');
  }
  const normalized = normalizeProjectId(projectId);
  if (normalized === null) {
    throw invalidInput("Project-scoped memory requires a project.");
  }
  return {
    scope,
    projectId: normalized,
    directory: metisMemoryProjectDir(rootDir, normalized),
  };
}

/** Resolve `<directory>/<name>.md`, refusing anything that is not a plain slug. */
export function metisMemoryFilePath(directory: string, name: string): string {
  if (!isValidMetisMemoryName(name)) {
    throw invalidInput(
      `Invalid memory name "${String(name).slice(0, 80)}": use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
  const filePath = path.join(directory, `${name}${MEMORY_FILE_EXTENSION}`);
  if (path.dirname(filePath) !== path.normalize(directory)) {
    throw invalidInput(`Invalid memory name "${name}".`);
  }
  return filePath;
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

export interface MetisMemoryFrontmatter {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly type?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly projectId?: string | undefined;
  readonly projectTitle?: string | undefined;
}

function parseFrontmatterValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the raw text: hand-edited YAML may not be JSON.
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

export function parseMetisMemoryFile(text: string): {
  readonly frontmatter: MetisMemoryFrontmatter;
  readonly body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: normalized };
  const afterMarker = normalized.slice(end + 4);
  if (afterMarker.length > 0 && !afterMarker.startsWith("\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) continue;
    fields[key] = parseFrontmatterValue(line.slice(separator + 1));
  }
  const body = afterMarker.replace(/^\n/, "").replace(/^\n/, "");
  return {
    frontmatter: {
      name: fields.name,
      description: fields.description,
      type: fields.type,
      updatedAt: fields.updatedAt,
      projectId: fields.projectId,
      projectTitle: fields.projectTitle,
    },
    body,
  };
}

/** One line, bounded: descriptions are what every session's index shows. */
export function normalizeMetisMemoryDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, METIS_MEMORY_DESCRIPTION_MAX_CHARS);
}

export function serializeMetisMemoryFile(input: {
  readonly name: string;
  readonly description: string;
  readonly type: MetisMemoryType;
  readonly updatedAt: string;
  readonly projectId?: string | null | undefined;
  readonly projectTitle?: string | null | undefined;
  readonly body: string;
}): string {
  const lines = [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(normalizeMetisMemoryDescription(input.description))}`,
    `type: ${input.type}`,
    `updatedAt: ${input.updatedAt}`,
  ];
  if (input.projectId) lines.push(`projectId: ${JSON.stringify(input.projectId)}`);
  const title = input.projectTitle?.replace(/\s+/g, " ").trim();
  if (title) lines.push(`projectTitle: ${JSON.stringify(title.slice(0, 200))}`);
  lines.push("---", "");
  const body = input.body.replace(/\r\n/g, "\n");
  return `${lines.join("\n")}\n${body.endsWith("\n") || body.length === 0 ? body : `${body}\n`}`;
}

function describeFromBody(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text.length > 0) return normalizeMetisMemoryDescription(text);
  }
  return "";
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

// ── Synchronous, cached reads ───────────────────────────────────────────────

interface CachedMemoryFile {
  /** Inode, size, and both timestamps: atomic replaces change the inode and
   * in-place edits change ctime, so coarse mtime granularity cannot hide one. */
  readonly fingerprint: string;
  readonly frontmatter: MetisMemoryFrontmatter;
  readonly body: string;
}

const fileCache = new Map<string, CachedMemoryFile>();

function statFingerprint(stat: fs.Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function readRegularFileSync(filePath: string): { stat: fs.Stats; text: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  // Memory files are private data; never follow a symlink out of the tree.
  if (!stat.isFile()) return null;
  if (fileCache.get(filePath)?.fingerprint === statFingerprint(stat)) {
    return { stat, text: "" };
  }
  return { stat, text: fs.readFileSync(filePath, "utf8") };
}

function loadMemoryFileSync(filePath: string): (CachedMemoryFile & { stat: fs.Stats }) | null {
  const loaded = readRegularFileSync(filePath);
  if (loaded === null) {
    fileCache.delete(filePath);
    return null;
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.fingerprint === statFingerprint(loaded.stat)) {
    return { ...cached, stat: loaded.stat };
  }
  const parsed = parseMetisMemoryFile(loaded.text);
  const next: CachedMemoryFile = {
    fingerprint: statFingerprint(loaded.stat),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
  fileCache.set(filePath, next);
  return { ...next, stat: loaded.stat };
}

function toEntry(input: {
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null;
  readonly name: string;
  readonly filePath: string;
  readonly file: CachedMemoryFile & { stat: fs.Stats };
}): MetisMemoryEntry {
  const { frontmatter, body, stat } = input.file;
  const description = frontmatter.description
    ? normalizeMetisMemoryDescription(frontmatter.description)
    : describeFromBody(body);
  return {
    scope: input.scope,
    projectId: input.projectId === null ? null : ProjectId.makeUnsafe(input.projectId),
    name: input.name,
    description,
    type: isMetisMemoryType(frontmatter.type) ? frontmatter.type : DEFAULT_MEMORY_TYPE,
    updatedAt: isoOrNull(frontmatter.updatedAt) ?? new Date(stat.mtimeMs).toISOString(),
    sizeBytes: stat.size,
    path: input.filePath,
  };
}

function listDirectorySync(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw cause;
  }
}

/** Newest first, then by name, so indexes and truncation are deterministic. */
export function compareMetisMemoryEntries(left: MetisMemoryEntry, right: MetisMemoryEntry): number {
  const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return byTime !== 0 ? byTime : left.name.localeCompare(right.name);
}

export function scanMetisMemoryDirectorySync(input: {
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null;
  readonly directory: string;
}): MetisMemoryEntry[] {
  const entries: MetisMemoryEntry[] = [];
  for (const fileName of listDirectorySync(input.directory)) {
    if (!fileName.endsWith(MEMORY_FILE_EXTENSION)) continue;
    const name = fileName.slice(0, -MEMORY_FILE_EXTENSION.length);
    if (!isValidMetisMemoryName(name)) continue;
    const filePath = path.join(input.directory, fileName);
    const file = loadMemoryFileSync(filePath);
    if (file === null) continue;
    entries.push(toEntry({ scope: input.scope, projectId: input.projectId, name, filePath, file }));
  }
  return entries.toSorted(compareMetisMemoryEntries);
}

export function readMetisMemoryDocumentSync(input: {
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null;
  readonly directory: string;
  readonly name: string;
}): { readonly entry: MetisMemoryEntry; readonly body: string } | null {
  const filePath = metisMemoryFilePath(input.directory, input.name);
  const file = loadMemoryFileSync(filePath);
  if (file === null) return null;
  return {
    entry: toEntry({
      scope: input.scope,
      projectId: input.projectId,
      name: input.name,
      filePath,
      file,
    }),
    body: file.body,
  };
}

export interface MetisMemoryProjectDirectory {
  readonly projectKey: string;
  readonly directory: string;
  /** Recorded in frontmatter; the directory key when it is the id itself. */
  readonly projectId: string | null;
  readonly projectTitle: string | null;
}

/** Project directories on disk, with the id/title recorded by their memories. */
export function listMetisMemoryProjectDirectoriesSync(
  rootDir: string,
): MetisMemoryProjectDirectory[] {
  const projectsDir = metisMemoryProjectsDir(rootDir);
  const result: MetisMemoryProjectDirectory[] = [];
  for (const projectKey of listDirectorySync(projectsDir)) {
    if (!SAFE_PROJECT_KEY_REGEX.test(projectKey)) continue;
    const directory = path.join(projectsDir, projectKey);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let projectId: string | null = projectKey.startsWith("p-") ? null : projectKey;
    let projectTitle: string | null = null;
    for (const fileName of listDirectorySync(directory)) {
      if (!fileName.endsWith(MEMORY_FILE_EXTENSION)) continue;
      const file = loadMemoryFileSync(path.join(directory, fileName));
      if (file === null) continue;
      const recordedId = file.frontmatter.projectId?.trim();
      if (recordedId && metisMemoryProjectKey(recordedId) === projectKey) projectId = recordedId;
      projectTitle ??= file.frontmatter.projectTitle?.trim() || null;
      if (projectId !== null && projectTitle !== null) break;
    }
    result.push({ projectKey, directory, projectId, projectTitle });
  }
  return result;
}

export function readMetisMemorySoulSync(rootDir: string): MetisMemorySoul {
  const soulPath = metisMemorySoulPath(rootDir);
  const loaded = readRegularFileSync(soulPath);
  if (loaded === null) {
    fileCache.delete(soulPath);
    return { path: soulPath, content: "", updatedAt: null };
  }
  const cached = fileCache.get(soulPath);
  let content: string;
  if (cached && cached.fingerprint === statFingerprint(loaded.stat)) {
    content = cached.body;
  } else {
    content = loaded.text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    fileCache.set(soulPath, {
      fingerprint: statFingerprint(loaded.stat),
      frontmatter: {},
      body: content,
    });
  }
  return {
    path: soulPath,
    content,
    updatedAt: new Date(loaded.stat.mtimeMs).toISOString(),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * High-confidence credential shapes only. Agents are told never to store
 * secrets; this is the backstop for tokens pasted into a memory verbatim.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export function containsCredentialLikeText(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** Keep prior content outside the live index. Content hashes make retries
 * idempotent; owner deletion removes this file's history as well. */
function memoryRevisionDirectory(rootDir: string, filePath: string): string {
  return path.join(
    rootDir,
    "history",
    createHash("sha256").update(path.relative(rootDir, filePath)).digest("hex"),
  );
}

const preserveMemoryRevision = (rootDir: string, filePath: string, nextContent: string) =>
  Effect.gen(function* () {
    const previous = yield* Effect.try({
      try: () => {
        try {
          if (!fs.lstatSync(filePath).isFile()) throw invalidInput("Memory is not a regular file.");
          return fs.readFileSync(filePath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      catch: toIoError("Failed to read previous memory revision."),
    });
    if (previous === null || previous === nextContent) return;
    const hash = createHash("sha256").update(previous).digest("hex");
    const directory = memoryRevisionDirectory(rootDir, filePath);
    yield* writeFileStringAtomically({
      filePath: path.join(directory, `${hash}.json`),
      contents: JSON.stringify({
        path: path.relative(rootDir, filePath),
        savedAt: new Date().toISOString(),
        content: previous,
      }),
    }).pipe(Effect.mapError(toIoError("Failed to preserve memory revision.")));
  });

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const toIoError = (message: string) => (cause: unknown) =>
  cause instanceof MetisMemoryError ? cause : new MetisMemoryError({ code: "io", message, cause });

export interface WriteMetisMemoryFileInput {
  readonly rootDir: string;
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null | undefined;
  readonly projectTitle?: string | null | undefined;
  readonly name: string;
  readonly description: string;
  readonly type: MetisMemoryType;
  readonly body: string;
  readonly rejectCredentials: boolean;
  readonly now?: () => Date;
}

/** Create or fully replace one memory file (temp file + rename, 0600). */
export const writeMetisMemoryFile = (
  input: WriteMetisMemoryFileInput,
): Effect.Effect<MetisMemoryEntry, MetisMemoryError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        const resolved = resolveMetisMemoryScope(input.rootDir, input.scope, input.projectId);
        const filePath = metisMemoryFilePath(resolved.directory, input.name);
        if (!isMetisMemoryType(input.type)) {
          throw invalidInput('Memory type must be "user", "feedback", "project", or "reference".');
        }
        const description = normalizeMetisMemoryDescription(input.description);
        if (description.length === 0) {
          throw invalidInput("Memory description must be a non-empty one-line summary.");
        }
        const body = input.body.replace(/\r\n/g, "\n");
        if (body.trim().length === 0) throw invalidInput("Memory body must not be empty.");
        if (utf8Bytes(body) > METIS_MEMORY_BODY_MAX_BYTES) {
          throw new MetisMemoryError({
            code: "limit-exceeded",
            message: `Memory body exceeds ${METIS_MEMORY_BODY_MAX_BYTES / 1_024} KiB. Keep one fact per memory.`,
          });
        }
        if (
          input.rejectCredentials &&
          (containsCredentialLikeText(body) || containsCredentialLikeText(description))
        ) {
          throw invalidInput(
            "Memory looks like it contains a secret, token, or credential. Never store credentials in memory.",
          );
        }
        const contents = serializeMetisMemoryFile({
          name: input.name,
          description,
          type: input.type,
          updatedAt: (input.now?.() ?? new Date()).toISOString(),
          projectId: resolved.projectId,
          projectTitle: input.projectTitle,
          body,
        });
        const existing = scanMetisMemoryDirectorySync(resolved);
        const others = existing.filter((entry) => entry.name !== input.name);
        if (others.length + 1 > METIS_MEMORY_SCOPE_MAX_ENTRIES) {
          throw new MetisMemoryError({
            code: "limit-exceeded",
            message: `This memory scope already holds ${METIS_MEMORY_SCOPE_MAX_ENTRIES} memories. Update or delete existing memories instead.`,
          });
        }
        const otherBytes = others.reduce((total, entry) => total + entry.sizeBytes, 0);
        if (otherBytes + utf8Bytes(contents) > METIS_MEMORY_SCOPE_MAX_BYTES) {
          throw new MetisMemoryError({
            code: "limit-exceeded",
            message: `This memory scope would exceed ${METIS_MEMORY_SCOPE_MAX_BYTES / 1_024} KiB. Consolidate or delete memories first.`,
          });
        }
        return { resolved, filePath, contents };
      },
      catch: toIoError("Failed to prepare memory write."),
    });
    yield* preserveMemoryRevision(input.rootDir, prepared.filePath, prepared.contents);
    yield* writeFileStringAtomically({
      filePath: prepared.filePath,
      contents: prepared.contents,
    }).pipe(Effect.mapError(toIoError("Failed to write memory file.")));
    const written = yield* Effect.try({
      try: () =>
        readMetisMemoryDocumentSync({
          scope: prepared.resolved.scope,
          projectId: prepared.resolved.projectId,
          directory: prepared.resolved.directory,
          name: input.name,
        }),
      catch: toIoError("Failed to read back memory file."),
    });
    if (written === null) {
      return yield* new MetisMemoryError({
        code: "io",
        message: "Memory file disappeared after it was written.",
      });
    }
    return written.entry;
  });

export const deleteMetisMemoryFile = (input: {
  readonly rootDir: string;
  readonly scope: MetisMemoryScope;
  readonly projectId: string | null | undefined;
  readonly name: string;
}): Effect.Effect<{ readonly deleted: boolean }, MetisMemoryError> =>
  Effect.try({
    try: () => {
      const resolved = resolveMetisMemoryScope(input.rootDir, input.scope, input.projectId);
      const filePath = metisMemoryFilePath(resolved.directory, input.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          fs.rmSync(memoryRevisionDirectory(input.rootDir, filePath), {
            recursive: true,
            force: true,
          });
          return { deleted: false };
        }
        throw cause;
      }
      if (!stat.isFile()) {
        throw invalidInput(`Memory "${input.name}" is not a regular file.`);
      }
      fs.rmSync(filePath);
      fs.rmSync(memoryRevisionDirectory(input.rootDir, filePath), { recursive: true, force: true });
      fileCache.delete(filePath);
      return { deleted: true };
    },
    catch: toIoError("Failed to delete memory file."),
  });

export const writeMetisMemorySoul = (input: {
  readonly rootDir: string;
  readonly content: string;
}): Effect.Effect<MetisMemorySoul, MetisMemoryError> =>
  Effect.gen(function* () {
    const content = input.content.replace(/\r\n/g, "\n");
    if (utf8Bytes(content) > METIS_MEMORY_SOUL_MAX_BYTES) {
      return yield* new MetisMemoryError({
        code: "limit-exceeded",
        message: `soul.md exceeds ${METIS_MEMORY_SOUL_MAX_BYTES / 1_024} KiB.`,
      });
    }
    yield* preserveMemoryRevision(input.rootDir, metisMemorySoulPath(input.rootDir), content);
    yield* writeFileStringAtomically({
      filePath: metisMemorySoulPath(input.rootDir),
      contents: content,
    }).pipe(Effect.mapError(toIoError("Failed to write soul.md.")));
    return yield* Effect.try({
      try: () => readMetisMemorySoulSync(input.rootDir),
      catch: toIoError("Failed to read back soul.md."),
    });
  });
