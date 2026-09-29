import { ProjectionPendingInteractionRepositoryLive } from "./persistence/Layers/ProjectionPendingInteractions";
import http from "node:http";

import type { ServerSettingsError } from "@synara/contracts";
import { Effect, Exit, FileSystem, Layer, Path, Schema, Scope, ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { agentGatewayRouteLayer } from "./agentGateway/httpRoute";
import { AgentGatewayCredentials } from "./agentGateway/Services/AgentGatewayCredentials";
import { AutomationRunReactor } from "./automation/Services/AutomationRunReactor";
import { AutomationScheduler } from "./automation/Services/AutomationScheduler";
import { FeishuBridge } from "./feishu/Services/FeishuBridge";
import { AutomationService } from "./automation/Services/AutomationService";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState";
import { remoteAccessPolicyError, ServerConfig } from "./config";
import { resolveListeningPort } from "./startupAccess";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility";
import { makeEffectHttpRouteLayer } from "./http";
import { Keybindings } from "./keybindings";
import {
  ManagedAttachmentCleanup,
  type ManagedAttachmentCleanupShape,
} from "./managedAttachmentCleanup";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProjectionPendingInteractionRepository } from "./persistence/Services/ProjectionPendingInteractions";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor";
import {
  claimQuitResumeRecordAtStartup,
  resumeQuitInterruptedChats,
} from "./orchestration/quitResume";
import {
  claimRestartResumeSnapshotAtStartup,
  readNewestTurnIntentIsStop,
  recordRestartResumeSnapshotAtShutdown,
  resumeRestartInterruptedChats,
} from "./orchestration/restartResume";
import { reconcileRestartStuckTurns } from "./orchestration/startupTurnReconciliation";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper";
import { ProviderRuntimeReconciler } from "./provider/Services/ProviderRuntimeReconciler";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { makeServerReadiness } from "./server/readiness";
import { makeServerShutdownController, type ServerShutdownController } from "./serverShutdown";
import { makeBoundedNodeHttpServer } from "./nodeHttpServer";
import { websocketRpcRouteLayer } from "./wsRpc";
import { recoverGitHandoffOperations } from "./gitHandoffOperations";
import { externalMcpRouteLayer } from "./externalMcp/httpRoute";
import { ExternalMcpGateway } from "./externalMcp/Services/ExternalMcpGateway";
import { ExternalMcpService } from "./externalMcp/Services/ExternalMcpService";

export interface ServerShape {
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError | ServerSettingsError,
    | Scope.Scope
    | ServerConfig
    | AgentGatewayCredentials
    | ExternalMcpGateway
    | ExternalMcpService
    | FileSystem.FileSystem
    | Path.Path
    | Keybindings
    | ManagedAttachmentCleanup
    | AutomationRunReactor
    | AutomationScheduler
    | FeishuBridge
    | AutomationService
    | ServerLifecycleEvents
    | OrchestrationEngineService
    | OrchestrationReactor
    | ProjectionPendingInteractionRepository
    | ProjectionSnapshotQuery
    | ProviderSessionReaper
    | ProviderRuntimeReconciler
    | ProviderService
    | ServerRuntimeStartup
    | ServerSettingsService
    | ThreadDeletionReactor
    | SqlClient.SqlClient
  >;
  readonly stopSignal: Effect.Effect<void, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()(
  "synara/effectServer/Server",
) {}

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export function closeServerRuntimePipeline(input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "quiesce" | "drain" | "stop">;
  readonly providerService: Pick<ProviderServiceShape, "closeRuntimeEvents">;
  readonly managedAttachmentCleanup: Pick<ManagedAttachmentCleanupShape, "drain">;
  readonly subscriptionsScope: Scope.Closeable;
}): Effect.Effect<void> {
  return input.orchestrationEngine.quiesce.pipe(
    // Drain already-admitted commands while every subscriber is live. Provider
    // close then fences terminal runtime events into subscriber workers; scope
    // close drains those workers before the engine accepts its final stop.
    Effect.andThen(input.orchestrationEngine.drain),
    Effect.andThen(input.providerService.closeRuntimeEvents),
    Effect.andThen(Scope.close(input.subscriptionsScope, Exit.void)),
    Effect.andThen(input.managedAttachmentCleanup.drain),
    Effect.andThen(input.orchestrationEngine.stop),
  );
}

export const createEffectServer = Effect.fn(function* (
  shutdownController: ServerShutdownController,
) {
  const config = yield* ServerConfig;
  const remotePolicyError = remoteAccessPolicyError(config);
  if (remotePolicyError) {
    return yield* new ServerLifecycleError({
      operation: "validateRemoteAccessPolicy",
      cause: new Error(remotePolicyError),
    });
  }
  const agentGatewayCredentials = yield* AgentGatewayCredentials;
  const automationRunReactor = yield* AutomationRunReactor;
  const automationScheduler = yield* AutomationScheduler;
  const feishuBridge = yield* FeishuBridge;
  const keybindings = yield* Keybindings;
  const managedAttachmentCleanup = yield* ManagedAttachmentCleanup;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const orchestrationReactor = yield* OrchestrationReactor;
  const providerService = yield* ProviderService;
  const providerSessionReaper = yield* ProviderSessionReaper;
  const providerRuntimeReconciler = yield* ProviderRuntimeReconciler;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const serverSettings = yield* ServerSettingsService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const readiness = yield* makeServerReadiness;

  yield* keybindings.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );
  yield* serverSettings.start;
  yield* readiness.markPushBusReady;
  yield* readiness.markKeybindingsReady;

  let nodeServer: http.Server | null = null;
  patchBunWebSocketCloseEventCompatibility();
  // Keep embedded/test callers safe if they construct ServerConfig without
  // passing through the CLI's loopback-default resolution.
  const listenOptions = { host: config.host ?? "127.0.0.1", port: config.port };
  const httpServer = yield* makeBoundedNodeHttpServer(() => {
    nodeServer = http.createServer();
    return nodeServer;
  }, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  const routesLayer = Layer.mergeAll(
    makeEffectHttpRouteLayer(readiness, shutdownController),
    websocketRpcRouteLayer,
    agentGatewayRouteLayer,
    externalMcpRouteLayer,
  );
  const httpApp = yield* HttpRouter.toHttpEffect(routesLayer);
  yield* httpServer
    .serve(httpApp)
    .pipe(
      Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerServe", cause })),
    );

  const listeningPort = resolveListeningPort(
    (nodeServer as http.Server | null)?.address() ?? null,
    config.port,
  );
  agentGatewayCredentials.setListeningPort(listeningPort);
  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: makePersistedServerRuntimeState({
      config,
      port: listeningPort,
    }),
  }).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "persistServerRuntimeState", cause }),
    ),
  );
  yield* Effect.addFinalizer(() => clearPersistedServerRuntimeState(config.serverRuntimeStatePath));
  yield* readiness.markHttpListening;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() =>
    closeServerRuntimePipeline({
      orchestrationEngine,
      providerService,
      managedAttachmentCleanup,
      subscriptionsScope,
    }),
  );
  // Registered after the pipeline close so it runs first: remember the chats in
  // flight before provider teardown settles their turns, so the next boot can
  // continue them (desktop update install, relaunch, backend restart).
  yield* Effect.addFinalizer(() =>
    recordRestartResumeSnapshotAtShutdown.pipe(
      Effect.provideService(OrchestrationEngineService, orchestrationEngine),
    ),
  );
  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* Scope.provide(automationScheduler.start(), subscriptionsScope);
  yield* Scope.provide(automationRunReactor.start(), subscriptionsScope);
  yield* Scope.provide(feishuBridge.start(), subscriptionsScope);
  yield* Scope.provide(threadDeletionReactor.start(), subscriptionsScope);
  yield* Scope.provide(providerSessionReaper.start(), subscriptionsScope);
  yield* Scope.provide(providerRuntimeReconciler.start(), subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;
  yield* readiness.markTerminalSubscriptionsReady;
  // Heal turns orphaned by the previous process exit (their in-memory runtimes
  // died, so they can never complete on their own) before clients can observe
  // the stale "Working" state.
  const restartOrphans = yield* reconcileRestartStuckTurns.pipe(
    Effect.provide(ProjectionPendingInteractionRepositoryLive),
  );
  // The reconciliation above terminalizes durable turn projections without a
  // provider terminal event. Remove their replay-ledger rows now so the next
  // process start cannot replay state-dependent commands against the terminal
  // projection.
  yield* orchestrationReactor.reconcileSettledOpenTurns;
  yield* recoverGitHandoffOperations((command) => orchestrationEngine.dispatch(command)).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "recoverGitHandoffOperations", cause }),
    ),
  );
  // Claim the previous quit's "Resume chats automatically" record while no
  // command (and so no new quit) can run yet; a missing record costs one stat.
  const quitResumeRecord = yield* claimQuitResumeRecordAtStartup;
  // Same for the previous graceful shutdown's snapshot of in-flight chats.
  const restartResumeSnapshot = yield* claimRestartResumeSnapshotAtStartup;
  yield* runtimeStartup.markCommandReady;
  // The recorded chats get their continuation turn now that the orphaned turns
  // above are settled. Forked so the (rare) dispatch work never delays readiness.
  // Restart resume runs after quit resume and skips the threads it covers.
  const sqlClient = yield* SqlClient.SqlClient;
  const readTurnIntentIsStop = (threadId: Parameters<typeof readNewestTurnIntentIsStop>[0]) =>
    readNewestTurnIntentIsStop(threadId).pipe(
      Effect.provide(OrchestrationEventStoreLive),
      Effect.provideService(SqlClient.SqlClient, sqlClient),
    );
  yield* resumeQuitInterruptedChats(quitResumeRecord).pipe(
    Effect.andThen(
      resumeRestartInterruptedChats({
        bootOrphans: restartOrphans,
        snapshot: restartResumeSnapshot,
        quitResume: quitResumeRecord,
        newestTurnIntentIsStop: readTurnIntentIsStop,
      }),
    ),
    Effect.forkIn(subscriptionsScope),
  );

  yield* lifecycleEvents.publish({
    type: "welcome",
    payload: {
      cwd: config.cwd,
      homeDir: config.homeDir,
      chatWorkspaceRoot: config.chatWorkspaceRoot,
      studioWorkspaceRoot: config.studioWorkspaceRoot,
      projectName: config.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? config.cwd,
    },
  });
  yield* lifecycleEvents.publish({
    type: "ready",
    payload: { at: new Date().toISOString() },
  });

  if (!nodeServer) {
    return yield* new ServerLifecycleError({ operation: "httpServerListen" });
  }
  return nodeServer as http.Server;
});

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const shutdownController = yield* makeServerShutdownController();
    return {
      start: createEffectServer(shutdownController) as ServerShape["start"],
      stopSignal: shutdownController.stopSignal,
    } satisfies ServerShape;
  }),
);
