import { expect, it, vi } from "vitest";
import { routerResultFallback, presentRouterResponse } from "./RouterPresentation.ts";

it("preserves the complete answer and its evidence without another generation", () => {
  const summary = "Details. ".repeat(400) + "Not deployed. [report](/tmp/report.md)";
  expect(routerResultFallback({ status: "completed", summary, error: null })).toBe(summary);
});

it("retains error and interruption evidence without claiming completion", () => {
  expect(
    routerResultFallback({
      status: "error",
      summary: "Preflight passed",
      error: "Deployment failed",
    }),
  ).toBe("处理时遇到了问题，尚未确认完成。\n\nDeployment failed\n\nPreflight passed");
  expect(
    routerResultFallback({ status: "interrupted", summary: "Partial result", error: null }),
  ).toContain("已中断");
  expect(routerResultFallback({ status: "completed", summary: null, error: null })).not.toContain(
    "已完成",
  );
});

it("rejects invalid presentation or model failure rather than sending a fixed fallback", async () => {
  const input = {
    cwd: "/empty",
    message: "进度",
    taskContext: "{}",
    responseMode: "status" as const,
  };
  const generate = vi.fn();
  for (const result of [
    { route: "queue", reply: "another task" },
    { route: "reply", targetTaskId: "other", reply: "changed target" },
    { route: "reply", reply: " " },
  ]) {
    generate.mockResolvedValueOnce(result);
    await expect(presentRouterResponse(generate, input)).rejects.toThrow();
  }
  generate.mockRejectedValueOnce(new Error("offline"));
  await expect(presentRouterResponse(generate, input)).rejects.toThrow("offline");
  generate.mockResolvedValueOnce({ route: "reply", reply: "接口测试已通过，UI 验证仍未完成。" });
  expect(await presentRouterResponse(generate, input)).toContain("UI 验证仍未完成");
});
