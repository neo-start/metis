import { createContext } from "react";
import type { ChatImageAttachment } from "~/types";
/** Remote paths must never reach this computer's file services. */
export const RemoteChatContentContext = createContext(false);
export const RemoteImagePreviewContext = createContext<
  ((image: ChatImageAttachment) => Promise<string>) | null
>(null);
