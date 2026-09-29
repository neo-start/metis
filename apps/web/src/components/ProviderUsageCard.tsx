// FILE: ProviderUsageCard.tsx
// Purpose: One provider's live usage card (plan pill, remaining-quota meters, reset
// credits, usage lines). Shared by Settings → Usage and the workbench home.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import {
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
} from "@synara/shared/providerUsage";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderUsageLimitRows } from "~/components/ProviderUsageLimitRows";
import { ProviderUsageLineList } from "~/components/ProviderUsageLineList";
import { ProviderUsageResetCredits } from "~/components/ProviderUsageResetCredits";
import { SettingsCard } from "~/components/settings/SettingsPanelPrimitives";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { cn } from "~/lib/utils";

const PILL_CLASS_NAME = "shrink-0 rounded-full px-2 py-1 text-ui-sm font-medium leading-none";

interface StatusPill {
  label: string;
  className: string;
}

function statusPill(status: ServerProviderUsageSnapshot["status"]): StatusPill | null {
  switch (status) {
    case "needs-auth":
      return {
        label: "Not signed in",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      };
    case "unsupported":
      return { label: "Unsupported", className: "bg-muted text-muted-foreground" };
    case "error":
      return { label: "Unavailable", className: "bg-red-500/12 text-red-600 dark:text-red-400" };
    default:
      return null;
  }
}

export function ProviderUsageCard({
  snapshot,
  threadRateLimits,
  codexHomePath,
}: {
  snapshot: ServerProviderUsageSnapshot;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
  codexHomePath: string | null;
}) {
  const provider = snapshot.provider;
  const status = snapshot.status ?? "ok";
  const usageSummary = useProviderUsageSummary({
    provider,
    threadRateLimits,
    codexHomePath,
    providerSnapshot: snapshot,
  });
  const meterRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const usageLines = usageSummary.usageLines;
  const resetCredits = provider === "codex" ? snapshot.resetCredits : undefined;
  const hasResetCredits = Boolean(resetCredits && resetCredits.availableCount > 0);
  const hasUsage = meterRows.length > 0 || usageLines.length > 0 || hasResetCredits;
  const pill = status === "ok" ? null : statusPill(snapshot.status);

  return (
    <SettingsCard>
      <div className="space-y-3.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <ProviderIcon provider={provider} className="size-4" />
            </span>
            <span className="truncate text-ui-lg font-semibold text-foreground">
              {providerUsageDisplayName(provider)}
            </span>
          </div>
          {status === "ok" && snapshot.planName ? (
            <span className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>
              {snapshot.planName}
            </span>
          ) : pill ? (
            <span className={cn(PILL_CLASS_NAME, pill.className)}>{pill.label}</span>
          ) : null}
        </div>

        {status === "ok" && hasUsage ? (
          <>
            {usageSummary.usageNotice ? (
              <p className="flex items-start gap-1.5 text-ui leading-relaxed text-amber-600 dark:text-amber-300/90">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{usageSummary.usageNotice}</span>
              </p>
            ) : null}
            {meterRows.length > 0 ? (
              <ProviderUsageLimitRows rows={meterRows} surface="settings" />
            ) : null}
            {hasResetCredits && resetCredits ? (
              <ProviderUsageResetCredits resetCredits={resetCredits} />
            ) : null}
            {usageLines.length > 0 ? (
              <ProviderUsageLineList
                className={cn(
                  (meterRows.length > 0 || hasResetCredits) &&
                    "border-t border-[color:var(--color-border)] pt-3",
                )}
                lines={usageLines}
                surface="settings"
              />
            ) : null}
          </>
        ) : (
          <p className="text-ui leading-relaxed text-muted-foreground">
            {status === "ok"
              ? "No usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
