// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ProviderUsageCard } from "~/components/ProviderUsageCard";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { useProviderUsageOverview } from "~/hooks/useProviderUsageOverview";
import { RotateCcwIcon } from "~/lib/icons";
import { fetchAllProviderUsage, serverQueryKeys } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

function mergeProviderUsageRefresh(
  previous: readonly ServerProviderUsageSnapshot[] | undefined,
  next: readonly ServerProviderUsageSnapshot[],
): readonly ServerProviderUsageSnapshot[] {
  if (!previous) {
    return next;
  }
  const previousByProvider = new Map(previous.map((snapshot) => [snapshot.provider, snapshot]));
  const nextByProvider = new Map(next.map((snapshot) => [snapshot.provider, snapshot]));
  return PROVIDER_USAGE_PROVIDERS.map(
    (provider) => nextByProvider.get(provider) ?? previousByProvider.get(provider),
  ).filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== undefined);
}

export function ProviderUsageSettingsPanel() {
  const queryClient = useQueryClient();
  const {
    usageQuery,
    snapshots: cards,
    threadRateLimits,
    codexHomePath,
  } = useProviderUsageOverview();
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        (previous) => mergeProviderUsageRefresh(previous, data),
      );
    },
  });

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  return (
    <SettingsSectionShell
      title="Provider usage"
      action={
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={isRefreshing}
          onClick={() => refreshMutation.mutate()}
        >
          <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      {showInitialLoading ? (
        <SettingsCard>
          <div className="px-4 py-3.5 text-ui leading-snug text-muted-foreground">
            Loading provider usage…
          </div>
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((snapshot) => (
            <ProviderUsageCard
              key={snapshot.provider}
              snapshot={snapshot}
              threadRateLimits={threadRateLimits}
              codexHomePath={codexHomePath}
            />
          ))}
        </div>
      )}

      <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
        Usage is read locally from each provider CLI&apos;s stored credentials and fetched directly
        from the provider. The list follows whatever you are signed into; unsigned providers stay
        visible until any account is connected, then drop away. Short-lived tokens are refreshed
        through the provider&apos;s own CLI or official token endpoint.
      </p>
    </SettingsSectionShell>
  );
}
