import type { OrchestrationThread } from "@synara/contracts";
import { Schema } from "effect";
import { RouterDecision } from "../git/routerPrompt.ts";
import type {
  RouterGenerationInput,
  RouterGenerationResult,
} from "../git/Services/TextGeneration.ts";

export interface RouterResult {
  status: string;
  summary: string | null;
  error: string | null;
  summaryTruncated?: boolean;
}

export function routerResultFallback(result: RouterResult) {
  const prefix =
    result.status === "error"
      ? "处理时遇到了问题，尚未确认完成。"
      : result.status === "interrupted"
        ? "这次处理已中断，以下是已有的结果。"
        : "";
  return [prefix, result.error, result.summary || (!result.error ? "还没有可汇报的最终结果。" : "")]
    .filter(Boolean)
    .join("\n\n");
}

export function routerResultInput(
  cwd: string,
  source: OrchestrationThread,
  request: string,
  result: RouterResult,
): RouterGenerationInput {
  return {
    cwd,
    modelSelection: source.modelSelection,
    message: request.slice(0, 16000),
    responseMode: "completion",
    taskContext: JSON.stringify({
      result: {
        ...result,
        summary: result.summary?.slice(0, 16000),
        error: result.error?.slice(0, 2000),
        summaryTruncated: result.summaryTruncated || (result.summary?.length ?? 0) > 16000,
      },
      conversation: source.messages
        .slice(-8)
        .map(({ role, text }) => ({ role, text: text.slice(-2000) })),
    }),
  };
}

/** Presentation cannot select actions; failures stay visible to the durable owner. */
export async function presentRouterResponse(
  generate: (input: RouterGenerationInput) => Promise<RouterGenerationResult>,
  input: RouterGenerationInput,
): Promise<string> {
  const response = Schema.decodeUnknownSync(RouterDecision)(await generate(input));
  if (response.route !== "reply" || response.targetTaskId || !response.reply.trim())
    throw new Error("Router returned an invalid presentation; no replacement template was used.");
  return response.reply.trim();
}
