import { createHash } from "node:crypto";
import { containsCredentialLikeText } from "../metisMemory/memoryFiles.ts";
import { Effect, Schema } from "effect";
import { ProjectId, MetisMemoryWriteInput } from "@synara/contracts";
import type { MetisController } from "../metis/MetisController.ts";
import type { MetisMemoryShape } from "../metisMemory/Services/MetisMemory.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import type { ToolEntry } from "./toolRuntime.ts";

/** Cross-project memory is an instance-controller capability, not a change to
 * ordinary workers' project-scoped memory tools. */
export function makeMetisTools(
  controller: MetisController,
  memory: MetisMemoryShape,
): ReadonlyArray<ToolEntry> {
  return [
    {
      definition: {
        name: "metis_self",
        description:
          "Inspect the persistent Metis instance (overview). The active instance controller and its authorized remote controller chats can list all project memory indexes (memories), read a project memory (read_memory: projectId, name), and acknowledge a reflection only after verifying sources and saving any durable lessons (complete_reflection: batchId, summary). write_memory saves a project lesson with projectId, name, description, type and body. Existing synara_memory_* tools save global lessons; cite source thread/turn IDs. Read soul to get its revision; evolve_soul can revise lasting identity/principles with content, expectedRevision and an evidence-based reason. Prior content is retained in memory/history and stale edits are rejected. Do not turn transient task output into personality or authority. This does not grant other conversations controller authority.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "overview",
                "memories",
                "read_memory",
                "write_memory",
                "soul",
                "evolve_soul",
                "complete_reflection",
              ],
            },
            description: { type: "string", maxLength: 200 },
            type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
            body: { type: "string", maxLength: 16384 },
            content: { type: "string", maxLength: 32768 },
            expectedRevision: { type: "string" },
            reason: { type: "string", maxLength: 1000 },
            projectId: { type: "string" },
            name: { type: "string" },
            batchId: { type: "string" },
            summary: { type: "string", maxLength: 2000 },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      requiredCapability: "thread:read",
      handler: (args, context) =>
        Effect.gen(function* () {
          const action = args.action;
          if (action === "overview")
            return mcpToolResultJson(yield* Effect.promise(() => controller.overview()));
          const authorized = yield* Effect.promise(() =>
            controller.isController(context.callerThreadId),
          );
          if (!authorized)
            return mcpToolResultError(
              "Only this instance's active Metis controller can use this action.",
            );
          if (action === "soul") {
            const soul = yield* memory.readSoul();
            return mcpToolResultJson({
              ...soul,
              revision: createHash("sha256").update(soul.content).digest("hex"),
            });
          }
          if (action === "evolve_soul") {
            yield* context.assertCallerTurnActive();
            if (!context.callerCapabilities.has("thread:write"))
              return mcpToolResultError("thread:write is required.");
            if (
              typeof args.content !== "string" ||
              !args.content.trim() ||
              typeof args.expectedRevision !== "string" ||
              typeof args.reason !== "string" ||
              !args.reason.trim() ||
              args.reason.length > 1000
            )
              return mcpToolResultError(
                "content, expectedRevision from soul, and a short reason with evidence are required.",
              );
            if (containsCredentialLikeText(args.content) || containsCredentialLikeText(args.reason))
              return mcpToolResultError("Do not store credentials in soul.md.");
            const soul = yield* memory.writeSoul(args.content, args.expectedRevision);
            return mcpToolResultJson({
              saved: true,
              revision: createHash("sha256").update(soul.content).digest("hex"),
              reason: args.reason,
            });
          }
          if (action === "memories") {
            const overview = yield* memory.getOverview();
            return mcpToolResultJson({ global: overview.global, projects: overview.projects });
          }
          if (action === "read_memory") {
            const projectId = Schema.decodeUnknownSync(ProjectId)(args.projectId);
            if (typeof args.name !== "string") return mcpToolResultError("name is required.");
            return mcpToolResultJson(
              yield* memory.read({ scope: "project", projectId, name: args.name }),
            );
          }
          if (action === "write_memory") {
            yield* context.assertCallerTurnActive();
            if (!context.callerCapabilities.has("thread:write"))
              return mcpToolResultError("thread:write is required.");
            const input = Schema.decodeUnknownSync(MetisMemoryWriteInput)({
              scope: "project",
              projectId: args.projectId,
              name: args.name,
              description: args.description,
              type: args.type,
              body: args.body,
            });
            if (!input.projectId) return mcpToolResultError("projectId is required.");
            return mcpToolResultJson(
              yield* memory.write({
                ...input,
                body: `${input.body.trimEnd()}\n\n来源：Metis 总控会话 ${context.callerThreadId}；轮次 ${context.callerTurnId ?? "unknown"}。`,
                origin: "agent",
              }),
            );
          }
          if (action === "complete_reflection") {
            if (!context.callerCapabilities.has("thread:write"))
              return mcpToolResultError("thread:write is required.");
            yield* context.assertCallerTurnActive();
            if (
              typeof args.batchId !== "string" ||
              typeof args.summary !== "string" ||
              !args.summary.trim() ||
              args.summary.length > 2000
            )
              return mcpToolResultError(
                "batchId and a nonempty summary (up to 2000 characters) are required.",
              );
            return mcpToolResultJson(
              yield* Effect.tryPromise(() =>
                controller.completeReflection(
                  context.callerThreadId,
                  context.callerTurnId,
                  args.batchId as string,
                  args.summary as string,
                ),
              ),
            );
          }
          return mcpToolResultError("Unknown Metis action.");
        }).pipe(
          Effect.catch((error) => Effect.succeed(mcpToolResultError(String(error)))),
          Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(String(error)))),
        ),
    },
  ];
}
