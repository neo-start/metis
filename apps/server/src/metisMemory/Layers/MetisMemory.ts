import { createHash } from "node:crypto";
import {
  ProjectId,
  type MetisMemoryEntry,
  type MetisMemoryOverview,
  type MetisMemoryProjectGroup,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect, Layer, Semaphore } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  deleteMetisMemoryFile,
  listMetisMemoryProjectDirectoriesSync,
  metisMemoryGlobalDir,
  metisMemoryRootDir,
  readMetisMemoryDocumentSync,
  readMetisMemorySoulSync,
  resolveMetisMemoryScope,
  scanMetisMemoryDirectorySync,
  writeMetisMemoryFile,
  writeMetisMemorySoul,
} from "../memoryFiles.ts";
import { installMetisMemoryContextSource, renderMetisMemoryContext } from "../memoryContext.ts";
import { MetisMemory, MetisMemoryError, type MetisMemoryShape } from "../Services/MetisMemory.ts";

const toMemoryError = (message: string) => (cause: unknown) =>
  cause instanceof MetisMemoryError ? cause : new MetisMemoryError({ code: "io", message, cause });

/**
 * Build the memory service over one memory root. `readModel` resolves a
 * thread's project and project titles; it must be synchronous because
 * provider sessions render their memory block synchronously.
 */
export function makeMetisMemoryShape(input: {
  readonly rootDir: string;
  readonly readModel: () => Pick<OrchestrationReadModel, "projects" | "threads"> | null;
  readonly now?: () => Date;
}): MetisMemoryShape & {
  readonly renderForThread: (input: {
    readonly threadId: string | undefined;
    readonly toolsAvailable: boolean;
  }) => string | null;
} {
  const { rootDir } = input;
  const mutationLock = Effect.runSync(Semaphore.make(1));

  const projectTitleById = (): Map<string, string> => {
    const model = input.readModel();
    return new Map((model?.projects ?? []).map((project) => [project.id, project.title]));
  };

  const scanScope = (scope: "global" | "project", projectId: string | null) =>
    scanMetisMemoryDirectorySync(resolveMetisMemoryScope(rootDir, scope, projectId));

  const renderContext: MetisMemoryShape["renderContext"] = (request) =>
    renderMetisMemoryContext({
      rootDir,
      soul: readMetisMemorySoulSync(rootDir).content,
      global: scanScope("global", null),
      project:
        request.projectId === null
          ? null
          : {
              projectId: request.projectId,
              projectTitle: request.projectTitle,
              entries: scanScope("project", request.projectId),
            },
      toolsAvailable: request.toolsAvailable,
    });

  const renderForThread = (request: {
    readonly threadId: string | undefined;
    readonly toolsAvailable: boolean;
  }): string | null => {
    let projectId: string | null = null;
    let projectTitle: string | null = null;
    if (request.threadId !== undefined) {
      const model = input.readModel();
      const thread = model?.threads.find((candidate) => candidate.id === request.threadId);
      if (thread) {
        projectId = thread.projectId;
        projectTitle =
          model?.projects.find((project) => project.id === thread.projectId)?.title ?? null;
      }
    }
    return renderContext({ projectId, projectTitle, toolsAvailable: request.toolsAvailable });
  };

  const getOverview: MetisMemoryShape["getOverview"] = () =>
    Effect.try({
      try: (): MetisMemoryOverview => {
        const titles = projectTitleById();
        const groups: MetisMemoryProjectGroup[] = [];
        for (const directory of listMetisMemoryProjectDirectoriesSync(rootDir)) {
          if (directory.projectId === null) continue;
          const entries = scanMetisMemoryDirectorySync({
            scope: "project",
            projectId: directory.projectId,
            directory: directory.directory,
          });
          if (entries.length === 0) continue;
          groups.push({
            projectId: ProjectId.makeUnsafe(directory.projectId),
            projectTitle: titles.get(directory.projectId) ?? directory.projectTitle,
            directory: directory.directory,
            entries,
          });
        }
        groups.sort((left, right) =>
          (left.projectTitle ?? left.projectId).localeCompare(
            right.projectTitle ?? right.projectId,
          ),
        );
        return {
          rootDir,
          soul: readMetisMemorySoulSync(rootDir),
          globalDirectory: metisMemoryGlobalDir(rootDir),
          global: scanScope("global", null),
          projects: groups,
        };
      },
      catch: toMemoryError("Failed to read Metis memory."),
    });

  const list: MetisMemoryShape["list"] = (request) =>
    Effect.try({
      try: (): ReadonlyArray<MetisMemoryEntry> => {
        const projectId = request.projectId?.trim() || null;
        const global = request.scope === "project" ? [] : scanScope("global", null);
        const project =
          request.scope === "global" || projectId === null ? [] : scanScope("project", projectId);
        if (request.scope === "project" && projectId === null) {
          throw new MetisMemoryError({
            code: "invalid-input",
            message: "Project-scoped memory requires a project.",
          });
        }
        return [...project, ...global];
      },
      catch: toMemoryError("Failed to list Metis memory."),
    });

  const read: MetisMemoryShape["read"] = (request) =>
    Effect.try({
      try: () => {
        const resolved = resolveMetisMemoryScope(rootDir, request.scope, request.projectId);
        const document = readMetisMemoryDocumentSync({ ...resolved, name: request.name });
        if (document === null) {
          throw new MetisMemoryError({
            code: "not-found",
            message: `Memory "${request.name}" was not found in ${request.scope} scope.`,
          });
        }
        return document;
      },
      catch: toMemoryError("Failed to read Metis memory."),
    });

  const write: MetisMemoryShape["write"] = (request) =>
    writeMetisMemoryFile({
      rootDir,
      scope: request.scope,
      projectId: request.projectId,
      projectTitle:
        request.projectTitle ??
        (request.projectId ? (projectTitleById().get(request.projectId) ?? null) : null),
      name: request.name,
      description: request.description,
      type: request.type,
      body: request.body,
      rejectCredentials: request.origin === "agent",
      ...(input.now ? { now: input.now } : {}),
    });

  const remove: MetisMemoryShape["remove"] = (request) =>
    deleteMetisMemoryFile({
      rootDir,
      scope: request.scope,
      projectId: request.projectId,
      name: request.name,
    });

  const readSoul: MetisMemoryShape["readSoul"] = () =>
    Effect.try({
      try: () => readMetisMemorySoulSync(rootDir),
      catch: toMemoryError("Failed to read soul.md."),
    });

  const writeSoul: MetisMemoryShape["writeSoul"] = (content, expectedRevision) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (expectedRevision !== undefined) {
          const current = yield* readSoul();
          if (createHash("sha256").update(current.content).digest("hex") !== expectedRevision)
            return yield* new MetisMemoryError({
              code: "invalid-input",
              message: "soul.md changed; read it again before revising.",
            });
        }
        return yield* writeMetisMemorySoul({ rootDir, content });
      }),
    );

  return {
    rootDir,
    getOverview,
    list,
    read,
    write: (request) => mutationLock.withPermits(1)(write(request)),
    remove: (request) => mutationLock.withPermits(1)(remove(request)),
    readSoul,
    writeSoul,
    renderContext,
    renderForThread,
  };
}

export const makeMetisMemory = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const shape = makeMetisMemoryShape({
    rootDir: metisMemoryRootDir(config.stateDir),
    // The command read model is an in-memory snapshot; reading it is sync.
    readModel: () => Effect.runSync(orchestrationEngine.getReadModel()),
  });

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      installMetisMemoryContextSource({
        renderForThread: (request) => {
          try {
            return shape.renderForThread(request);
          } catch (cause) {
            Effect.runFork(
              Effect.logWarning("Metis memory context unavailable for provider session", {
                threadId: request.threadId,
                cause: cause instanceof Error ? cause.message : String(cause),
              }),
            );
            return null;
          }
        },
      }),
    ),
    (uninstall) => Effect.sync(uninstall),
  );

  return shape satisfies MetisMemoryShape;
});

export const MetisMemoryLive = Layer.effect(MetisMemory, makeMetisMemory);
