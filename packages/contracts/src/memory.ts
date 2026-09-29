import { Schema } from "effect";

import { IsoDateTime, ProjectId } from "./baseSchemas";

/**
 * Metis long-term memory: a user-authored soul plus small markdown memories,
 * stored as plain files under the server state directory and shared by every
 * provider session. Scopes are global (applies everywhere) or one project.
 */
export const METIS_MEMORY_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";
export const METIS_MEMORY_NAME_MAX_LENGTH = 64;
export const METIS_MEMORY_DESCRIPTION_MAX_CHARS = 200;
/** Maximum UTF-8 size of one memory body. */
export const METIS_MEMORY_BODY_MAX_BYTES = 16 * 1_024;
/** Maximum UTF-8 size of soul.md when written through Metis. */
export const METIS_MEMORY_SOUL_MAX_BYTES = 32 * 1_024;
/** Per-scope caps: one directory never grows past these through Metis writes. */
export const METIS_MEMORY_SCOPE_MAX_ENTRIES = 200;
export const METIS_MEMORY_SCOPE_MAX_BYTES = 512 * 1_024;
/** Injection budgets: what every new provider session receives at most. */
export const METIS_MEMORY_INJECTED_SOUL_MAX_BYTES = 8 * 1_024;
export const METIS_MEMORY_INJECTED_INDEX_MAX_BYTES = 8 * 1_024;

export const MetisMemoryScope = Schema.Literals(["global", "project"]);
export type MetisMemoryScope = typeof MetisMemoryScope.Type;

export const MetisMemoryType = Schema.Literals(["user", "feedback", "project", "reference"]);
export type MetisMemoryType = typeof MetisMemoryType.Type;

export const MetisMemoryName = Schema.String.check(
  Schema.isPattern(new RegExp(METIS_MEMORY_NAME_PATTERN)),
);
export type MetisMemoryName = typeof MetisMemoryName.Type;

export const MetisMemoryEntry = Schema.Struct({
  scope: MetisMemoryScope,
  projectId: Schema.NullOr(ProjectId),
  name: Schema.String,
  description: Schema.String,
  type: MetisMemoryType,
  updatedAt: IsoDateTime,
  sizeBytes: Schema.Number,
  path: Schema.String,
});
export type MetisMemoryEntry = typeof MetisMemoryEntry.Type;

export const MetisMemoryDocument = Schema.Struct({
  entry: MetisMemoryEntry,
  body: Schema.String,
});
export type MetisMemoryDocument = typeof MetisMemoryDocument.Type;

export const MetisMemorySoul = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type MetisMemorySoul = typeof MetisMemorySoul.Type;

export const MetisMemoryProjectGroup = Schema.Struct({
  projectId: ProjectId,
  /** Current project title, or the title recorded in memory files for deleted projects. */
  projectTitle: Schema.NullOr(Schema.String),
  directory: Schema.String,
  entries: Schema.Array(MetisMemoryEntry),
});
export type MetisMemoryProjectGroup = typeof MetisMemoryProjectGroup.Type;

export const MetisMemoryOverview = Schema.Struct({
  rootDir: Schema.String,
  soul: MetisMemorySoul,
  globalDirectory: Schema.String,
  global: Schema.Array(MetisMemoryEntry),
  projects: Schema.Array(MetisMemoryProjectGroup),
});
export type MetisMemoryOverview = typeof MetisMemoryOverview.Type;

export const MetisMemoryLocator = Schema.Struct({
  scope: MetisMemoryScope,
  /** Required for project scope; ignored for global scope. */
  projectId: Schema.optional(ProjectId),
  name: MetisMemoryName,
});
export type MetisMemoryLocator = typeof MetisMemoryLocator.Type;

export const MetisMemoryReadInput = MetisMemoryLocator;
export type MetisMemoryReadInput = typeof MetisMemoryReadInput.Type;

export const MetisMemoryDeleteInput = MetisMemoryLocator;
export type MetisMemoryDeleteInput = typeof MetisMemoryDeleteInput.Type;

export const MetisMemoryWriteInput = Schema.Struct({
  scope: MetisMemoryScope,
  projectId: Schema.optional(ProjectId),
  name: MetisMemoryName,
  description: Schema.String.check(Schema.isMaxLength(METIS_MEMORY_DESCRIPTION_MAX_CHARS)),
  type: MetisMemoryType,
  body: Schema.String,
});
export type MetisMemoryWriteInput = typeof MetisMemoryWriteInput.Type;

export const MetisMemoryUpdateSoulInput = Schema.Struct({
  content: Schema.String,
});
export type MetisMemoryUpdateSoulInput = typeof MetisMemoryUpdateSoulInput.Type;

export const MetisMemoryDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type MetisMemoryDeleteResult = typeof MetisMemoryDeleteResult.Type;
