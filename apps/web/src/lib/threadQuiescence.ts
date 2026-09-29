// FILE: threadQuiescence.ts
// Purpose: Wait for a thread to leave its in-flight state after an interrupt so a
//          follow-up that needs a quiet thread (handoff, provider switch) can run.
// Layer: Web store helper
// Exports: waitForThreadToSettle

import type { ThreadId } from "@synara/contracts";

import { useStore } from "../store";
import { createThreadSelector } from "../storeSelectors";
import { canCreateThreadHandoff } from "./threadHandoff";

const SETTLE_POLL_MS = 100;
const SETTLE_TIMEOUT_MS = 20_000;

/**
 * Resolves true once the thread has no running session or turn and no open
 * request, false if that does not happen within the timeout. Polls the store the
 * subscription pushes into rather than a server round-trip.
 */
export async function waitForThreadToSettle(
  threadId: ThreadId,
  options?: { readonly timeoutMs?: number },
): Promise<boolean> {
  const select = createThreadSelector(threadId);
  const deadline = Date.now() + (options?.timeoutMs ?? SETTLE_TIMEOUT_MS);
  for (;;) {
    const thread = select(useStore.getState());
    if (thread && canCreateThreadHandoff({ thread })) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}
