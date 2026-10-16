import { ProjectId, ThreadId, type ExternalMcpCapability } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ExternalMcpError, type ExternalMcpVerifiedClient } from "./Services/ExternalMcpService.ts";
import type { ExternalMcpTaskRecord } from "./Services/ExternalMcpRepository.ts";
import { externalTaskControlAuthority } from "./taskControlAuthority.ts";

const THREAD = ThreadId.makeUnsafe("task");
function fixture(
  options: { owned?: boolean; allowed?: boolean; moved?: boolean; failed?: boolean } = {},
) {
  const client = {
    integration: { integrationId: "owner" },
    capabilities: new Set<ExternalMcpCapability>(["tasks:read-project", "tasks:cancel"]),
    allowedProjectIds: new Set(options.allowed === false ? [] : ["project"]),
  } as unknown as ExternalMcpVerifiedClient;
  const task = {
    integrationId: "owner",
    threadId: THREAD,
    projectId: "project",
    status: options.failed ? "failed" : "created",
  } as unknown as ExternalMcpTaskRecord;
  return externalTaskControlAuthority({
    client,
    service: {
      assertActive: () => Effect.void,
      assertProject: (verified, projectId) =>
        verified.allowedProjectIds.has(projectId)
          ? Effect.void
          : Effect.fail(
              new ExternalMcpError({ code: "project_denied", message: "not granted", status: 403 }),
            ),
    },
    repository: {
      getTask: ({ integrationId }) =>
        Effect.succeed(options.owned === false || integrationId !== "owner" ? null : task),
    },
    snapshots: {
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.makeUnsafe(options.moved ? "different-project" : "project"),
          } as never),
        ),
    },
  });
}

describe("external task control ownership", () => {
  it("allows a successfully created owned task in its granted project", async () => {
    await Effect.runPromise(fixture().assertOwnedTask(THREAD));
  });
  it.each([{ owned: false }, { allowed: false }, { moved: true }, { failed: true }])(
    "denies controls despite tasks:read-project: %j",
    async (options) => {
      const result = await Effect.runPromise(
        Effect.result(fixture(options).assertOwnedTask(THREAD)),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "task_denied" } });
    },
  );
});
