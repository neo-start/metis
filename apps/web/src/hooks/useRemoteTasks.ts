import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PeerControlInput } from "@synara/contracts";
import { serverAuthSessionQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export const REMOTE_TASKS_KEY = ["metis", "peers"] as const;

/** Shared polling/cache for the sidebar and settings. Network recovery and
 * window focus refresh the snapshot; failed polls keep the last known tasks. */
export function useRemoteTasks(owner?: boolean) {
  const session = useQuery({ ...serverAuthSessionQueryOptions(), enabled: owner === undefined });
  const authorized =
    owner ?? (session.data?.authenticated === true && session.data.role === "owner");
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: REMOTE_TASKS_KEY,
    queryFn: () => ensureNativeApi().peers.control({ action: "overview" }),
    enabled: authorized,
    refetchInterval: 3000,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (input: PeerControlInput) => ensureNativeApi().peers.control(input),
    onSuccess: (result) => cache.setQueryData(REMOTE_TASKS_KEY, result),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: REMOTE_TASKS_KEY });
    },
  });
  return { query, mutation, authorized };
}
