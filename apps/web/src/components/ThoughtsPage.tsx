import { THOUGHT_BODY_MAX_BYTES, ThreadId, type Thought } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions } from "~/lib/serverReactQuery";
import { BookOpenIcon, SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { RouteInsetSurface } from "./RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "./chat/chatHeaderControls";

const QUERY_KEY = ["metisThoughts"] as const;
const dateLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const validBody = (body: string) =>
  body.trim().length > 0 && new TextEncoder().encode(body).length <= THOUGHT_BODY_MAX_BYTES;

export function ThoughtsPage({ entryId }: { entryId: string | undefined }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const auth = useQuery(serverAuthSessionQueryOptions());
  const owner = auth.data?.authenticated === true && auth.data.role === "owner";
  const trafficGutter = useDesktopTopBarTrafficLightGutterClassName();
  const controlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const threads = useStore((state) => state.sidebarThreadSummaryById);
  const [draft, setDraft] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [deletedEntryId, setDeletedEntryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ entry: Thought; body: string } | null>(null);
  const createRequest = useRef<{ id: string; body: string } | null>(null);
  const dirty = draft.length > 0 || (editing !== null && editing.body !== editing.entry.body);
  const list = useQuery({
    queryKey: [...QUERY_KEY, "list", query, offset],
    queryFn: () => ensureNativeApi().thoughts.list({ query, offset, limit: 20 }),
    enabled: owner && !entryId,
    refetchInterval: 10_000,
  });
  const selected = useQuery({
    queryKey: [...QUERY_KEY, "entry", entryId],
    queryFn: () => ensureNativeApi().thoughts.read({ id: entryId! }),
    enabled: owner && Boolean(entryId) && entryId !== deletedEntryId,
    refetchInterval: 10_000,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: QUERY_KEY });
  const reportError = (error: Error) => {
    toastManager.add({
      type: "error",
      title: "操作未能确认",
      description: error.message,
    });
    void refresh();
  };
  const create = useMutation({
    mutationFn: (body: string) => {
      if (!createRequest.current || createRequest.current.body !== body)
        createRequest.current = { id: crypto.randomUUID(), body };
      return ensureNativeApi().thoughts.create(createRequest.current);
    },
    onSuccess: () => {
      setDraft("");
      createRequest.current = null;
      setOffset(0);
      void refresh();
      toastManager.add({ type: "success", title: "已记下" });
    },
    onError: reportError,
  });
  const update = useMutation({
    mutationFn: (value: { entry: Thought; body: string }) =>
      ensureNativeApi().thoughts.update({
        id: value.entry.id,
        expectedRevision: value.entry.revision,
        body: value.body,
      }),
    onSuccess: () => {
      setEditing(null);
      void refresh();
      toastManager.add({ type: "success", title: "随想已更新" });
    },
    onError: reportError,
  });
  const remove = useMutation({
    mutationFn: (entry: Thought) =>
      ensureNativeApi().thoughts.delete({ id: entry.id, expectedRevision: entry.revision }),
    onSuccess: (_result, entry) => {
      setDeletedEntryId(entry.id);
      cache.removeQueries({ queryKey: [...QUERY_KEY, "entry", entry.id], exact: true });
      void refresh();
      toastManager.add({ type: "success", title: "随想已删除" });
    },
    onError: reportError,
  });
  const pending = create.isPending || update.isPending || remove.isPending;
  useBlocker({
    shouldBlockFn: async () => {
      if (pending) {
        toastManager.add({ type: "info", title: "正在保存，请稍候再离开" });
        return true;
      }
      if (!dirty) return false;
      const leave = await ensureNativeApi().dialogs.confirm(
        "还有未保存的随想，确定离开并放弃草稿吗？",
      );
      if (leave) {
        setDraft("");
        setEditing(null);
      }
      return !leave;
    },
    enableBeforeUnload: dirty || pending,
  });
  const cancelEdit = async () => {
    if (
      editing &&
      editing.body !== editing.entry.body &&
      !(await ensureNativeApi().dialogs.confirm("放弃这条随想的修改吗？"))
    )
      return false;
    setEditing(null);
    return true;
  };
  const entries = entryId
    ? selected.data && !selected.isError && entryId !== deletedEntryId
      ? [selected.data]
      : []
    : [...(list.data?.entries ?? [])];
  // Background refresh can move an entry to another page or discover a deletion.
  // Keep its editor visible so an unsaved draft can always be copied or cancelled.
  if (editing && !entries.some((entry) => entry.id === editing.entry.id))
    entries.push(editing.entry);
  const activeQuery = entryId ? selected : list;

  return (
    <RouteInsetSurface>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            trafficGutter,
            controlsGutter,
          )}
        >
          <div className={cn("flex items-center gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <BookOpenIcon className="size-4 text-muted-foreground" />
            <span className="text-ui font-medium">随想</span>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-10 px-5 py-8 sm:px-10 sm:py-12">
            <div className="space-y-2">
              <h1 className="text-2xl font-medium tracking-tight">留住此刻的念头</h1>
              <p className="text-ui text-muted-foreground">
                一句话也值得留下。想说的时候，也可以让 Metis 帮你记。
              </p>
            </div>
            {!owner ? (
              <p className="text-ui text-muted-foreground" role="status">
                {auth.isPending ? "正在加载…" : "随想仅对本实例的所有者开放。"}
              </p>
            ) : (
              <>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validBody(draft) && !pending) create.mutate(draft);
                  }}
                >
                  <Textarea
                    aria-label="写下随想"
                    placeholder="此刻有什么想留下？"
                    value={draft}
                    disabled={create.isPending}
                    maxLength={THOUGHT_BODY_MAX_BYTES}
                    className="bg-transparent [&_[data-slot=textarea]]:min-h-32 [&_[data-slot=textarea]]:p-4 [&_[data-slot=textarea]]:leading-relaxed"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing &&
                        validBody(draft) &&
                        !pending
                      ) {
                        event.preventDefault();
                        create.mutate(draft);
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-ui-xs text-muted-foreground">
                      {draft && !validBody(draft)
                        ? "请输入内容，每条最多 16 KiB"
                        : "不必起标题，也不必想完整。"}
                    </span>
                    <Button type="submit" size="sm" disabled={!validBody(draft) || pending}>
                      {create.isPending ? "正在记录…" : "记下来"}
                    </Button>
                  </div>
                </form>
                <section className="space-y-5" aria-label="随想记录">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
                    <h2 className="text-ui-lg font-medium">{entryId ? "这一刻" : "留下的片刻"}</h2>
                    {entryId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void navigate({ to: "/thoughts", search: {} })}
                      >
                        全部随想
                      </Button>
                    ) : (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!editing) {
                            setQuery(searchDraft.trim());
                            setOffset(0);
                          }
                        }}
                      >
                        <Input
                          type="search"
                          size="sm"
                          aria-label="搜索随想"
                          placeholder="找找以前的念头"
                          maxLength={200}
                          value={searchDraft}
                          onChange={(event) => setSearchDraft(event.target.value)}
                        />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="搜索"
                          disabled={Boolean(editing)}
                        >
                          <SearchIcon className="size-4" />
                        </Button>
                      </form>
                    )}
                  </div>
                  {activeQuery.isError ? (
                    <div role="alert" className="space-y-2 text-ui text-destructive">
                      <p>{activeQuery.error.message}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void activeQuery.refetch()}
                      >
                        重试
                      </Button>
                    </div>
                  ) : null}
                  {entryId === deletedEntryId ? (
                    <p role="status" className="text-ui text-muted-foreground">
                      这条随想已删除。
                    </p>
                  ) : activeQuery.isPending ? (
                    <p role="status" className="text-ui text-muted-foreground">
                      正在读取随想…
                    </p>
                  ) : entries.length === 0 && !activeQuery.isError ? (
                    <p className="py-8 text-ui text-muted-foreground">
                      {query
                        ? "没有找到相关记录，换个关键词试试。"
                        : offset > 0
                          ? "这一页已没有记录，可以返回上一页。"
                          : "这里还很安静。从今天的一个念头开始吧。"}
                    </p>
                  ) : null}
                  {entries.map((entry) => (
                    <article
                      key={entry.id}
                      className="space-y-3 border-b border-border/60 pb-6 pt-2"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
                        <Link
                          to="/thoughts"
                          search={{ entry: entry.id }}
                          className="rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-primary"
                        >
                          <time dateTime={entry.createdAt}>{dateLabel(entry.createdAt)}</time>
                        </Link>
                        <span>{entry.origin === "agent" ? "由 Metis 代记" : "自己记下"}</span>
                        {entry.revision > 1 ? (
                          <span title={dateLabel(entry.updatedAt)}>已编辑</span>
                        ) : null}
                      </div>
                      {editing?.entry.id === entry.id ? (
                        <div className="space-y-3">
                          <Textarea
                            aria-label="修改随想"
                            value={editing.body}
                            disabled={update.isPending}
                            maxLength={THOUGHT_BODY_MAX_BYTES}
                            className="[&_[data-slot=textarea]]:min-h-28"
                            onChange={(event) =>
                              setEditing({ ...editing, body: event.target.value })
                            }
                          />
                          {editing.entry.revision !== entry.revision ? (
                            <p className="text-ui-sm text-destructive" role="status">
                              原文已有更新，你的草稿仍保留。请复制草稿后取消编辑，核对最新内容再修改。
                            </p>
                          ) : null}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={
                                pending ||
                                !validBody(editing.body) ||
                                editing.entry.revision !== entry.revision
                              }
                              onClick={() => update.mutate(editing)}
                            >
                              {update.isPending ? "保存中…" : "保存修改"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => void cancelEdit()}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words text-ui leading-relaxed">
                          {entry.body}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {entry.sourceThreadId ? (
                          threads[ThreadId.makeUnsafe(entry.sourceThreadId)] ? (
                            <Link
                              to="/$threadId"
                              params={{ threadId: ThreadId.makeUnsafe(entry.sourceThreadId) }}
                              className="mr-auto rounded-sm text-ui-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-primary"
                            >
                              来源对话 ↗
                            </Link>
                          ) : (
                            <span className="mr-auto text-ui-xs text-muted-foreground">
                              来源对话已不可用
                            </span>
                          )
                        ) : (
                          <span className="mr-auto" />
                        )}
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={pending || editing?.entry.id === entry.id}
                          onClick={async () => {
                            if (await cancelEdit()) setEditing({ entry, body: entry.body });
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={pending || editing?.entry.id === entry.id}
                          onClick={async () => {
                            if (
                              await ensureNativeApi().dialogs.confirm(
                                "删除这条随想？删除后无法恢复，原对话中的内容不会随之删除。",
                              )
                            )
                              remove.mutate(entry);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </article>
                  ))}
                  {!entryId && list.data ? (
                    <div className="flex items-center justify-between gap-3 text-ui-xs text-muted-foreground">
                      <span>
                        {query ? `“${query}” · ` : ""}共 {list.data.total} 条
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={offset === 0 || pending || Boolean(editing)}
                          onClick={() => setOffset(Math.max(0, offset - 20))}
                        >
                          上一页
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={list.data.nextOffset === null || pending || Boolean(editing)}
                          onClick={() => setOffset(list.data!.nextOffset!)}
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </RouteInsetSurface>
  );
}
