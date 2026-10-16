import type { PeerChatReply, PeerChatRequest } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions } from "./serverReactQuery";

export const remoteDevicesKey = ["remote-devices"] as const;
export const remoteChatsKey = (instance: string, peer: string) =>
  ["remote-chats", instance, peer] as const;
export const remoteThreadKey = (instance: string, peer: string, chat: string) =>
  [...remoteChatsKey(instance, peer), chat] as const;
export function useRemoteDevices() {
  const auth = useQuery(serverAuthSessionQueryOptions());
  const owner = auth.data?.authenticated === true && auth.data.role === "owner";
  const query = useQuery({
    queryKey: remoteDevicesKey,
    queryFn: async () => (await ensureNativeApi().peers.control({ action: "overview" })).overview,
    enabled: owner,
    refetchInterval: 10_000,
    retry: false,
  });
  return { ...query, owner };
}
export async function remoteChat(peerId: string, request: PeerChatRequest): Promise<PeerChatReply> {
  const result = await ensureNativeApi().peers.control({ action: "remote", peerId, request });
  if (!result.reply?.chat) throw new Error("另一台电脑需要更新 Metis 才能使用主控对话。");
  return result.reply.chat;
}
export function useRemoteChats(instance: string, peer: string, enabled: boolean) {
  return useQuery({
    queryKey: remoteChatsKey(instance, peer),
    queryFn: () => remoteChat(peer, { action: "chat.list" }),
    enabled,
    refetchInterval: 10_000,
    retry: false,
  });
}
