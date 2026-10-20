import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import type { MetisController } from "../metis/MetisController.ts";

/** Resolve the durable identity on every inbound message, including stop commands.
 * A same-title thread or stale Feishu mapping never grants controller authority. */
export async function resolveFeishuController(
  controller: Pick<MetisController, "overview">,
  readShell: (id: ThreadId) => Promise<OrchestrationThreadShell | undefined>,
): Promise<OrchestrationThreadShell> {
  const identity = await controller.overview();
  const thread = identity.threadId
    ? await readShell(ThreadId.makeUnsafe(identity.threadId))
    : undefined;
  if (!thread || thread.archivedAt !== null) {
    throw new Error("Metis 实例总控暂时不可用，请先在 Metis 中打开总控。");
  }
  return thread;
}
