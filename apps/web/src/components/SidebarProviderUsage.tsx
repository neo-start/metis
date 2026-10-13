// FILE: SidebarProviderUsage.tsx
// Purpose: Compact always-visible usage strip in the sidebar footer: one row per
// signed-in provider with its tightest remaining quota. Opens Settings → Usage.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { Link } from "@tanstack/react-router";

import { KimiIcon } from "~/components/Icons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { UsageProgressTrack } from "~/components/UsageProgressTrack";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useProviderUsageOverview } from "~/hooks/useProviderUsageOverview";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { CentralIcon } from "~/lib/central-icons";
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

const KIMI_K3_TOOLTIP = "Kimi K3 · 经 OpenRouter 接入 · 用量未知";

function KimiK3UsageRow() {
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          aria-label={KIMI_K3_TOOLTIP}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-2 text-ui-sm",
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
          )}
          render={<Link to="/settings" search={{ section: "usage" }} />}
        >
          <KimiIcon className="size-3.5 shrink-0" />
          <UsageProgressTrack
            label={KIMI_K3_TOOLTIP}
            remainingPercent={100}
            markerPercent={null}
            fillClassName="bg-muted-foreground/25"
            markerClassName="bg-muted-foreground/25"
            className="h-1.5 min-w-0 flex-1 bg-muted/80"
            markerGapClassName="bg-sidebar"
          />
          <span className="w-9 shrink-0 text-right text-ui-xs text-muted-foreground">未知</span>
        </TooltipTrigger>
        <TooltipPopup>{KIMI_K3_TOOLTIP}</TooltipPopup>
      </Tooltip>
    </li>
  );
}

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
  const displayRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const row = selectPrimaryProviderUsageDisplayRow(displayRows);
  const name = providerUsageDisplayName(snapshot.provider);
  if (!row) {
    // Provider is connected but we have no rate-limit data (e.g. routed through
    // OpenRouter).  Show it with a neutral placeholder so the user can still see
    // every configured provider at a glance.
    return (
      <li>
        <Tooltip>
          <TooltipTrigger
            aria-label={`${name} 用量未知`}
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
              label={`${name} 用量未知`}
              remainingPercent={100}
              markerPercent={null}
              fillClassName="bg-muted-foreground/25"
              markerClassName="bg-muted-foreground/25"
              className="h-1.5 min-w-0 flex-1 bg-muted/80"
              markerGapClassName="bg-sidebar"
            />
            <span className="w-9 shrink-0 text-right text-ui-xs text-muted-foreground">未知</span>
          </TooltipTrigger>
          <TooltipPopup>{name} · 用量未知</TooltipPopup>
        </Tooltip>
      </li>
    );
  }
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
  const { usageQuery, snapshots, threadRateLimits, codexHomePath } = useProviderUsageOverview();
  // Show every visible provider (including error / unsupported status) so the
  // user always sees Claude, Pi, etc. at a glance.  Rows with no rate-limit
  // data render a neutral placeholder ("未知") instead of hiding entirely.
  // Keep the entry reachable before the first response and when usage is
  // unavailable. Missing quota data does not mean the providers were removed.
  if (snapshots.length === 0) {
    const detail = usageQuery.isError
      ? "用量暂不可用 · 打开用量设置重试"
      : usageQuery.isPending
        ? "正在加载用量"
        : "打开 Provider 设置";
    return (
      <Tooltip>
        <TooltipTrigger
          aria-label={`LLM Providers · ${detail}`}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-2 text-ui-sm transition-colors duration-200 ease-out active:bg-sidebar-accent motion-reduce:transition-none",
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
          )}
          render={
            <Link to="/settings" search={{ section: usageQuery.isError ? "usage" : "providers" }} />
          }
        >
          <CentralIcon name="puzzle" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">LLM Providers</span>
          {usageQuery.isPending || usageQuery.isError ? (
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {usageQuery.isError ? "用量未知" : "加载中"}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup>{detail}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <ul aria-label="Provider usage remaining" className="flex flex-col gap-0.5">
      {snapshots.flatMap((snapshot) => {
        const row = (
          <SidebarProviderUsageRow
            key={snapshot.provider}
            snapshot={snapshot}
            threadRateLimits={threadRateLimits}
            codexHomePath={codexHomePath}
          />
        );
        // Insert Kimi K3 after Claude so it appears as the third entry.
        if (snapshot.provider === "claudeAgent") {
          return [row, <KimiK3UsageRow key="kimi-k3-sidebar" />];
        }
        return [row];
      })}
    </ul>
  );
}
