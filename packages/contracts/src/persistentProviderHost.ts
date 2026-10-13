/** Local, authenticated persistent Codex host protocol. Not a public network API. */
import { Schema } from "effect";
import { ThreadId } from "./baseSchemas";
import { ProviderInteractionMode, ProviderStartOptions, RuntimeMode } from "./orchestration";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import { ProviderEvent, ProviderSession } from "./provider";

export const PERSISTENT_PROVIDER_HOST_VERSION = 1;
export const PERSISTENT_PROVIDER_HOST_ABI = "metis-codex-native-1";
export const PERSISTENT_PROVIDER_HOST_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const PersistentHostDescriptor = Schema.Struct({
  version: Schema.Literal(PERSISTENT_PROVIDER_HOST_VERSION),
  abi: Schema.Literal(PERSISTENT_PROVIDER_HOST_ABI),
  instanceId: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
  port: Schema.Number,
});
export type PersistentHostDescriptor = typeof PersistentHostDescriptor.Type;
export const PersistentHostMethod = Schema.Literals([
  "startSession",
  "sendTurn",
  "steerTurn",
  "interruptTurn",
  "abandonTurn",
  "respondToRequest",
  "respondToUserInput",
  "readThread",
  "stopSession",
  "stopAll",
  "compactThread",
  "rollbackThread",
]);
export type PersistentHostMethod = typeof PersistentHostMethod.Type;
export const PersistentHostRequest = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals([
    "attach",
    "snapshot",
    "call",
    "events",
    "ack",
    "forget",
    "detach",
    "terminate",
  ]),
  version: Schema.optionalKey(Schema.Number),
  instanceId: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
  lease: Schema.optionalKey(Schema.String),
  operationId: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(PersistentHostMethod),
  args: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  sequence: Schema.optionalKey(Schema.Number),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PersistentHostRequest = typeof PersistentHostRequest.Type;
export const PersistentHostResponse = Schema.Struct({
  id: Schema.String,
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
export type PersistentHostResponse = typeof PersistentHostResponse.Type;
export const PersistentHostSnapshot = Schema.Struct({
  instanceId: Schema.String,
  hostPid: Schema.Number,
  acknowledgedSequence: Schema.Number,
  latestSequence: Schema.Number,
  failure: Schema.NullOr(Schema.String),
  sessions: Schema.Array(
    Schema.Struct({
      session: ProviderSession,
      providerPid: Schema.Number,
      sessionAttemptId: Schema.String,
      lifecycleGeneration: Schema.optionalKey(Schema.String),
      routable: Schema.Boolean,
      awaitingHuman: Schema.Boolean,
    }),
  ),
  operations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      method: PersistentHostMethod,
      state: Schema.Literals(["pending", "completed", "failed", "acknowledged"]),
    }),
  ),
});
export type PersistentHostSnapshot = typeof PersistentHostSnapshot.Type;
export const PersistentHostEvent = Schema.Struct({ sequence: Schema.Number, event: ProviderEvent });
export type PersistentHostEvent = typeof PersistentHostEvent.Type;

// Native-only is explicit: an application cannot accidentally drop its gateway lease.
export const PersistentCodexStartInput = Schema.Struct({
  threadId: ThreadId,
  lifecycleGeneration: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  serviceTier: Schema.optionalKey(Schema.String),
  resumeCursor: Schema.optionalKey(Schema.Unknown),
  forkSourceResumeCursor: Schema.optionalKey(Schema.Unknown),
  providerOptions: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  gatewayMode: Schema.Literal("native-only"),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PersistentCodexStartInput = typeof PersistentCodexStartInput.Type;
export const PersistentCodexTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("image"), url: Schema.String }),
        Schema.Struct({ type: Schema.Literal("localImage"), path: Schema.String }),
      ]),
    ),
  ),
  skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  model: Schema.optionalKey(Schema.String),
  serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.String),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PersistentCodexTurnInput = typeof PersistentCodexTurnInput.Type;
