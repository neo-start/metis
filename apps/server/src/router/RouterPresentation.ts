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
