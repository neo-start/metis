import { Schema } from "effect";
import { ModelSelection, RuntimeMode } from "./orchestration";
import { ThreadId } from "./baseSchemas";

const IdentityId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);

export const MetisReflectionSource = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  title: Schema.String,
});
export type MetisReflectionSource = typeof MetisReflectionSource.Type;
export const MetisIdentity = Schema.Struct({
  id: IdentityId,
  createdAt: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  growthEnabled: Schema.Boolean,
  lastReflectionAt: Schema.NullOr(Schema.String),
  reflection: Schema.NullOr(
    Schema.Struct({
      id: IdentityId,
      sources: Schema.Array(MetisReflectionSource),
      state: Schema.Literals(["pending", "running", "completed", "paused"]),
      summary: Schema.String,
    }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type MetisIdentity = typeof MetisIdentity.Type;
export const MetisControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("overview") }),
  Schema.Struct({
    action: Schema.Literal("open"),
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({
    action: Schema.Literal("clear"),
    sourceThreadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({ action: Schema.Literal("growth"), enabled: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("reflect") }),
]);
export type MetisControlInput = typeof MetisControlInput.Type;
