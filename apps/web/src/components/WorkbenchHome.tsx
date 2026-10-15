import { sortThreads, toSortableTimestamp } from "@synara/shared/workbenchThreadSort";
import { HighlightedSearchText } from "./HighlightedSearchText";
import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { AddPlusIcon, ClockIcon, FolderOpenIcon, SearchIcon, SettingsIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { useStore } from "~/store";
import { createSidebarDisplayThreadsSelector } from "~/storeSelectors";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { useProviderUsageOverview } from "~/hooks/useProviderUsageOverview";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsageCard } from "./ProviderUsageCard";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SynaraLogo } from "./SynaraLogo";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

const STATUS_LABELS = {
  Working: "正在执行",
  Connecting: "正在连接",
  Completed: "已完成",
  "Pending Approval": "等待授权",
  "Awaiting Input": "等待回复",
  "Plan Ready": "计划待确认",
} as const;

export function WorkbenchHome() {
  const { settings } = useAppSettings();
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const summaries = useStore(useMemo(() => createSidebarDisplayThreadsSelector(), []));
  const hydrated = useStore((state) => state.threadsHydrated);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const { handleNewChat } = useHandleNewChat();
  const { handleNewThread } = useHandleNewThread();
  const providers = useProviderStatusesForLocalConfig();
  const config = useQuery(serverConfigQueryOptions());
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(12);
  const [starting, setStarting] = useState(false);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const threads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matching = summaries
      .filter(
        (thread) => !thread.archivedAt && !thread.parentThreadId && !thread.sidechatSourceThreadId,
      )
      .filter(
        (thread) =>
          !query ||
          `${thread.title} ${projectById.get(thread.projectId)?.name ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
      );
    // Keep the T3 shared sorter, supplying this overview's last-activity anchor.
    return sortThreads(
      matching.map((thread) => {
        const candidates = [
          thread.updatedAt,
          thread.latestUserMessageAt,
          thread.latestTurn?.startedAt,
          thread.latestTurn?.completedAt,
          thread.createdAt,
        ];
        const latest = candidates.reduce<string>(
          (best, value) =>
            (toSortableTimestamp(value ?? undefined) ?? 0) > (toSortableTimestamp(best) ?? 0)
              ? value!
              : best,
          thread.createdAt,
        );
        return {
          id: thread.id,
          thread,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt ?? thread.createdAt,
          latestUserMessageAt: latest,
        };
      }),
      "updated_at",
    ).map(({ thread }) => thread);
  }, [summaries, search, projectById]);
  const activeCount = summaries.filter((thread) => {
    if (thread.archivedAt || thread.parentThreadId || thread.sidechatSourceThreadId) return false;
    const status = resolveThreadStatusPill({
      thread,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    });
    return status !== null && status.label !== "Completed";
  }).length;
  const visibleProviders = providers.filter(
    (provider) =>
      provider.available || provider.provider === "codex" || provider.provider === "claudeAgent",
  );

  async function startChat() {
    if (starting || !hydrated) return;
    setStarting(true);
    try {
      const result = await handleNewChat();
      if (!result.ok)
        toastManager.add({ type: "error", title: "暂时无法新建对话", description: result.error });
      else if (!result.threadId)
        toastManager.add({ type: "error", title: "对话尚未创建，请稍后重试" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "暂时无法新建对话",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "drag-region flex min-h-12 shrink-0 items-center gap-3 border-b px-4",
          trafficLightGutter,
          windowControlsGutter,
        )}
      >
        <div className="no-drag">
          <SidebarHeaderNavigationControls />
        </div>
        <span className="flex items-center gap-1.5 text-ui font-medium">
          <SynaraLogo aria-hidden className="size-6" />
          Metis
        </span>
        <Button
          render={<Link to="/settings" search={{ section: "providers" }} />}
          variant="ghost"
          size="sm"
          className="no-drag ml-auto"
        >
          <SettingsIcon aria-hidden className="size-4" />
          Agent 设置
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-9 sm:py-12">
          <section className="flex flex-wrap items-end justify-between gap-5">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-balance">
                接着做手上的事。
              </h1>
              <p className="mt-3 max-w-prose text-ui leading-relaxed text-muted-foreground">
                项目、对话与交付成果，放在同一个工作台。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!homeDir}
                onClick={() => useProjectImportDialogStore.getState().openDialog()}
              >
                <ClockIcon aria-hidden className="size-4" />
                导入历史
              </Button>
              <Button disabled={!homeDir || !hydrated || starting} onClick={() => void startChat()}>
                <AddPlusIcon aria-hidden className="size-4" />
                {starting ? "正在准备…" : "新建对话"}
              </Button>
            </div>
          </section>
          <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_15rem]">
            <section className="min-w-0" aria-labelledby="workbench-recent">
              <div className="flex flex-wrap items-center gap-3">
                <h2 id="workbench-recent" className="text-ui-lg font-semibold">
                  最近任务
                </h2>
                {hydrated && activeCount > 0 && (
                  <span className="text-ui-sm text-muted-foreground">
                    {activeCount} 项正在进行或等待处理
                  </span>
                )}
                <label className="relative ml-auto block w-full sm:w-56">
                  <SearchIcon
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setLimit(12);
                    }}
                    aria-label="搜索任务或项目"
                    placeholder="搜索任务或项目"
                    className="pl-9"
                  />
                </label>
              </div>
              {config.isError && (
                <div
                  role="alert"
                  className="mt-5 rounded-lg border border-destructive/30 p-4 text-ui"
                >
                  <p>暂时无法读取执行环境，请检查本地服务是否正在运行。</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void config.refetch()}
                  >
                    重新连接
                  </Button>
                </div>
              )}
              {!hydrated ? (
                <p role="status" className="py-12 text-ui text-muted-foreground">
                  正在读取任务记录…
                </p>
              ) : threads.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed px-6 py-12">
                  <h3 className="text-ui-lg font-medium">
                    {search ? "没有找到匹配的任务" : "从已有的工作开始"}
                  </h3>
                  <p className="mt-2 max-w-prose text-ui leading-relaxed text-muted-foreground">
                    {search
                      ? "试试任务标题或项目名称，也可以清空搜索查看全部。"
                      : "导入 Codex 或 Claude Code 的本地历史，或者新建一段对话。任务会按最近活动排列在这里。"}
                  </p>
                  {search && (
                    <Button
                      className="mt-4"
                      variant="outline"
                      size="sm"
                      onClick={() => setSearch("")}
                    >
                      清空搜索
                    </Button>
                  )}
                </div>
              ) : (
                <ul className="mt-4 divide-y border-y">
                  {threads.slice(0, limit).map((thread) => {
                    const status = resolveThreadStatusPill({
                      thread,
                      hasPendingApprovals: thread.hasPendingApprovals,
                      hasPendingUserInput: thread.hasPendingUserInput,
                    });
                    return (
                      <li key={thread.id}>
                        <Link
                          to="/$threadId"
                          params={{ threadId: thread.id }}
                          className="group flex min-w-0 items-center gap-3 rounded-lg px-2 py-4 transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
                        >
                          <ProviderIcon
                            provider={thread.modelSelection.provider}
                            className="size-5 shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-ui font-medium">
                              <HighlightedSearchText text={thread.title} query={search} />
                            </p>
                            <p className="mt-1 truncate text-ui-sm text-muted-foreground">
                              {projectById.get(thread.projectId)?.name ?? "对话"} ·{" "}
                              {PROVIDER_DISPLAY_NAMES[thread.modelSelection.provider]}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1 text-ui-sm">
                            <span className={cn(status?.colorClass ?? "text-muted-foreground")}>
                              {status ? STATUS_LABELS[status.label] : "可继续"}
                            </span>
                            <time
                              dateTime={thread.updatedAt ?? thread.createdAt}
                              className="text-muted-foreground"
                            >
                              {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                            </time>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {threads.length > limit && (
                <Button
                  variant="ghost"
                  className="mt-3"
                  onClick={() => setLimit((value) => value + 12)}
                >
                  显示更多任务
                </Button>
              )}
              <section className="mt-10" aria-labelledby="workbench-projects">
                <h2 id="workbench-projects" className="text-ui-lg font-semibold">
                  项目文件夹
                </h2>
                <p className="mt-2 text-ui-sm text-muted-foreground">
                  沿用现有目录，在对应项目中开始下一项工作。
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {projects
                    .filter((project) => project.kind === "project")
                    .map((project) => (
                      <Button
                        key={project.id}
                        variant="outline"
                        className="max-w-full"
                        title={project.cwd}
                        disabled={!hydrated}
                        onClick={() => {
                          void handleNewThread(project.id, { envMode: "local" })
                            .then((threadId) => {
                              if (!threadId)
                                toastManager.add({
                                  type: "error",
                                  title: "项目对话尚未创建，请稍后重试",
                                });
                            })
                            .catch((error: unknown) =>
                              toastManager.add({
                                type: "error",
                                title: "无法打开项目",
                                description: error instanceof Error ? error.message : String(error),
                              }),
                            );
                        }}
                      >
                        <FolderOpenIcon aria-hidden className="size-4" />
                        <span className="truncate">{project.name}</span>
                      </Button>
                    ))}
                  {projects.every((project) => project.kind !== "project") && (
                    <p className="text-ui text-muted-foreground">
                      从左侧 Projects 添加文件夹，或通过「导入历史」带入已有项目。
                    </p>
                  )}
                </div>
              </section>
            </section>
            <aside
              className="space-y-8 border-t pt-6 lg:border-t-0 lg:pt-0"
              aria-label="Agent 与工作入口"
            >
              <section>
                <div className="flex items-center justify-between">
                  <h2 className="text-ui-lg font-semibold">你的 Agents</h2>
                  <Link
                    to="/settings"
                    search={{ section: "providers" }}
                    className="rounded text-ui-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    管理
                  </Link>
                </div>
                <p className="mt-2 text-ui-sm leading-relaxed text-muted-foreground">
                  使用执行环境中已配置的账号。
                </p>
                <ul className="mt-4 divide-y">
                  {visibleProviders.map((provider) => (
                    <li key={provider.provider} className="flex items-center gap-3 py-3">
                      <ProviderIcon provider={provider.provider} className="size-5 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-ui font-medium">
                          {PROVIDER_DISPLAY_NAMES[provider.provider]}
                        </p>
                        <p
                          className="mt-0.5 text-ui-sm text-muted-foreground"
                          title={provider.message}
                        >
                          {settings.disabledProviders.includes(provider.provider)
                            ? "已停用"
                            : provider.available &&
                                provider.status === "ready" &&
                                provider.authStatus === "authenticated"
                              ? "已就绪"
                              : !provider.available
                                ? "暂不可用"
                                : provider.authStatus === "unauthenticated"
                                  ? "需要登录"
                                  : "查看配置状态"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {!config.data && (
                  <p className="mt-3 text-ui-sm text-muted-foreground">
                    {config.isError ? "暂时无法读取 Agent 状态" : "正在检测 Agents…"}
                  </p>
                )}
                {config.data && visibleProviders.length === 0 && (
                  <p className="mt-3 text-ui-sm text-muted-foreground">请在设置中启用 Agent。</p>
                )}
              </section>
              <WorkbenchUsageSection />
              <nav className="space-y-1 border-t pt-5" aria-label="工作方式">
                <Button
                  render={<Link to="/studio" />}
                  variant="ghost"
                  className="w-full justify-start"
                >
                  Studio · 文档与成果
                </Button>
                <Button
                  render={<Link to="/automations" />}
                  variant="ghost"
                  className="w-full justify-start"
                >
                  自动化 · 定时任务
                </Button>
                <Button
                  render={<Link to="/kanban" />}
                  variant="ghost"
                  className="w-full justify-start"
                >
                  任务看板
                </Button>
              </nav>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

/** Live remaining quota for every signed-in provider; details live in Settings → Usage. */
function WorkbenchUsageSection() {
  const { usageQuery, snapshots, threadRateLimits, codexHomePath } = useProviderUsageOverview();
  return (
    <section aria-labelledby="workbench-usage">
      <div className="flex items-center justify-between">
        <h2 id="workbench-usage" className="text-ui-lg font-semibold">
          用量
        </h2>
        <Link
          to="/settings"
          search={{ section: "usage" }}
          className="rounded text-ui-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          详情
        </Link>
      </div>
      <p className="mt-2 text-ui-sm leading-relaxed text-muted-foreground">
        各模型的剩余额度与重置时间，约每分钟更新。
      </p>
      {usageQuery.isPending && !usageQuery.data ? (
        <p className="mt-3 text-ui-sm text-muted-foreground">正在读取用量…</p>
      ) : usageQuery.isError && !usageQuery.data ? (
        <p className="mt-3 text-ui-sm text-muted-foreground">暂时无法读取用量。</p>
      ) : snapshots.length === 0 ? (
        <p className="mt-3 text-ui-sm text-muted-foreground">还没有可显示用量的模型账号。</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {snapshots.map((snapshot) => (
            <ProviderUsageCard
              key={snapshot.provider}
              snapshot={snapshot}
              threadRateLimits={threadRateLimits}
              codexHomePath={codexHomePath}
            />
          ))}
        </div>
      )}
    </section>
  );
}
