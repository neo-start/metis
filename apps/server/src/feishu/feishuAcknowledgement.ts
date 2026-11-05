import {
  isRouterCancelRequest,
  isRouterGlobalStatusQuestion,
  isRouterGreeting,
  isRouterStatusQuestion,
} from "../router/AgentRouter.ts";

// Receipt wording makes no claim about classification, execution or completion.
export const FEISHU_RECEIVED_TEXT = "收到，我先看一下你的要求，处理好后回复你。";

export function needsFeishuRouterAcknowledgement(text: string, hasReference: boolean) {
  if (hasReference) return true;
  const action = /^(?:任务|task)\s+\S+\s+([\s\S]+)$/iu.exec(text.trim())?.[1] ?? text;
  return !(
    isRouterGreeting(text) ||
    isRouterGlobalStatusQuestion(text) ||
    isRouterStatusQuestion(action) ||
    isRouterCancelRequest(action)
  );
}
