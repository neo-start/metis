// FILE: SidebarProviderUsage.tsx
// Purpose: Compact always-visible usage strip in the sidebar footer: one row per
// signed-in provider with its tightest remaining quota. Opens Settings → Usage.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { Link } from "@tanstack/react-router";

import { ProviderIcon } from "~/components/ProviderIcon";
import { UsageProgressTrack } from "~/components/UsageProgressTrack";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useProviderUsageOverview } from "~/hooks/useProviderUsageOverview";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import {
  deriveProviderUsageDisplayRows,
  providerUsageProgressTrackProps,
  selectPrimaryProviderUsageDisplayRow,
} from "~/lib/providerUsageDisplay";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";

function SidebarProviderUsageRow({
  snapshot,
  threadRateLimits,
  codexHomePath,
}: {
  snapshot: ServerProviderUsageSnapshot;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
  codexHomePath: string | null;
}) {
  const usageSummary = useProviderUsageSummary({
    provider: snapshot.provider,
    threadRateLimits,
    codexHomePath,
    providerSnapshot: snapshot,
  });
  const row = selectPrimaryProviderUsageDisplayRow(
    deriveProviderUsageDisplayRows(usageSummary.rateLimits),
  );
  if (!row) return null;
  const name = providerUsageDisplayName(snapshot.provider);
  const detail = [`${name} ${row.label}`, row.leftText, row.resetText].filter(Boolean).join(" · ");
  // The app's own tooltip, not a native `title`: the native one waits on the OS
  // delay, needs a motionless pointer, will not reappear after a click, and has its
  // timer reset every time the usage refetch rewrites the attribute.
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          aria-label={detail}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-2 text-ui-sm",
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
          )}
          render={<Link to="/settings" search={{ section: "usage" }} />}
        >
          <ProviderIcon provider={snapshot.provider} className="size-3.5 shrink-0" />
          <UsageProgressTrack
            {...providerUsageProgressTrackProps(row)}
            className="h-1.5 min-w-0 flex-1 bg-muted/80"
            markerGapClassName="bg-sidebar"
          />
          <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
            {Math.round(row.remainingPercent)}%
          </span>
        </TooltipTrigger>
        <TooltipPopup>{detail}</TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function SidebarProviderUsage() {
  const { snapshots, threadRateLimits, codexHomePath } = useProviderUsageOverview();
  const signedIn = snapshots.filter((snapshot) => (snapshot.status ?? "ok") === "ok");
  if (signedIn.length === 0) return null;
  return (
    <ul aria-label="Provider usage remaining" className="flex flex-col gap-0.5">
      {signedIn.map((snapshot) => (
        <SidebarProviderUsageRow
          key={snapshot.provider}
          snapshot={snapshot}
          threadRateLimits={threadRateLimits}
          codexHomePath={codexHomePath}
        />
      ))}
    </ul>
  );
}
