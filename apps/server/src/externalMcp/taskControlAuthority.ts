import { Effect, Option } from "effect";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TaskControlAuthority } from "../taskControl/service.ts";
import type { ExternalMcpRepositoryShape } from "./Services/ExternalMcpRepository.ts";
import type {
  ExternalMcpServiceShape,
  ExternalMcpVerifiedClient,
} from "./Services/ExternalMcpService.ts";

/** Project-wide read grants deliberately confer no mutation authority. */
export function externalTaskControlAuthority(input: {
  readonly client: ExternalMcpVerifiedClient;
  readonly service: Pick<ExternalMcpServiceShape, "assertActive" | "assertProject">;
  readonly repository: Pick<ExternalMcpRepositoryShape, "getTask">;
  readonly snapshots: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
}): TaskControlAuthority {
  const { client, service, repository, snapshots } = input;
  return {
    integrationId: client.integration.integrationId,
    capabilities: client.capabilities,
    assertActive: () =>
      service
        .assertActive(client.integration.integrationId)
        .pipe(Effect.mapError((error) => new GatewayToolError(error.code, error.message))),
    assertOwnedTask: (threadId) =>
      Effect.gen(function* () {
        const task = yield* repository.getTask({
          integrationId: client.integration.integrationId,
          threadId,
        });
        if (!task || task.status !== "created") {
          return yield* Effect.fail(
            new GatewayToolError(
              "task_denied",
              "Only tasks created successfully by this integration may be controlled.",
            ),
          );
        }
        yield* service.assertProject(client, task.projectId);
        const shell = yield* snapshots.getThreadShellById(threadId);
        if (Option.isNone(shell) || shell.value.projectId !== task.projectId) {
          return yield* Effect.fail(
            new GatewayToolError(
              "task_denied",
              "The task no longer belongs to its authorized project.",
            ),
          );
        }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof GatewayToolError
            ? error
            : new GatewayToolError(
                "task_denied",
                "Could not verify task ownership and project authority.",
              ),
        ),
      ),
  };
}
