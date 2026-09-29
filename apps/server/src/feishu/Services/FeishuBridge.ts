import { Effect, Scope, ServiceMap } from "effect";

export interface FeishuBridgeShape {
  /** Connect to Feishu (long connection) when configured; a no-op otherwise. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class FeishuBridge extends ServiceMap.Service<FeishuBridge, FeishuBridgeShape>()(
  "metis/feishu/Services/FeishuBridge",
) {}
