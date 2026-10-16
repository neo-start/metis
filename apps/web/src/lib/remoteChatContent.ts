import { createContext } from "react";
/** Remote paths must never reach this computer's file services. */
export const RemoteChatContentContext = createContext(false);
