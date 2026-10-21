import { ServiceMap } from "effect";

import type { ClaudeAdapterShape } from "./ClaudeAdapter.ts";

/** An independent Claude SDK runtime whose model requests use OpenRouter. */
export interface ClaudeOpenRouterAdapterShape extends Omit<ClaudeAdapterShape, "provider"> {
  readonly provider: "claudeOpenRouter";
}

export class ClaudeOpenRouterAdapter extends ServiceMap.Service<
  ClaudeOpenRouterAdapter,
  ClaudeOpenRouterAdapterShape
>()("synara/provider/Services/ClaudeOpenRouterAdapter") {}
