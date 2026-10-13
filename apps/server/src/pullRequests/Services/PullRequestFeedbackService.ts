import type {
  PullRequestDeliveryInput,
  PullRequestDeliveryResult,
  PullRequestDeliveryState,
  PullRequestSetFeedbackEnabledInput,
} from "@synara/contracts";
import { ServiceMap, type Effect, type Scope } from "effect";

export interface PullRequestFeedbackServiceShape {
  readonly delivery: (
    input: PullRequestDeliveryInput,
  ) => Effect.Effect<PullRequestDeliveryResult, Error>;
  readonly setEnabled: (
    input: PullRequestSetFeedbackEnabledInput,
  ) => Effect.Effect<PullRequestDeliveryState, Error>;
  readonly poll: Effect.Effect<void, Error>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PullRequestFeedbackService extends ServiceMap.Service<
  PullRequestFeedbackService,
  PullRequestFeedbackServiceShape
>()("synara/pullRequests/Services/PullRequestFeedbackService") {}
