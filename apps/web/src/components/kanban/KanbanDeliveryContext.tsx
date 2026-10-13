import type { PullRequestDeliveryState, ThreadId } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import type { KanbanBoard, KanbanCard } from "./kanban.logic";

const DELIVERY_QUERY_KEY = ["pull-requests", "delivery"] as const;

export function useKanbanDelivery(threadIds: readonly ThreadId[]) {
  const ids = useMemo(() => [...new Set(threadIds)].toSorted(), [threadIds]);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...DELIVERY_QUERY_KEY, ids],
    queryFn: async () => {
      const items: PullRequestDeliveryState[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const page = await ensureNativeApi().pullRequests.delivery({
          threadIds: ids.slice(offset, offset + 500),
        });
        items.push(...page.items);
      }
      return { items };
    },
    enabled: ids.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const mutation = useMutation({
    mutationFn: (input: { threadId: ThreadId; enabled: boolean }) =>
      ensureNativeApi().pullRequests.setFeedbackEnabled(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DELIVERY_QUERY_KEY }),
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not update automatic feedback",
        description: error.message,
      });
    },
  });
  const states = useMemo(
    () => new Map((query.data?.items ?? []).map((item) => [item.threadId, item])),
    [query.data],
  );
  return {
    states,
    loading: ids.length > 0 && query.isPending,
    unconfirmed: ids.some((id) => {
      const state = states.get(id);
      return !state || (state.number !== null && (state.stale || state.checkedAt === null));
    }),
    error: query.isError ? query.error.message : null,
    // Serialize policy changes so a repeated click cannot race a pending opt-in/out.
    updating: mutation.isPending,
    setEnabled: mutation.mutate,
  };
}

type DeliveryContextValue = ReturnType<typeof useKanbanDelivery>;
const KanbanDeliveryContext = createContext<DeliveryContextValue | null>(null);

export function KanbanDeliveryProvider({
  value,
  children,
}: {
  value: DeliveryContextValue;
  children: ReactNode;
}) {
  return <KanbanDeliveryContext value={value}>{children}</KanbanDeliveryContext>;
}

export function useKanbanDeliveryContext() {
  return useContext(KanbanDeliveryContext);
}

export function kanbanCardNeedsAttention(
  card: KanbanCard,
  states: ReadonlyMap<ThreadId, PullRequestDeliveryState>,
): boolean {
  return Boolean(
    card.thread?.hasPendingApprovals ||
    card.thread?.hasPendingUserInput ||
    card.thread?.hasActionableProposedPlan ||
    card.thread?.latestTurn?.state === "error" ||
    states.get(card.threadId)?.needsAttention ||
    states.get(card.threadId)?.error ||
    states.get(card.threadId)?.feedbackStatus === "exhausted",
  );
}

/** Filter before overview caps, preserving the underlying runtime-derived columns. */
export function attentionKanbanBoard(
  board: KanbanBoard,
  states: ReadonlyMap<ThreadId, PullRequestDeliveryState>,
): KanbanBoard {
  const projects = board.projects.map((project) => {
    const draft = project.draft.filter((card) => kanbanCardNeedsAttention(card, states));
    const inProgress = project.inProgress.filter((card) => kanbanCardNeedsAttention(card, states));
    const done = project.done.filter((card) => kanbanCardNeedsAttention(card, states));
    return {
      ...project,
      draft,
      inProgress,
      done,
      totalCount: draft.length + inProgress.length + done.length,
    };
  });
  return {
    projects,
    totalCount: projects.reduce((count, project) => count + project.totalCount, 0),
  };
}
