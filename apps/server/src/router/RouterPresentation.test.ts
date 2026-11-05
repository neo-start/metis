import { expect, it, vi } from "vitest";
import type { OrchestrationThread } from "@synara/contracts";
import {
  presentRouterResponse,
  routerResultFallback,
  routerResultInput,
} from "./RouterPresentation.ts";

it("bounds evidence and context without changing the conversation's provider", () => {
  const source = {
    modelSelection: { provider: "codexTertiary", model: "chosen-model" },
    messages: Array.from({ length: 20 }, () => ({ role: "user", text: "x".repeat(3000) })),
  } as unknown as OrchestrationThread;
  const input = routerResultInput("/private/empty", source, "Add MCP chat", {
    status: "completed",
    summary: "a".repeat(18000),
    error: null,
  });
  expect(input.modelSelection).toEqual(source.modelSelection);
  expect(input.responseMode).toBe("completion");
  const context = JSON.parse(input.taskContext);
  expect(context.result.summary).toHaveLength(16000);
  expect(context.result.summaryTruncated).toBe(true);
  expect(context.conversation).toHaveLength(8);
  expect(context.conversation[0].text).toHaveLength(2000);
});

it("accepts only a presentation reply and retains failure evidence on invalid output or timeout", async () => {
  const result = { status: "error", summary: "Only preflight passed", error: "Deployment failed" };
  const fallback = routerResultFallback(result);
  const input = {
    cwd: "/empty",
    message: "Deploy",
    taskContext: "{}",
    responseMode: "completion" as const,
  };
  const generate = vi.fn();
  for (const output of [
    { route: "queue", reply: "I'll deploy again" },
    { route: "reply", targetTaskId: "another-task", reply: "Changed target" },
    { route: "reply", reply: " " },
    { route: "reply", reply: "x".repeat(6001) },
  ]) {
    generate.mockResolvedValueOnce(output);
    expect(await presentRouterResponse(generate, input, fallback)).toBe(fallback);
  }
  generate.mockRejectedValueOnce(new Error("timeout"));
  expect(await presentRouterResponse(generate, input, fallback)).toContain("Deployment failed");
  generate.mockResolvedValueOnce({
    route: "reply",
    reply: "Preflight passed, but deployment failed.",
  });
  expect(await presentRouterResponse(generate, input, fallback)).toBe(
    "Preflight passed, but deployment failed.",
  );
  expect(routerResultFallback({ status: "completed", summary: null, error: null })).not.toContain(
    "已完成",
  );
});
