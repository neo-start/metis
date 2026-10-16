import {
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  type MetisControlInput,
  type MetisIdentity,
} from "@synara/contracts";
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
  const showController = async (identity: MetisIdentity) => {
    await cache.cancelQueries({ queryKey: METIS_IDENTITY_QUERY_KEY });
    cache.setQueryData(METIS_IDENTITY_QUERY_KEY, identity);
    if (!identity.threadId) throw new Error("Metis 总控暂时不可用，请重试。");
    const snapshot = await ensureNativeApi().orchestration.getShellSnapshot();
    useStore.getState().syncServerShellSnapshot(snapshot);
    await navigate({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe(identity.threadId) },
    });
  };
  const open = useMutation({
    mutationFn: async () => showController(await prepare()),
    onError: (error) =>
      toastManager.add({ type: "error", title: "无法打开 Metis", description: error.message }),
  });
  const clear = useMutation({
    mutationFn: async (input: Omit<Extract<MetisControlInput, { action: "clear" }>, "action">) =>
      showController(await ensureNativeApi().metis.control({ action: "clear", ...input })),
    onError: (error) =>
      toastManager.add({ type: "error", title: "无法清空 Metis 对话", description: error.message }),
  });
  return { query, open, clear, owner };
}
