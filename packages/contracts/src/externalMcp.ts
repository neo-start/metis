import { Schema } from "effect";

import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { AsyncUserInputResponse } from "./asyncUserInput";
import {
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "./orchestration";

export const EXTERNAL_MCP_AUDIENCE = "synara.external-mcp" as const;
export const EXTERNAL_MCP_MAX_PROMPT_CHARS = 100_000;
export const EXTERNAL_MCP_MAX_REQUEST_ID_LENGTH = 256;
export const EXTERNAL_MCP_DEFAULT_WAIT_MS = 30_000;
export const EXTERNAL_MCP_MAX_WAIT_MS = 60_000;
export const EXTERNAL_MCP_CREATE_TIMEOUT_MS = 10 * 60_000;
export const EXTERNAL_MCP_MAX_MESSAGE_CHARS = 10_000;

export const ExternalMcpCapability = Schema.Literals([
  "projects:read",
  "tasks:create",
  "tasks:wait",
  "tasks:read",
  "tasks:read-project",
  "tasks:follow-up",
  "tasks:answer",
  "tasks:approve",
  "tasks:approve-session",
  "tasks:cancel",
  "runtime:local",
  "runtime:full-access",
  "computer:control",
]);
export type ExternalMcpCapability = typeof ExternalMcpCapability.Type;

export const ExternalMcpClientKind = Schema.Literals([
  "codex",
  "claudeCode",
  "claudeDesktop",
  "other",
]);
export type ExternalMcpClientKind = typeof ExternalMcpClientKind.Type;

// "all" grants every current AND future project; the effective project set is
// recomputed on every request, so newly added projects are visible immediately.
export const ExternalMcpProjectScope = Schema.Literals(["all", "selected"]);
export type ExternalMcpProjectScope = typeof ExternalMcpProjectScope.Type;

export const ExternalMcpIntegrationId = TrimmedNonEmptyString;
export type ExternalMcpIntegrationId = typeof ExternalMcpIntegrationId.Type;

export const ExternalMcpProjectGrant = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type ExternalMcpProjectGrant = typeof ExternalMcpProjectGrant.Type;

export const ExternalMcpStdioConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ExternalMcpStdioConfiguration = typeof ExternalMcpStdioConfiguration.Type;

export const ExternalMcpIntegration = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  audience: Schema.Literal(EXTERNAL_MCP_AUDIENCE),
  capabilities: Schema.Array(ExternalMcpCapability),
  projectScope: Schema.optional(ExternalMcpProjectScope).pipe(
    Schema.withDecodingDefault(() => "selected"),
  ),
  allowedProjects: Schema.Array(ExternalMcpProjectGrant),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  pairedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  rateLimitPerMinute: Schema.Int,
  concurrencyLimit: Schema.Int,
  clientKind: ExternalMcpClientKind,
  stdio: ExternalMcpStdioConfiguration,
});
export type ExternalMcpIntegration = typeof ExternalMcpIntegration.Type;

export const ExternalMcpCreateIntegrationInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  // With projectScope "all" the project list is ignored; with "selected"
  // (the default) the service requires at least one project id.
  projectScope: Schema.optional(ExternalMcpProjectScope),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  capabilities: Schema.Array(ExternalMcpCapability)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(16)),
  expiresInDays: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(365)),
  ),
  clientKind: Schema.optional(ExternalMcpClientKind),
});
export type ExternalMcpCreateIntegrationInput = typeof ExternalMcpCreateIntegrationInput.Type;

export const ExternalMcpCreateIntegrationResult = Schema.Struct({
  integration: ExternalMcpIntegration,
  pairingCode: TrimmedNonEmptyString,
  pairingExpiresAt: IsoDateTime,
  setupCommand: TrimmedNonEmptyString,
  stdio: ExternalMcpStdioConfiguration,
});
export type ExternalMcpCreateIntegrationResult = typeof ExternalMcpCreateIntegrationResult.Type;

export const ExternalMcpRevokeIntegrationInput = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
});
export type ExternalMcpRevokeIntegrationInput = typeof ExternalMcpRevokeIntegrationInput.Type;

export const ExternalMcpRefreshPairingInput = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
});
export type ExternalMcpRefreshPairingInput = typeof ExternalMcpRefreshPairingInput.Type;

export const ExternalMcpPairInput = Schema.Struct({
  pairingCode: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type ExternalMcpPairInput = typeof ExternalMcpPairInput.Type;

export const ExternalMcpPairResult = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ExternalMcpPairResult = typeof ExternalMcpPairResult.Type;

export const ExternalMcpCreateTaskInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_REQUEST_ID_LENGTH)),
  projectId: ProjectId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_PROMPT_CHARS)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  runtimeMode: Schema.optional(RuntimeMode),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  // Requires the "computer:control" integration capability. Created tasks get
  // the computer tool family with per-action approval gating unchanged.
  enableComputerControl: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpCreateTaskInput = typeof ExternalMcpCreateTaskInput.Type;

export const ExternalMcpReadTaskInput = Schema.Struct({
  threadId: ThreadId,
  cursor: Schema.optional(Schema.String),
  messageLimit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  maxMessageChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(50)).check(
      Schema.isLessThanOrEqualTo(EXTERNAL_MCP_MAX_MESSAGE_CHARS),
    ),
  ),
  messageIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  messageOffsetChars: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  messageId: Schema.optional(MessageId),
  messageVersion: Schema.optional(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpReadTaskInput = typeof ExternalMcpReadTaskInput.Type;

export const ExternalMcpWaitTaskInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(EXTERNAL_MCP_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpWaitTaskInput = typeof ExternalMcpWaitTaskInput.Type;

// Keep requestId and requestedAt unchanged when retrying: the engine persists
// fingerprints and receipts; no second task-control event store is introduced.
const TaskMutationFields = {
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_REQUEST_ID_LENGTH)),
  threadId: ThreadId,
  requestedAt: IsoDateTime.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
  ),
};

export const ExternalMcpFollowUpTaskInput = Schema.Struct({
  ...TaskMutationFields,
  expectedUpdatedAt: IsoDateTime,
  expectedRuntimeMode: RuntimeMode,
  expectedInteractionMode: ProviderInteractionMode,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_PROMPT_CHARS)),
  asyncUserInputResponse: Schema.optional(AsyncUserInputResponse),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpFollowUpTaskInput = typeof ExternalMcpFollowUpTaskInput.Type;

const TaskInteractionFields = {
  ...TaskMutationFields,
  interactionId: ApprovalRequestId,
  lifecycleGeneration: Schema.NullOr(TrimmedNonEmptyString),
};

export const ExternalMcpAnswerTaskInput = Schema.Struct({
  ...TaskInteractionFields,
  answers: ProviderUserInputAnswers,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpAnswerTaskInput = typeof ExternalMcpAnswerTaskInput.Type;

export const ExternalMcpApproveTaskInput = Schema.Struct({
  ...TaskInteractionFields,
  decision: ProviderApprovalDecision,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpApproveTaskInput = typeof ExternalMcpApproveTaskInput.Type;

export const ExternalMcpCancelTaskInput = Schema.Struct({
  ...TaskMutationFields,
  runId: TurnId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpCancelTaskInput = typeof ExternalMcpCancelTaskInput.Type;
