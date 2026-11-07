import { afterEach, expect, it, vi } from "vitest";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import { createFeishuOutboundTransport } from "./FeishuOutbound.ts";
import { describeFeishuFailure } from "./feishuOutboundFailure.ts";

const mock = vi.hoisted(() => ({
  http: null as HttpInstance | null,
  request: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: 0 },
  LoggerLevel: { fatal: 0 },
  defaultHttpInstance: { request: mock.request },
  Client: class {
    constructor(options: { httpInstance: HttpInstance }) {
      mock.http = options.httpInstance;
    }
    im = { v1: {} };
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  mock.http = null;
});

it("bounds token and media HTTP requests without mutating global SDK defaults", async () => {
  await createFeishuOutboundTransport({ appId: "test", appSecret: "private" });
  mock.request.mockResolvedValue({ code: 0, data: { image_key: "img_test" } });
  await mock.http!.post("/token", { data: "test" });
  await mock.http!.request({ url: "/images", method: "POST", timeout: 0 });
  for (const [options] of mock.request.mock.calls) {
    expect(options.timeout).toBe(30_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});

it("preserves numeric business error codes before upload helpers discard them", async () => {
  await createFeishuOutboundTransport({ appId: "test", appSecret: "private" });
  mock.request.mockResolvedValue({ code: 99991672, msg: "private response", data: null });
  const error = await mock.http!.request({ url: "/images" }).catch((e: unknown) => e);
  expect(describeFeishuFailure(error)).toMatchObject({ apiCode: 99991672, retryable: false });
  expect(String(error)).not.toContain("private response");
});
