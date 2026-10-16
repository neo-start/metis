import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import { MessageCircleIcon } from "~/lib/icons";
import { useMetisController } from "~/hooks/useMetisController";
import { SidebarGroup, SidebarMenuButton } from "./ui/sidebar";
import { SynaraLogo } from "./SynaraLogo";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";

export function MetisSidebarEntry() {
  const navigate = useNavigate();
  const summaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const incoming = summaries.filter(
    (thread) => thread.id.startsWith("metis-remote-") && !thread.archivedAt,
  );
  const { owner, open, query } = useMetisController();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (!owner) return null;
  return (
    <SidebarGroup className="px-1.5 pt-1 pb-2">
      <SidebarMenuButton
        isActive={pathname === `/${query.data?.threadId}`}
        onClick={() => open.mutate()}
        disabled={open.isPending}
        tooltip="实例总控 · 所有对话与长期记忆"
        className="h-14 rounded-xl border border-primary/15 bg-primary/5 px-3 text-ui-lg shadow-sm hover:bg-primary/10 active:bg-primary/15 data-active:bg-primary/10"
      >
        <SidebarLeadingIcon>
          <SynaraLogo className="size-6" />
        </SidebarLeadingIcon>
        <span className="truncate font-semibold">Metis 总控</span>
        <span className="ml-auto text-ui-xs text-muted-foreground">
          {open.isPending
            ? "打开中…"
            : query.data?.reflection?.state === "running"
              ? "整理记忆"
              : query.data?.reflection?.state === "paused"
                ? "需处理"
                : ""}
        </span>
      </SidebarMenuButton>
      {incoming.map((thread) => (
        <SidebarMenuButton
          key={thread.id}
          size="sm"
          isActive={pathname === `/${thread.id}`}
          onClick={() => void navigate({ to: "/$threadId", params: { threadId: thread.id } })}
          className="mt-1 pl-3 text-ui-sm"
        >
          <MessageCircleIcon className="size-3.5" />
          <span className="truncate">{thread.title}</span>
        </SidebarMenuButton>
      ))}
    </SidebarGroup>
  );
}
