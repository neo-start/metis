import type { PullRequestDeliveryState } from "@synara/contracts";

import { Button } from "~/components/ui/button";
import { CircleCheckIcon, CircleAlertIcon, ClockIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import type { KanbanCard } from "./kanban.logic";
import { useKanbanDeliveryContext } from "./KanbanDeliveryContext";

const LABELS: Record<PullRequestDeliveryState["status"], string> = {
  "checks-pending": "Checks running",
  "checks-failed": "Checks failed",
  "changes-requested": "Changes requested",
  conflicts: "Merge conflicts",
  ready: "Merge checks ready",
  merged: "Merged",
  closed: "PR closed",
  unknown: "Delivery status unavailable",
};

export function KanbanDeliverySummary({
  card,
  isOverlay,
}: {
  card: KanbanCard;
  isOverlay: boolean;
}) {
  const delivery = useKanbanDeliveryContext();
  if (!delivery || !card.thread?.lastKnownPr || card.isTerminal) return null;
  const state = delivery.states.get(card.threadId);
  // The service validates the stored PR against this task's branch and project.
  if (state && state.number === null && !state.error) return null;
  const unavailable = Boolean(delivery.error || state?.error || state?.stale);
  const Icon =
    unavailable || state?.needsAttention
      ? CircleAlertIcon
      : state?.status === "ready" || state?.status === "merged"
        ? CircleCheckIcon
        : ClockIcon;
  const label = unavailable
    ? "Delivery status needs refresh"
    : state
      ? LABELS[state.status]
      : delivery.loading
        ? "Checking delivery…"
        : "Delivery status unavailable";
  const feedbackDescription = state?.enabled
    ? state.feedbackStatus === "deferred"
      ? (state.deferredReason ?? "Waiting for this task to be available")
      : state.feedbackStatus === "exhausted"
        ? (state.deferredReason ??
          "Automatic feedback is paused. Review this task before continuing.")
        : state.feedbackStatus === "delivered"
          ? "Latest feedback sent to this task"
          : "Verified CI failures and review changes will be sent to this task; at most three automatic turns per 24 hours"
    : "Enable to send verified CI failures and review changes to this task automatically; at most three turns per 24 hours";

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-border/50 px-3 py-2">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-ui-sm",
          state?.needsAttention || unavailable
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground",
        )}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate" title={state?.summary ?? label}>
          {label}
        </span>
        {state?.checkedAt ? (
          <span
            className="ml-auto shrink-0 text-muted-foreground/70"
            title={`Last checked ${state.checkedAt}`}
          >
            {formatRelativeTime(state.checkedAt)}
          </span>
        ) : null}
      </div>
      {state?.summary && state.summary !== label ? (
        <p className="line-clamp-2 text-ui-sm text-muted-foreground" title={state.summary}>
          {state.summary}
        </p>
      ) : null}
      {unavailable ? (
        <p className="line-clamp-2 text-ui-sm text-muted-foreground">
          {delivery.error ??
            state?.error ??
            "Showing the last known result. Waiting for a fresh check."}
        </p>
      ) : null}
      {state?.enabled && state.deferredReason ? (
        <p className="line-clamp-2 text-ui-sm text-muted-foreground" title={state.deferredReason}>
          {state.deferredReason}
        </p>
      ) : null}
      {state?.number && state.status !== "merged" && state.status !== "closed" ? (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground"
            title={feedbackDescription}
          >
            {state.feedbackStatus === "deferred"
              ? "Feedback waiting"
              : state.feedbackStatus === "exhausted"
                ? "Review needed"
                : state.feedbackStatus === "delivered"
                  ? "Feedback sent"
                  : "Automatic feedback"}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 active:bg-muted motion-reduce:transition-none"
            aria-label={`Automatic PR and CI feedback for ${card.title}`}
            aria-pressed={state.enabled}
            title={feedbackDescription}
            disabled={isOverlay || delivery.updating}
            tabIndex={isOverlay ? -1 : 0}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              delivery.setEnabled({ threadId: card.threadId, enabled: !state.enabled });
            }}
          >
            {state.enabled ? "On" : "Off"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
