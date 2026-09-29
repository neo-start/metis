// FILE: useProviderUsageOverview.ts
// Purpose: Shared live usage inputs for every provider-usage surface (Settings → Usage,
// workbench home, sidebar): visible snapshots plus thread-derived rate-limit fallbacks.

import { selectVisibleProviderUsageSnapshots } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppSettings } from "~/appSettings";
import { deriveAccountRateLimits } from "~/lib/rateLimits";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

export function useProviderUsageOverview() {
  const { settings } = useAppSettings();
  const codexHomePath = settings.codexHomePath || null;
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  // Account/thread fallback rows are shared by every provider; derive them once.
  const threadRateLimits = deriveAccountRateLimits(threads);
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  // Use the live payload only. Inventing error placeholders for omitted providers
  // would count as "connected" and hide unsigned cards.
  const snapshots = selectVisibleProviderUsageSnapshots(usageQuery.data ?? []);
  return { usageQuery, snapshots, threadRateLimits, codexHomePath };
}
