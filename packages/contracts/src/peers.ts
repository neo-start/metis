import { Schema } from "effect";

const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
export const PeerId = Schema.String.check(Schema.isPattern(/^metis-[a-f0-9]{32}$/));
export const PeerTaskState = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "error",
  "interrupted",
]);
export const PeerTask = Schema.Struct({
  id: Schema.String,
  peerId: PeerId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  text: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  sourceThreadId: Schema.NullOr(Schema.String),
  state: PeerTaskState,
  result: Schema.String,
  createdAt: Schema.String,
});
export type PeerTask = typeof PeerTask.Type;
export const PeerMessage = Schema.Struct({
  id: Schema.String,
  taskId: Schema.optional(Schema.String),
  peerId: PeerId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  text: Schema.String,
  delivered: Schema.Boolean,
  createdAt: Schema.String,
});
export type PeerMessage = typeof PeerMessage.Type;
export const PeerRemoteRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status"), taskId: Schema.optional(RequestId) }),
  Schema.Struct({
    action: Schema.Literal("message"),
    id: RequestId,
    text: Text,
    taskId: Schema.optional(RequestId),
  }),
  Schema.Struct({ action: Schema.Literal("task"), id: RequestId, text: Text }),
  Schema.Struct({ action: Schema.Literal("cancel"), taskId: RequestId }),
]);
export type PeerRemoteRequest = typeof PeerRemoteRequest.Type;
export const PeerRemoteReply = Schema.Struct({
  name: Schema.String,
  project: Schema.NullOr(Schema.String),
  tasks: Schema.Array(PeerTask),
  messages: Schema.Array(PeerMessage),
});
export type PeerRemoteReply = typeof PeerRemoteReply.Type;
export const PeerControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("overview") }),
  Schema.Struct({
    action: Schema.Literal("configure"),
    enabled: Schema.Boolean,
    name: Text,
    templateThreadId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("pair"),
    peerId: PeerId,
    address: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literals(["approve", "reject"]), requestId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("revoke"), peerId: PeerId }),
  Schema.Struct({ action: Schema.Literal("remote"), peerId: PeerId, request: PeerRemoteRequest }),
]);
export type PeerControlInput = typeof PeerControlInput.Type;
export const PeerOverview = Schema.Struct({
  instanceId: PeerId,
  name: Schema.String,
  enabled: Schema.Boolean,
  listeningPort: Schema.NullOr(Schema.Number),
  addresses: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  templateThreadId: Schema.NullOr(Schema.String),
  templates: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  nearby: Schema.Array(Schema.Struct({ id: PeerId, name: Schema.String, address: Schema.String })),
  peers: Schema.Array(
    Schema.Struct({
      id: PeerId,
      name: Schema.String,
      address: Schema.String,
      online: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  pending: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      peerId: PeerId,
      name: Schema.String,
      code: Schema.String,
      incoming: Schema.Boolean,
      expiresAt: Schema.Number,
    }),
  ),
  tasks: Schema.Array(PeerTask),
  messages: Schema.Array(PeerMessage),
});
export type PeerOverview = typeof PeerOverview.Type;
export const PeerControlResult = Schema.Struct({
  overview: PeerOverview,
  reply: Schema.NullOr(PeerRemoteReply),
});
export type PeerControlResult = typeof PeerControlResult.Type;
