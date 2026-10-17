import {
  PEER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  type PeerChatAttachment,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import {
  buildComposerFileAttachmentsFromFiles,
  prepareComposerImageAttachmentsFromFiles,
} from "~/lib/composerSend";
import { remoteChat } from "~/lib/remoteChats";

type DraftAttachment = ComposerImageAttachment | ComposerFileAttachment;
const dispose = (item: DraftAttachment) => {
  if (item.type === "image" && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
};

export function useRemoteChatAttachments(peerId: string, chatId: string) {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const current = useRef(items);
  const mounted = useRef(true);
  const previews = useRef(new Map<string, string>());
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = (next: DraftAttachment[]) => {
    current.current = next;
    setItems(next);
  };
  useEffect(() => {
    mounted.current = true;
    const previewUrls = previews.current;
    return () => {
      mounted.current = false;
      current.current.forEach(dispose);
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.clear();
    };
  }, []);
  const clear = useCallback(() => {
    current.current.forEach(dispose);
    current.current = [];
    setItems([]);
  }, []);
  const add = async (files: File[]) => {
    if (preparingRef.current) {
      setError("正在准备附件，请稍后再添加。");
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    setError(null);
    try {
      const nonEmpty = files.filter((file) => file.size > 0);
      const images = await prepareComposerImageAttachmentsFromFiles({
        files: nonEmpty.filter((file) => file.type.startsWith("image/")),
        existingAttachmentCount: current.current.length,
      });
      if (!mounted.current) {
        images.images.forEach(dispose);
        return;
      }
      const documents = buildComposerFileAttachmentsFromFiles({
        files: nonEmpty.filter((file) => !file.type.startsWith("image/")),
        existingAttachmentCount: current.current.length + images.images.length,
      });
      update([...current.current, ...images.images, ...documents.files]);
      setError(
        images.error ??
          documents.error ??
          (nonEmpty.length !== files.length ? "不能添加空文件。" : null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加附件。");
    } finally {
      preparingRef.current = false;
      if (mounted.current) setPreparing(false);
    }
  };
  const cancel = async (attachments: readonly PeerChatAttachment[]) => {
    await Promise.allSettled(
      attachments.map((attachment) =>
        remoteChat(peerId, {
          action: "chat.attachment.cancel",
          chatId,
          attachmentId: attachment.id,
        }),
      ),
    );
  };
  const stage = async (): Promise<PeerChatAttachment[]> => {
    const reserved: PeerChatAttachment[] = [];
    const staged: PeerChatAttachment[] = [];
    setError(null);
    try {
      for (const item of current.current) {
        if (!item.file) throw new Error(`请重新添加 ${item.name}。`);
        setProgress(`正在上传 ${item.name} · 0%`);
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const begin = await remoteChat(peerId, {
          action: "chat.attachment.begin",
          chatId,
          type: item.type,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: bytes.length,
        });
        if (!begin.attachment)
          throw new Error("远端未确认附件上传，请更新并重启两台电脑的 Metis。");
        reserved.push(begin.attachment);
        for (let offset = 0; offset < bytes.length; offset += PEER_ATTACHMENT_CHUNK_BYTES) {
          if (!mounted.current) throw new Error("已离开对话，附件上传已取消。");
          const chunk = bytes.subarray(offset, offset + PEER_ATTACHMENT_CHUNK_BYTES);
          let binary = "";
          for (const byte of chunk) binary += String.fromCharCode(byte);
          await remoteChat(peerId, {
            action: "chat.attachment.chunk",
            chatId,
            attachmentId: begin.attachment.id,
            offset,
            data: btoa(binary),
          });
          setProgress(
            `正在上传 ${item.name} · ${Math.round((Math.min(offset + chunk.length, bytes.length) / bytes.length) * 100)}%`,
          );
        }
        const finish = await remoteChat(peerId, {
          action: "chat.attachment.finish",
          chatId,
          attachmentId: begin.attachment.id,
          sha256,
        });
        if (!finish.attachment) throw new Error("远端未确认附件上传完成。");
        staged.push(finish.attachment);
      }
      if (!mounted.current) throw new Error("已离开对话，附件上传已取消。");
      return staged;
    } catch (cause) {
      await cancel(reserved);
      const message = cause instanceof Error ? cause.message : "附件上传失败，请重试。";
      if (mounted.current) setError(message);
      throw cause;
    } finally {
      if (mounted.current) setProgress(null);
    }
  };
  const preview = useCallback(
    async (image: ChatImageAttachment): Promise<string> => {
      const cached = previews.current.get(image.id);
      if (cached) return cached;
      if (image.sizeBytes <= 0 || image.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        throw new Error("图片大小无效。");
      const bytes = new Uint8Array(image.sizeBytes);
      for (let offset = 0; offset < bytes.length; ) {
        if (!mounted.current) throw new Error("已离开对话。");
        const result = await remoteChat(peerId, {
          action: "chat.attachment.read",
          chatId,
          attachmentId: image.id,
          offset,
        });
        const data = atob(result.attachmentData ?? "");
        if (
          !data.length ||
          data.length > PEER_ATTACHMENT_CHUNK_BYTES ||
          offset + data.length > bytes.length ||
          result.attachment?.sizeBytes !== bytes.length
        )
          throw new Error("远端图片数据不完整。");
        for (let index = 0; index < data.length; index++)
          bytes[offset + index] = data.charCodeAt(index);
        offset += data.length;
      }
      if (!mounted.current) throw new Error("已离开对话。");
      const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
      previews.current.set(image.id, url);
      return url;
    },
    [peerId, chatId],
  );
  return {
    items,
    preparing,
    preparingRef,
    progress,
    error,
    add,
    stage,
    cancel,
    clear,
    preview,
    remove: (id: string) => {
      current.current.filter((item) => item.id === id).forEach(dispose);
      update(current.current.filter((item) => item.id !== id));
    },
  };
}
