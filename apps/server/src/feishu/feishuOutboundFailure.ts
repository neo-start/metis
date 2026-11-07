/** Only allowlisted metadata crosses the SDK boundary; never forward response bodies/headers. */
export function describeFeishuFailure(error: unknown) {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const value = record(error);
  const response = record(value.response);
  const data = record(response.data);
  const headers = record(response.headers);
  const retryAfter = headers["retry-after"];
  const retryAfterMs =
    typeof retryAfter === "string" || typeof retryAfter === "number"
      ? /^\d+(\.\d+)?$/.test(String(retryAfter))
        ? Number(retryAfter) * 1_000
        : Date.parse(String(retryAfter)) - Date.now()
      : NaN;
  const number = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input) ? input : undefined;
  const httpStatus = number(response.status);
  const apiCode = number(data.code) ?? number(value.code);
  const networkCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNABORTED",
    "EAI_AGAIN",
    "EPIPE",
    "ERR_CANCELED",
  ]);
  const networkCode =
    typeof value.code === "string" && networkCodes.has(value.code) ? value.code : undefined;
  const retryable =
    Boolean(networkCode) ||
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599);
  return {
    category:
      httpStatus === 401 || httpStatus === 403
        ? "permission_or_credentials"
        : httpStatus === 429
          ? "rate_limited"
          : networkCode
            ? "network_or_timeout"
            : retryable
              ? "service_unavailable"
              : "api_or_format_error",
    retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(apiCode !== undefined ? { apiCode } : {}),
    ...(networkCode !== undefined ? { networkCode } : {}),
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs: Math.max(0, retryAfterMs) } : {}),
  };
}

export class FeishuOutboundFailure extends Error {
  constructor(
    readonly stage: "upload" | "send",
    readonly requestId: string,
    readonly details: ReturnType<typeof describeFeishuFailure>,
  ) {
    super(
      stage === "upload"
        ? "Feishu attachment upload failed; no message was sent by this attempt. Check format, bot resource permissions, and the error code."
        : "Feishu send did not return a confirmed message ID. Delivery may already have occurred. Check status and retry only with the same requestId.",
    );
  }
  toResult() {
    return {
      requestId: this.requestId,
      stage: this.stage,
      delivery: this.stage === "send" ? "unknown" : "not_sent",
      ...this.details,
      message: this.message,
    };
  }
}
