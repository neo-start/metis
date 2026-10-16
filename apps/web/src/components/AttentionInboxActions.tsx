import { CircleAlertIcon, CircleCheckIcon, EyeIcon, MessageCircleIcon } from "~/lib/icons";
import type { SidebarThreadSummary } from "../types";
import type { ActivityAttentionKind } from "./SidebarActivityView.logic";
import { Button } from "./ui/button";

export const ATTENTION_LABELS: Record<ActivityAttentionKind, string> = {
  approval: "Approvals",
  question: "Questions",
  review: "Result review",
  error: "Errors",
};

const ATTENTION_STATES: Record<ActivityAttentionKind, string> = {
  approval: "Approval needed · review the operation before allowing or declining it.",
  question: "Answer needed · open the question and submit your response in the thread.",
  review: "Result ready · review the response or changes, then explicitly settle this task.",
  error: "Execution failed · inspect the error and retry from the thread when ready.",
};

/** Only navigates to existing decision surfaces; never invents a provider response. */
export function AttentionInboxActions({
  thread,
  kinds,
  onOpen,
  onOpenDiff,
  onSettle,
}: {
  thread: SidebarThreadSummary;
  kinds: readonly ActivityAttentionKind[];
  onOpen: () => void;
  onOpenDiff: () => void;
  onSettle: () => void;
}) {
  const awaitingResponse = kinds.includes("approval") || kinds.includes("question");
  return (
    <div
      className="mx-2.5 mb-2 space-y-1.5 border-l border-primary/25 pl-2"
      aria-label={`Attention for ${thread.title}`}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      {kinds.map((kind) => (
        <p key={kind} className="text-ui-sm leading-snug text-muted-foreground">
          {kind === "review" && thread.hasActionableProposedPlan
            ? "Plan ready · review the proposal in the thread before deciding what to do next."
            : ATTENTION_STATES[kind]}
        </p>
      ))}
      {kinds.includes("error") && thread.session?.lastError ? (
        <p
          className="line-clamp-3 break-words text-ui-sm text-destructive"
          title={thread.session.lastError}
        >
          {thread.session.lastError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {kinds.includes("approval") ? (
          <Button size="xs" variant="primary-outline" onClick={onOpen}>
            <EyeIcon aria-hidden />
            Review approval
          </Button>
        ) : null}
        {kinds.includes("question") ? (
          <Button size="xs" variant="outline" onClick={onOpen}>
            <MessageCircleIcon aria-hidden />
            Answer question
          </Button>
        ) : null}
        {kinds.includes("review") ? (
          <>
            <Button size="xs" variant="outline" onClick={onOpen}>
              <EyeIcon aria-hidden />
              {thread.hasActionableProposedPlan ? "Review plan" : "Review result"}
            </Button>
            <Button size="xs" variant="outline" onClick={onOpenDiff}>
              View diff
            </Button>
            {!awaitingResponse ? (
              <Button size="xs" variant="ghost" onClick={onSettle}>
                <CircleCheckIcon aria-hidden />
                Settle
              </Button>
            ) : null}
          </>
        ) : null}
        {kinds.includes("error") ? (
          <Button size="xs" variant="outline" onClick={onOpen}>
            <CircleAlertIcon aria-hidden />
            Inspect / retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
