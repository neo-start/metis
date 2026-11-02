import { Schema } from "effect";
import { IsoDateTime } from "./baseSchemas";

export const THOUGHT_BODY_MAX_BYTES = 16 * 1_024;
export const THOUGHT_ID_PATTERN = "^[a-zA-Z0-9_-]{1,80}$";
const ThoughtId = Schema.String.check(Schema.isPattern(new RegExp(THOUGHT_ID_PATTERN)));
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export const Thought = Schema.Struct({
  id: ThoughtId,
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revision: Revision,
  origin: Schema.Literals(["user", "agent"]),
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceTurnId: Schema.NullOr(Schema.String),
});
export type Thought = typeof Thought.Type;

export const ThoughtListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  from: Schema.optional(IsoDateTime),
  to: Schema.optional(IsoDateTime),
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
});
export type ThoughtListInput = typeof ThoughtListInput.Type;
export const ThoughtListResult = Schema.Struct({
  entries: Schema.Array(Thought),
  total: Schema.Number,
  nextOffset: Schema.NullOr(Schema.Number),
});
export type ThoughtListResult = typeof ThoughtListResult.Type;
export const ThoughtReadInput = Schema.Struct({ id: ThoughtId });
export type ThoughtReadInput = typeof ThoughtReadInput.Type;
export const ThoughtCreateInput = Schema.Struct({
  /** Stable client-generated ID: reuse it when retrying an uncertain save. */
  id: ThoughtId,
  body: Schema.String.check(Schema.isMaxLength(THOUGHT_BODY_MAX_BYTES)),
});
export type ThoughtCreateInput = typeof ThoughtCreateInput.Type;
export const ThoughtUpdateInput = Schema.Struct({
  ...ThoughtCreateInput.fields,
  expectedRevision: Revision,
});
export type ThoughtUpdateInput = typeof ThoughtUpdateInput.Type;
export const ThoughtDeleteInput = Schema.Struct({
  ...ThoughtReadInput.fields,
  expectedRevision: Revision,
});
export type ThoughtDeleteInput = typeof ThoughtDeleteInput.Type;
export const ThoughtDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type ThoughtDeleteResult = typeof ThoughtDeleteResult.Type;
