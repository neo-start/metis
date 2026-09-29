// FILE: ForkBranchStrip.tsx
// Purpose: Show the branches that leave a turn (the source chat plus every fork off
//          it) as a switcher row, so a transcript with forks reads as a tree.
// Layer: Chat transcript UI
// Exports: ForkBranchStrip

import type { ThreadId } from "@synara/contracts";
import { memo } from "react";

import { GitForkIcon } from "~/lib/icons";
import { requestForkPointJump, type ForkBranchGroup } from "~/lib/threadForkPoints";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export const ForkBranchStrip = memo(function ForkBranchStrip({
  group,
  onOpenThread,
  className,
}: {
  readonly group: ForkBranchGroup;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly className?: string;
}) {
  const forkCount = group.branches.filter((branch) => !branch.isSource).length;
  return (
    <div
      data-fork-branch-strip="true"
      role="group"
      aria-label={`${forkCount} ${forkCount === 1 ? "branch" : "branches"} from this turn`}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 font-system-ui text-ui-sm text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex shrink-0 items-center gap-1">
        <GitForkIcon className="size-[1.125em] shrink-0" aria-hidden />
        <span>{forkCount === 1 ? "1 branch" : `${forkCount} branches`}</span>
      </span>
      {group.branches.map((branch) => (
        <Button
          key={branch.threadId}
          type="button"
          variant={branch.isCurrent ? "default" : "ghost"}
          size="chip"
          shape="capsule"
          aria-current={branch.isCurrent ? "true" : undefined}
          title={branch.title}
          className={cn(
            "max-w-[16rem] border",
            // The current branch stays focusable (keyboard users can read it) but
            // clicking it is a no-op, so it renders without a pointer affordance.
            branch.isCurrent
              ? "cursor-default border-transparent"
              : "border-[color:var(--color-border-light)] text-foreground/85",
          )}
          onClick={() => {
            if (branch.isCurrent) return;
            // Land the destination on the same turn instead of its tail.
            requestForkPointJump(branch.threadId, group.forkPointKey);
            onOpenThread(branch.threadId);
          }}
        >
          <span className="truncate">{branch.title}</span>
        </Button>
      ))}
    </div>
  );
});
