import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { expect, it, vi } from "vitest";
import { FeishuOutbound, type FeishuOutboundTransport } from "../feishu/FeishuOutbound.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import { describeFeishuFailure, FeishuOutboundFailure } from "../feishu/feishuOutboundFailure.ts";
import { makeFeishuTools } from "./feishuTools.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  jsonRpcRequestId: 1,
  assertCallerTurnActive: () => Effect.void,
};

function fixture() {
  const send = vi
    .fn<FeishuOutbound["send"]>()
    .mockResolvedValue({ messageId: "om_test", kind: "image", replayed: false });
  const status = vi.fn<FeishuOutbound["status"]>();
  const tools = makeFeishuTools({ send, status }, () => Effect.succeed("/workspace"));
  return { send, status, tool: tools[0]!, statusTool: tools[1]! };
}

it("uses the caller's workspace and active-turn authorization for outbound sends", async () => {
  const { send, tool } = fixture();
  const input = { kind: "image", path: "shot.png", requestId: "screenshot-1" };
  const result = await Effect.runPromise(tool.handler(input, context));
  expect(result.isError).not.toBe(true);
  expect(tool.requiresActiveTurn).toBe(true);
  expect(tool.requiredCapability).toBe("thread:write");
  expect(send).toHaveBeenCalledWith(input, {
    threadId: "thread",
    workspaceRoot: "/workspace",
    assertActive: expect.any(Function),
  });
  await send.mock.calls[0]![1].assertActive();
});

it("returns actionable send failures without SDK credentials or response bodies", async () => {
  const { send, tool } = fixture();
  send.mockRejectedValue(
    new FeishuOutboundFailure(
      "send",
      "r",
      describeFeishuFailure({
        response: { status: 403, data: { code: 999, secret: "private-key" } },
        config: { appSecret: "private-key" },
      }),
    ),
  );
  const result = await Effect.runPromise(
    tool.handler({ kind: "text", text: "hello", requestId: "r" }, context),
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    stage: "send",
    delivery: "unknown",
    requestId: "r",
    retryable: false,
    httpStatus: 403,
    apiCode: 999,
  });
  expect(JSON.stringify(result)).not.toContain("private-key");
});

it("queries only the caller's receipt without sending or requiring an active turn", async () => {
  const { send, status, statusTool } = fixture();
  status.mockResolvedValue({
    requestId: "r",
    state: "confirmed",
    inProgress: false,
    messageId: "om_test",
    nextAction: "Already confirmed",
  });
  const result = await Effect.runPromise(statusTool.handler({ requestId: "r" }, context));
  expect(result.isError).not.toBe(true);
  expect(statusTool.requiredCapability).toBe("thread:read");
  expect(statusTool.definition.annotations?.readOnlyHint).toBe(true);
  expect(status).toHaveBeenCalledWith("r", { threadId: "thread" });
  expect(send).not.toHaveBeenCalled();
});

it("reports unreadable receipts as unknown without leaking storage errors", async () => {
  const { status, statusTool } = fixture();
  status.mockRejectedValue(new Error("private storage detail"));
  const result = await Effect.runPromise(statusTool.handler({ requestId: "r" }, context));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("unknown");
  expect(JSON.stringify(result)).not.toContain("private storage detail");
});

it.each([{}, { kind: "image", requestId: 42 }, { kind: "image", requestId: "r", path: 42 }])(
  "returns invalid input as a tool error without sending: %j",
  async (input) => {
    const { send, tool } = fixture();
    expect((await Effect.runPromise(tool.handler(input, context))).isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  },
);

it("rejects inactive calls before sender access", async () => {
  const { send, tool } = fixture();
  const result = await Effect.runPromise(
    tool.handler(
      { kind: "text", text: "hello", requestId: "r" },
      {
        ...context,
        assertCallerTurnActive: () => Effect.fail(new GatewayToolError("inactive", "Inactive")),
      },
    ),
  );
  expect(result.isError).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

function runtimeBinding(overrides: Partial<ProviderRuntimeBinding> = {}): ProviderRuntimeBinding {
  return {
    threadId: ThreadId.makeUnsafe(context.callerThreadId),
    provider: context.callerProvider,
    status: "running",
    runtimePayload: { cwd: "/workspace/scratch-thread" },
    ...overrides,
  };
}

it("sends a chat scratch image and records a receipt while rejecting sibling files and symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-feishu-chat-"));
  try {
    const cwd = path.join(root, "scratch-thread");
    await mkdir(cwd);
    await writeFile(
      path.join(root, "feishu-app.json"),
      JSON.stringify({
        appId: "cli_test",
        appSecret: "private-test-secret",
        allowedOpenIds: ["ou_owner"],
      }),
    );
    await writeFile(path.join(cwd, "shot.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(path.join(root, "sibling.png"), "another thread's file");
    await symlink(path.join(root, "sibling.png"), path.join(cwd, "escape.png"));
    const transport = {
      uploadImage: vi.fn<FeishuOutboundTransport["uploadImage"]>().mockResolvedValue("img_test"),
      uploadFile: vi.fn<FeishuOutboundTransport["uploadFile"]>(),
      send: vi.fn<FeishuOutboundTransport["send"]>().mockResolvedValue("om_test"),
    };
    const sender = new FeishuOutbound(root, path.join(root, "receipts"), async () => transport);
    const projectId = ProjectId.makeUnsafe("chat-project");
    const projectCwd = resolveThreadWorkspaceCwd({
      thread: { projectId, worktreePath: null },
      projects: [{ id: projectId, kind: "chat", workspaceRoot: root }],
    });
    expect(projectCwd).toBeUndefined();
    const getBinding = vi.fn(() =>
      Effect.succeed(Option.some(runtimeBinding({ runtimePayload: { cwd } }))),
    );
    const [tool] = makeFeishuTools(sender, () => Effect.succeed(projectCwd ?? null), {
      getBinding,
    });
    const input = { kind: "image", path: "shot.png", requestId: "chat-shot" };
    const sent = await Effect.runPromise(tool!.handler(input, context));
    expect(sent, JSON.stringify(sent)).not.toHaveProperty("isError", true);
    expect(getBinding).toHaveBeenCalledWith(context.callerThreadId);
    expect(await sender.status("chat-shot", { threadId: context.callerThreadId })).toMatchObject({
      state: "confirmed",
      messageId: "om_test",
    });
    // Retry with the same request ID keeps the existing successful receipt.
    expect((await Effect.runPromise(tool!.handler(input, context))).isError).not.toBe(true);
    for (const file of ["../sibling.png", path.join(root, "sibling.png"), "escape.png"]) {
      const result = await Effect.runPromise(
        tool!.handler({ ...input, path: file, requestId: file }, context),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("outside the active workspace");
    }
    expect(transport.uploadImage).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  runtimeBinding({ threadId: ThreadId.makeUnsafe("other-thread") }),
  runtimeBinding({ provider: "claudeAgent" }),
  runtimeBinding({ status: "stopped" }),
  runtimeBinding({ runtimePayload: null }),
  runtimeBinding({ runtimePayload: { cwd: "" } }),
  runtimeBinding({ runtimePayload: { cwd: "relative/path" } }),
])(
  "does not invent a workspace from a missing, stale, foreign or invalid runtime binding: %j",
  async (binding) => {
    const { send, status } = fixture();
    const [tool] = makeFeishuTools({ send, status }, () => Effect.succeed(null), {
      getBinding: () => Effect.succeed(Option.fromUndefinedOr(binding)),
    });
    await Effect.runPromise(
      tool!.handler({ kind: "image", path: "/arbitrary/shot.png", requestId: "r" }, context),
    );
    expect(send.mock.calls[0]![1].workspaceRoot).toBeNull();
  },
);

it("keeps the canonical workspace and lets text send without any workspace lookup", async () => {
  const { send, status } = fixture();
  const canonical = vi.fn(() => Effect.succeed("/project/worktree"));
  const getBinding = vi.fn(() => Effect.succeed(Option.some(runtimeBinding())));
  const [tool] = makeFeishuTools({ send, status }, canonical, { getBinding });
  await Effect.runPromise(
    tool!.handler({ kind: "image", path: "shot.png", requestId: "r" }, context),
  );
  expect(send.mock.calls[0]![1].workspaceRoot).toBe("/project/worktree");
  await Effect.runPromise(
    tool!.handler({ kind: "text", text: "hello", requestId: "text" }, context),
  );
  expect(canonical).toHaveBeenCalledTimes(1);
  expect(getBinding).not.toHaveBeenCalled();
});
