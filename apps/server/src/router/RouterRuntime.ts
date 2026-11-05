import { mkdir as mkdirRouterDirectory } from "node:fs/promises";
import { join as joinRouterPath } from "node:path";
import { Effect, Layer, Option, ServiceMap } from "effect";
import type { OrchestrationCommand, ThreadId } from "@synara/contracts";
import { RouterInbox } from "./RouterInbox.ts";
import { AgentRouter } from "./AgentRouter.ts";
import { AgentGateway } from "../agentGateway/Services/AgentGateway.ts";
import { ServerConfig } from "../config.ts";
import { TextGeneration } from "../git/Services/TextGeneration.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";

export class RouterRuntime extends ServiceMap.Service<RouterRuntime, RouterInbox>()(
  "metis/RouterRuntime",
) {}
export const makeRouterRuntime = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const textGeneration = yield* TextGeneration;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const routerGateway = Option.getOrUndefined(yield* Effect.serviceOption(AgentGateway));
  const routerAbort = new AbortController();
  const agentRouter = new AgentRouter(joinRouterPath(config.stateDir, "router", "receipts"));
  const routerGenerationCwd = joinRouterPath(config.stateDir, "router", "generation");
  const routerHost = {
    generationCwd: routerGenerationCwd,
    readThread: async (threadId: ThreadId) =>
      Option.getOrNull(
        await Effect.runPromise(projectionReadModelQuery.getThreadDetailById(threadId), {
          signal: routerAbort.signal,
        }),
      ),
    listWorkers: async (threadId: ThreadId) =>
      (
        await Effect.runPromise(orchestrationEngine.getReadModel(), {
          signal: routerAbort.signal,
        })
      ).threads.filter(
        (thread) =>
          thread.creationSource === "router" &&
          thread.sourceThreadId === threadId &&
          !thread.deletedAt &&
          !thread.archivedAt,
      ),
    createWorker: async (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      sourceContext?: string,
    ) => {
      if (!routerGateway?.createRouterWorker) throw new Error("Router worker service unavailable.");
      return Effect.runPromise(routerGateway.createRouterWorker(command, sourceContext), {
        signal: routerAbort.signal,
      });
    },
    generate: async (input: import("../git/Services/TextGeneration.ts").RouterGenerationInput) => {
      if (!textGeneration.routeMessage) throw new Error("Router generation unavailable.");
      await mkdirRouterDirectory(routerGenerationCwd, { recursive: true, mode: 0o700 });
      const startedAt = Date.now();
      return Effect.runPromise(
        textGeneration.routeMessage(input).pipe(
          Effect.timeout("30 seconds"),
          Effect.tap(() =>
            Effect.logInfo("Router generation completed", { elapsedMs: Date.now() - startedAt }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Router generation failed", { errorType: error._tag }),
          ),
        ),
        { signal: routerAbort.signal },
      );
    },
    // Plain Router requests contain no attachment claims or approval responses.
    dispatch: (command: OrchestrationCommand) =>
      Effect.runPromise(runtimeStartup.enqueueCommand(orchestrationEngine.dispatch(command)), {
        signal: routerAbort.signal,
      }),
  };
  const routerInbox = new RouterInbox(
    joinRouterPath(config.stateDir, "router", "inbox"),
    agentRouter,
    routerHost,
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      routerInbox.stop();
      routerAbort.abort();
    }),
  );
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.tryPromise(() => routerInbox.recover()).pipe(
        Effect.catch((error) => Effect.logWarning("Router inbox recovery failed", { error })),
        Effect.andThen(Effect.sleep("5 seconds")),
      ),
    ),
  );

  return routerInbox;
});
export const RouterRuntimeLive = Layer.effect(RouterRuntime, makeRouterRuntime);
