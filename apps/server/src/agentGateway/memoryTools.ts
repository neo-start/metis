/**
 * synara_memory_* tools: thread-scoped access to Metis long-term memory.
 *
 * Global memories apply everywhere; project memories always resolve to the
 * calling thread's own project, so an agent can never read or write another
 * project's memories by naming it. Agents write directly (no approval card);
 * the user reviews, edits, and deletes memories in Settings > Memory.
 */
import {
  METIS_MEMORY_BODY_MAX_BYTES,
  METIS_MEMORY_DESCRIPTION_MAX_CHARS,
  METIS_MEMORY_NAME_PATTERN,
  type MetisMemoryEntry,
  type MetisMemoryScope,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect } from "effect";

import { isMetisMemoryType } from "../metisMemory/memoryFiles.ts";
import { MetisMemoryError, type MetisMemoryShape } from "../metisMemory/Services/MetisMemory.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import { ToolInputError, errorText, readStringArg } from "./toolInput.ts";
import {
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export interface AgentGatewayMemoryToolDependencies {
  readonly memory: MetisMemoryShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
  readonly resolveProjectTitle: (projectId: string) => Effect.Effect<string | null>;
}

const memoryToolFailure = (error: unknown) =>
  error instanceof MetisMemoryError
    ? gatewayToolErrorResult(new GatewayToolError(`memory_${error.code}`, error.message))
    : mcpToolResultError(errorText(error));

// Argument errors are thrown inside the generators, as in the other gateway
// tools; recover both failures and those defects into tool results here.
const recoverMemoryToolFailure = <R>(
  effect: Effect.Effect<McpToolCallResult, unknown, R>,
): Effect.Effect<McpToolCallResult, never, R> =>
  effect.pipe(
    Effect.catch((error) => Effect.succeed(memoryToolFailure(error))),
    Effect.catchDefect((defect) => Effect.succeed(memoryToolFailure(defect))),
  );

const SCOPE_DESCRIPTION =
  '"global" applies to every project; "project" is the calling thread\'s own project.';

function readScopeArg(args: Record<string, unknown>): MetisMemoryScope {
  const scope = readStringArg(args, "scope", { required: true });
  if (scope !== "global" && scope !== "project") {
    throw new ToolInputError('Argument "scope" must be "global" or "project".');
  }
  return scope;
}

function readNameArg(args: Record<string, unknown>): string {
  return readStringArg(args, "name", { required: true })!;
}

function summarizeEntry(entry: MetisMemoryEntry) {
  return {
    scope: entry.scope,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    updatedAt: entry.updatedAt,
  };
}

export function makeAgentGatewayMemoryTools(
  deps: AgentGatewayMemoryToolDependencies,
): ReadonlyArray<ToolEntry> {
  const { memory } = deps;

  const callerProject = (context: ToolContext) =>
    Effect.gen(function* () {
      const thread = yield* deps.requireThreadShell(context.callerThreadId);
      const projectTitle = yield* deps.resolveProjectTitle(thread.projectId);
      return { projectId: thread.projectId, projectTitle };
    });

  const listMemories: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_memory_list",
      description:
        "List Metis long-term memories (name, description, type, updatedAt) for global scope, the calling thread's project, or both. Memory is shared by every provider session; bodies are read with synara_memory_read.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["global", "project", "all"],
            description: `Defaults to "all". ${SCOPE_DESCRIPTION}`,
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Metis memories", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const scope = readStringArg(args, "scope") ?? "all";
        if (scope !== "global" && scope !== "project" && scope !== "all") {
          throw new ToolInputError('Argument "scope" must be "global", "project", or "all".');
        }
        const project = yield* callerProject(context);
        const entries = yield* memory.list({ scope, projectId: project.projectId });
        const soul = yield* memory.readSoul();
        return mcpToolResultJson({
          rootDir: memory.rootDir,
          project: { projectId: project.projectId, title: project.projectTitle },
          soul: {
            present: soul.content.trim().length > 0,
            bytes: Buffer.byteLength(soul.content, "utf8"),
            updatedAt: soul.updatedAt,
          },
          memories: entries.map(summarizeEntry),
        });
      }).pipe(recoverMemoryToolFailure),
  };

  const readMemory: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_memory_read",
      description:
        'Read one Metis memory in full, or the user\'s soul.md with {"scope":"soul"}. Project scope always means the calling thread\'s project.',
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["global", "project", "soul"],
            description: `${SCOPE_DESCRIPTION} "soul" reads soul.md and takes no name.`,
          },
          name: {
            type: "string",
            pattern: METIS_MEMORY_NAME_PATTERN,
            description: "Memory name (slug) from synara_memory_list.",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      annotations: { title: "Read a Metis memory", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        if (readStringArg(args, "scope", { required: true }) === "soul") {
          const soul = yield* memory.readSoul();
          return mcpToolResultJson({
            scope: "soul",
            path: soul.path,
            updatedAt: soul.updatedAt,
            content: soul.content,
          });
        }
        const scope = readScopeArg(args);
        const name = readNameArg(args);
        const projectId =
          scope === "project" ? (yield* callerProject(context)).projectId : undefined;
        const document = yield* memory.read({ scope, projectId, name });
        return mcpToolResultJson({ ...summarizeEntry(document.entry), body: document.body });
      }).pipe(recoverMemoryToolFailure),
  };

  const writeMemory: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_memory_write",
      description: `Create or fully replace one Metis long-term memory; every future provider session sees its name and description. Save durable user preferences, corrections, and project facts: one fact per memory, reuse an existing name to update instead of duplicating. Never store secrets, tokens, or credentials, or what the repository or git history already records. Body limit: ${METIS_MEMORY_BODY_MAX_BYTES / 1_024} KiB UTF-8.`,
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "project"], description: SCOPE_DESCRIPTION },
          name: {
            type: "string",
            pattern: METIS_MEMORY_NAME_PATTERN,
            description: "Stable slug, e.g. prefers-bun-scripts. Reusing a name replaces it.",
          },
          description: {
            type: "string",
            maxLength: METIS_MEMORY_DESCRIPTION_MAX_CHARS,
            description: "One-line summary shown in every session's memory index.",
          },
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description:
              "user: who the user is; feedback: how they want work done; project: facts about this work; reference: where to find things.",
          },
          body: {
            type: "string",
            maxLength: METIS_MEMORY_BODY_MAX_BYTES,
            description: "Markdown body: the fact, plus why it matters when useful.",
          },
        },
        required: ["scope", "name", "description", "type", "body"],
        additionalProperties: false,
      },
      annotations: { title: "Save a Metis memory", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const scope = readScopeArg(args);
        const name = readNameArg(args);
        const description = readStringArg(args, "description", { required: true })!;
        const type = readStringArg(args, "type", { required: true });
        if (!isMetisMemoryType(type)) {
          throw new ToolInputError(
            'Argument "type" must be "user", "feedback", "project", or "reference".',
          );
        }
        if (typeof args.body !== "string" || args.body.trim().length === 0) {
          throw new ToolInputError('Argument "body" must be a non-empty string.');
        }
        const body = args.body;
        const project = scope === "project" ? yield* callerProject(context) : null;
        const entry = yield* memory.write({
          scope,
          projectId: project?.projectId,
          projectTitle: project?.projectTitle ?? null,
          name,
          description,
          type,
          body,
          origin: "agent",
        });
        return mcpToolResultJson({ saved: true, memory: summarizeEntry(entry) });
      }).pipe(recoverMemoryToolFailure),
  };

  const deleteMemory: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_memory_delete",
      description:
        "Delete one Metis long-term memory that is wrong or obsolete. Project scope always means the calling thread's project.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "project"], description: SCOPE_DESCRIPTION },
          name: { type: "string", pattern: METIS_MEMORY_NAME_PATTERN },
        },
        required: ["scope", "name"],
        additionalProperties: false,
      },
      annotations: { title: "Delete a Metis memory", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const scope = readScopeArg(args);
        const name = readNameArg(args);
        const projectId =
          scope === "project" ? (yield* callerProject(context)).projectId : undefined;
        const result = yield* memory.remove({ scope, projectId, name });
        return mcpToolResultJson({ scope, name, deleted: result.deleted });
      }).pipe(recoverMemoryToolFailure),
  };

  return [listMemories, readMemory, writeMemory, deleteMemory];
}
