import { Schema } from "effect";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  OrchestrationThread,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "./orchestration";
import { UserInputQuestion } from "./providerRuntime";

const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
export const PEER_ATTACHMENT_CHUNK_BYTES = 96 * 1024;
export const PEER_ATTACHMENT_CAPABILITY = "chat-attachments-v1";
export const PeerChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type PeerChatAttachment = typeof PeerChatAttachment.Type;
const AttachmentId = Schema.String.check(Schema.isPattern(/^att_v2_[a-f0-9]{32}$/));
const AttachmentOffset = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
);
export const PeerId = Schema.String.check(Schema.isPattern(/^metis-[a-f0-9]{32}$/));
export const PeerTaskState = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "error",
  "interrupted",
]);
// Optional additive fields keep version-1 paired devices readable.
export const PeerTaskAttention = Schema.Struct({
  kind: Schema.Literals(["approval", "userInput"]),
  requestId: Schema.String,
  lifecycleGeneration: Schema.NullOr(Schema.String),
  responseAttemptId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  detail: Schema.String,
  questions: Schema.Array(UserInputQuestion),
});
export type PeerTaskAttention = typeof PeerTaskAttention.Type;
export const PeerTaskResponse = Schema.Struct({
  action: Schema.Literal("respond"),
  taskId: RequestId,
  requestId: Schema.String,
  lifecycleGeneration: Schema.NullOr(Schema.String),
  responseAttemptId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  response: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("approval"),
      decision: Schema.Literals(["accept", "decline", "cancel"]),
    }),
    Schema.Struct({ kind: Schema.Literal("userInput"), answers: ProviderUserInputAnswers }),
  ]),
});
export type PeerTaskResponse = typeof PeerTaskResponse.Type;
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
  updatedAt: Schema.optional(Schema.String),
  // Transport receipt and execution observation are deliberately independent.
  syncedAt: Schema.optional(Schema.String),
  observedAt: Schema.optional(Schema.String),
  observationAgeMs: Schema.optional(
    Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  stale: Schema.optional(Schema.Boolean),
  attention: Schema.optional(Schema.Array(PeerTaskAttention)),
  localRecovery: Schema.optional(
    Schema.Array(
      Schema.Struct({
        requestId: Schema.String,
        status: Schema.Literals(["responding", "uncertain"]),
      }),
    ),
  ),
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
export const PeerChatRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("chat.attachment.read"),
    chatId: RequestId,
    attachmentId: AttachmentId,
    offset: AttachmentOffset,
  }),
  Schema.Struct({
    action: Schema.Literal("chat.attachment.begin"),
    chatId: RequestId,
    type: Schema.Literals(["image", "file"]),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
    mimeType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    sizeBytes: AttachmentOffset.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.attachment.chunk"),
    chatId: RequestId,
    attachmentId: AttachmentId,
    offset: AttachmentOffset,
    data: Schema.String.check(Schema.isMaxLength((PEER_ATTACHMENT_CHUNK_BYTES * 4) / 3)),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.attachment.finish"),
    chatId: RequestId,
    attachmentId: AttachmentId,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.attachment.cancel"),
    chatId: RequestId,
    attachmentId: AttachmentId,
  }),
  Schema.Struct({ action: Schema.Literal("chat.list") }),
  Schema.Struct({ action: Schema.Literal("chat.open"), id: RequestId, title: Text }),
  Schema.Struct({
    action: Schema.Literal("chat.read"),
    chatId: RequestId,
    before: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.send"),
    chatId: RequestId,
    id: RequestId,
    text: Schema.String.check(Schema.isMaxLength(32000)),
    attachments: Schema.optional(
      Schema.Array(PeerChatAttachment).check(
        Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
      ),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.stop"),
    chatId: RequestId,
    id: RequestId,
    turnId: RequestId,
  }),
  Schema.Struct({
    action: Schema.Literal("chat.rename"),
    chatId: RequestId,
    id: RequestId,
    title: Text,
  }),
  Schema.Struct({ action: Schema.Literal("chat.archive"), chatId: RequestId, id: RequestId }),
  Schema.Struct({
    action: Schema.Literal("chat.async-answer"),
    chatId: RequestId,
    id: RequestId,
    messageId: Schema.String,
    answers: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("chat.approval"),
    chatId: RequestId,
    id: RequestId,
    requestId: Schema.String,
    lifecycleGeneration: Schema.optional(Schema.String),
    decision: ProviderApprovalDecision,
  }),
  Schema.Struct({
    action: Schema.Literal("chat.answer"),
    chatId: RequestId,
    id: RequestId,
    requestId: Schema.String,
    lifecycleGeneration: Schema.optional(Schema.String),
    answers: ProviderUserInputAnswers,
  }),
]);
export type PeerChatRequest = typeof PeerChatRequest.Type;
export const PeerChat = Schema.Struct({
  id: RequestId,
  title: Schema.String,
  createdAt: Schema.String,
});
export type PeerChat = typeof PeerChat.Type;
export const PeerChatReply = Schema.Struct({
  attachment: Schema.optional(PeerChatAttachment),
  attachmentData: Schema.optional(
    Schema.String.check(Schema.isMaxLength((PEER_ATTACHMENT_CHUNK_BYTES * 4) / 3)),
  ),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  controllerId: Schema.String,
  chats: Schema.Array(PeerChat),
  chatId: Schema.optional(RequestId),
  thread: Schema.optional(OrchestrationThread),
  revision: Schema.optional(Schema.String),
  before: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PeerChatReply = typeof PeerChatReply.Type;
export function isPeerChatRequest(request: PeerRemoteRequest): request is PeerChatRequest {
  return request.action.startsWith("chat.");
}
export const PeerRemoteRequest = Schema.Union([
  PeerChatRequest,
  PeerTaskResponse,
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
  chatProtocol: Schema.optional(Schema.Literal(1)),
  chat: Schema.optional(PeerChatReply),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.String,
  project: Schema.NullOr(Schema.String),
  tasks: Schema.Array(PeerTask),
  messages: Schema.Array(PeerMessage),
});
export type PeerRemoteReply = typeof PeerRemoteReply.Type;
export const PeerProjectUpdate = Schema.Struct({
  peerId: PeerId,
  repositoryPath: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.Literals([
    "watching",
    "pending",
    "sent",
    "running",
    "waiting",
    "completed",
    "error",
  ]),
  lastCommit: Schema.NullOr(Schema.String),
  chatId: Schema.NullOr(Schema.String),
  result: Schema.String,
  error: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PeerProjectUpdate = typeof PeerProjectUpdate.Type;
export const PeerControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("overview") }),
  Schema.Struct({
    action: Schema.Literal("project-updates.configure"),
    peerId: PeerId,
    enabled: Schema.Boolean,
    repositoryPath: Text,
  }),
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
      lastSeenAt: Schema.optional(Schema.String),
      capabilities: Schema.optional(Schema.Array(Schema.String)),
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
  projectUpdates: Schema.optional(Schema.Array(PeerProjectUpdate)),
  projectUpdateRepositoryPath: Schema.optional(Schema.String),
});
export type PeerOverview = typeof PeerOverview.Type;
export const PeerControlResult = Schema.Struct({
  overview: PeerOverview,
  reply: Schema.NullOr(PeerRemoteReply),
});
export type PeerControlResult = typeof PeerControlResult.Type;
