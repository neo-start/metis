import { expect, it } from "vitest";
import { routerResultFallback } from "./RouterPresentation.ts";

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
