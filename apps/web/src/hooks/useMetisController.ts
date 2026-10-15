import { DEFAULT_RUNTIME_MODE, ThreadId } from "@synara/contracts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAppSettings } from "~/appSettings";
import {
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { serverAuthSessionQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { toastManager } from "~/components/ui/toast";

export const METIS_IDENTITY_QUERY_KEY = ["metis", "identity"] as const;
export function useMetisController() {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const auth = useQuery(serverAuthSessionQueryOptions());
  const owner = auth.data?.authenticated === true && auth.data.role === "owner";
  const prepare = async () => {
    const api = ensureNativeApi();
    const current = await api.metis.control({ action: "overview" });
    if (current.threadId) return current;
    const drafts = useComposerDraftStore.getState();
    const modelSelection = resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: drafts.stickyModelSelectionByProvider,
        activeProvider: drafts.stickyActiveProvider,
      },
      threadModelSelection: null,
      projectModelSelection: null,
      defaultProvider: settings.defaultProvider,
    });
    return api.metis.control({ action: "open", modelSelection, runtimeMode: DEFAULT_RUNTIME_MODE });
  };
  const query = useQuery({
    queryKey: METIS_IDENTITY_QUERY_KEY,
    queryFn: prepare,
    enabled: owner,
    refetchInterval: 30_000,
    retry: false,
  });
  const open = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      const identity = await prepare();
      cache.setQueryData(METIS_IDENTITY_QUERY_KEY, identity);
      if (!identity.threadId) throw new Error("Metis 总控暂时不可用，请重试。");
      const snapshot = await api.orchestration.getShellSnapshot();
      useStore.getState().syncServerShellSnapshot(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId: ThreadId.makeUnsafe(identity.threadId) },
      });
    },
    onError: (error) =>
      toastManager.add({ type: "error", title: "无法打开 Metis", description: error.message }),
  });
  return { query, open, owner };
}
