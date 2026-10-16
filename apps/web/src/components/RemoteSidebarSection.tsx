import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { PeerOverview } from "@synara/contracts";
import { PlusIcon, MessageCircleIcon } from "~/lib/icons";
import { randomUUID } from "~/lib/utils";
import { remoteChat, remoteChatsKey, useRemoteChats, useRemoteDevices } from "~/lib/remoteChats";
import { SidebarGroup, SidebarMenuButton } from "./ui/sidebar";
import { IconButton } from "./ui/icon-button";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { toastManager } from "./ui/toast";

function RemoteDevice({
  instance,
  peer,
  enabled,
}: {
  instance: string;
  peer: PeerOverview["peers"][number];
  enabled: boolean;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [expanded, setExpanded] = useState(true);
  const chats = useRemoteChats(instance, peer.id, enabled);
  const create = useMutation({
    mutationFn: async () => {
      const key = `metis-remote-create:${instance}:${peer.id}`;
      const id = localStorage.getItem(key) ?? randomUUID();
      localStorage.setItem(key, id);
      const result = await remoteChat(peer.id, { action: "chat.open", id, title: "新对话" });
      localStorage.removeItem(key);
      cache.setQueryData(remoteChatsKey(instance, peer.id), result);
      setExpanded(true);
      await navigate({ to: "/remote/$peerId/$chatId", params: { peerId: peer.id, chatId: id } });
    },
    onError: (error) =>
      toastManager.add({ type: "error", title: "无法新建远端对话", description: error.message }),
  });
  return (
    <div className="mb-1">
      <div className="group/remote flex items-center gap-1">
        <SidebarMenuButton
          className="min-w-0 flex-1 text-ui"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <DisclosureChevron open={expanded} />
          <span className="truncate">{peer.name}</span>
          <span
            className={`ml-auto size-1.5 shrink-0 rounded-full ${enabled && peer.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
            title={enabled && peer.online ? "在线" : "离线"}
          />
        </SidebarMenuButton>
        <IconButton
          size="sm"
          variant="ghost"
          label={`与 ${peer.name} 新建对话`}
          title="新建对话"
          disabled={!enabled || create.isPending}
          className="shrink-0 transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-accent active:bg-accent/70 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:-translate-y-0.5 group-hover/remote:translate-y-0 group-hover/remote:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 motion-reduce:translate-y-0"
          onClick={() => create.mutate()}
        >
          <PlusIcon className="size-3.5" />
        </IconButton>
      </div>
      <DisclosureRegion open={expanded}>
        <div className="pl-4">
          {chats.data?.chats.map((chat) => (
            <SidebarMenuButton
              key={chat.id}
              size="sm"
              isActive={pathname === `/remote/${peer.id}/${chat.id}`}
              onClick={() =>
                void navigate({
                  to: "/remote/$peerId/$chatId",
                  params: { peerId: peer.id, chatId: chat.id },
                })
              }
            >
              <MessageCircleIcon className="size-3.5" />
              <span className="truncate">{chat.title}</span>
            </SidebarMenuButton>
          ))}
          {chats.error ? (
            <p className="px-2 py-1 text-ui-xs text-muted-foreground">{chats.error.message}</p>
          ) : !chats.data?.chats.length ? (
            <SidebarMenuButton
              size="sm"
              disabled={!enabled || create.isPending}
              onClick={() => create.mutate()}
              className="text-muted-foreground"
            >
              {create.isPending ? "连接中…" : "开始对话"}
            </SidebarMenuButton>
          ) : null}
        </div>
      </DisclosureRegion>
    </div>
  );
}
export function RemoteSidebarSection() {
  const devices = useRemoteDevices();
  if (!devices.owner || !devices.data?.peers.length) return null;
  return (
    <SidebarGroup className="px-1.5 py-2">
      <div className="px-2 pb-1 text-ui text-muted-foreground">Remote</div>
      {devices.data.peers.map((peer) => (
        <RemoteDevice
          key={peer.id}
          instance={devices.data!.instanceId}
          peer={peer}
          enabled={devices.data!.enabled}
        />
      ))}
    </SidebarGroup>
  );
}
