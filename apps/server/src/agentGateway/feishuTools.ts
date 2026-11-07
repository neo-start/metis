import { Effect } from "effect";
import { makeFeishuAttachmentSender } from "../feishu/feishuOutboundAttachments.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { readStringArg, ToolInputError } from "./toolInput.ts";
import { WRITE_TOOL_ANNOTATIONS, type ToolContext, type ToolEntry } from "./toolRuntime.ts";

export function makeFeishuTools(options: {
  baseDir: string;
  stateDir: string;
  resolveWorkspaceRoot: (context: ToolContext) => Effect.Effect<string | null>;
}): readonly ToolEntry[] {
  const send = makeFeishuAttachmentSender(options);
  return [
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_feishu_send_attachment",
        description:
          "Send an image or file to the private Feishu chat that requested this task. Use only when the user explicitly asks to send it. No recipient override. File must be inside this task's workspace (copy generated artifacts there first). Image limit 10 MiB; file limit 25 MiB. Reuse the same idempotencyKey for retries; an unknown outcome requires checking Feishu before a new send.",
        annotations: { ...WRITE_TOOL_ANNOTATIONS, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to the requested attachment.",
            },
            kind: { type: "string", enum: ["image", "file"] },
            idempotencyKey: {
              type: "string",
              description: "Stable delivery key, 1-128 letters, digits, underscores or hyphens.",
            },
          },
          required: ["path", "kind", "idempotencyKey"],
          additionalProperties: false,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const filePath = readStringArg(args, "path", { required: true })!;
          const kind = readStringArg(args, "kind", { required: true });
          if (kind !== "image" && kind !== "file")
            throw new ToolInputError("kind must be image or file.");
          const idempotencyKey = readStringArg(args, "idempotencyKey", { required: true })!;
          const workspaceRoot = yield* options.resolveWorkspaceRoot(context);
          if (!workspaceRoot) throw new ToolInputError("No workspace for this task.");
          const result = yield* Effect.tryPromise({
            try: () =>
              send(
                { threadId: context.callerThreadId, workspaceRoot, filePath, kind, idempotencyKey },
                () => Effect.runPromise(context.assertCallerTurnActive()),
              ),
            catch: (error) =>
              error instanceof Error ? error : new Error("Attachment delivery failed."),
          });
          return mcpToolResultJson(result);
        }).pipe(
          Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message))),
          Effect.catchDefect((error) =>
            Effect.succeed(
              mcpToolResultError(
                error instanceof ToolInputError ? error.message : "Invalid attachment request.",
              ),
            ),
          ),
        ),
    },
  ];
}
