import type {
  MetisMemoryDocument,
  MetisMemoryEntry,
  MetisMemoryOverview,
  MetisMemoryScope,
  MetisMemorySoul,
  MetisMemoryType,
  ProjectId,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export type MetisMemoryErrorCode = "invalid-input" | "not-found" | "limit-exceeded" | "io";

export class MetisMemoryError extends Data.TaggedError("MetisMemoryError")<{
  readonly code: MetisMemoryErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MetisMemoryLocation {
  readonly scope: MetisMemoryScope;
  /** Required for project scope. */
  readonly projectId?: ProjectId | string | null | undefined;
  readonly name: string;
}

export interface MetisMemoryWriteRequest extends MetisMemoryLocation {
  readonly description: string;
  readonly type: MetisMemoryType;
  readonly body: string;
  /** Readable project title recorded in project-scoped frontmatter. */
  readonly projectTitle?: string | null | undefined;
  /**
   * Agent writes refuse credential-shaped content; the user's own Settings
   * edits are trusted as written.
   */
  readonly origin: "agent" | "user";
}

export interface MetisMemoryListRequest {
  readonly scope: "global" | "project" | "all";
  readonly projectId?: ProjectId | string | null | undefined;
}

export interface MetisMemoryShape {
  /** `<stateDir>/memory`: soul.md, global/, projects/<projectKey>/. */
  readonly rootDir: string;
  readonly getOverview: () => Effect.Effect<MetisMemoryOverview, MetisMemoryError>;
  readonly list: (
    input: MetisMemoryListRequest,
  ) => Effect.Effect<ReadonlyArray<MetisMemoryEntry>, MetisMemoryError>;
  readonly read: (
    input: MetisMemoryLocation,
  ) => Effect.Effect<MetisMemoryDocument, MetisMemoryError>;
  readonly write: (
    input: MetisMemoryWriteRequest,
  ) => Effect.Effect<MetisMemoryEntry, MetisMemoryError>;
  readonly remove: (
    input: MetisMemoryLocation,
  ) => Effect.Effect<{ readonly deleted: boolean }, MetisMemoryError>;
  readonly readSoul: () => Effect.Effect<MetisMemorySoul, MetisMemoryError>;
  readonly writeSoul: (
    content: string,
    expectedRevision?: string,
  ) => Effect.Effect<MetisMemorySoul, MetisMemoryError>;
  /**
   * Synchronous, bounded render of the soul plus the global and (when known)
   * project memory index. Used once per provider session, alongside the host
   * policy; returns null when there is nothing to deliver.
   */
  readonly renderContext: (input: {
    readonly projectId: string | null;
    readonly projectTitle: string | null;
    readonly toolsAvailable: boolean;
  }) => string | null;
}

export class MetisMemory extends ServiceMap.Service<MetisMemory, MetisMemoryShape>()(
  "synara/metisMemory/Services/MetisMemory",
) {}
