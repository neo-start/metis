import { useRouterState } from "@tanstack/react-router";
import { useMetisController } from "~/hooks/useMetisController";
import { SidebarGroup, SidebarMenuButton } from "./ui/sidebar";
import { SynaraLogo } from "./SynaraLogo";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";

export function MetisSidebarEntry() {
  const { owner, open, query } = useMetisController();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (!owner) return null;
  return (
    <SidebarGroup className="px-1.5 py-1">
      <SidebarMenuButton
        isActive={pathname === `/${query.data?.threadId}`}
        onClick={() => open.mutate()}
        disabled={open.isPending}
        tooltip="实例总控 · 所有对话与长期记忆"
        className="text-ui"
      >
        <SidebarLeadingIcon>
          <SynaraLogo className="size-4" />
        </SidebarLeadingIcon>
        <span className="truncate">Metis 总控</span>
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
    </SidebarGroup>
  );
}
