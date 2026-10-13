import {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  PersistentCodexStartInput,
  PersistentCodexTurnInput,
  type PersistentHostMethod,
} from "@synara/contracts/persistentProviderHost";
import { Schema } from "effect";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { AGENT_GATEWAY_NO_CAPABILITIES } from "../../agentGateway/sessionLease.ts";

const decodeStart = Schema.decodeUnknownSync(PersistentCodexStartInput);
const decodeTurn = Schema.decodeUnknownSync(PersistentCodexTurnInput);
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeTurnId = Schema.decodeUnknownSync(TurnId);
const decodeRequestId = Schema.decodeUnknownSync(ApprovalRequestId);
const decodeDecision = Schema.decodeUnknownSync(ProviderApprovalDecision);
const decodeAnswers = Schema.decodeUnknownSync(ProviderUserInputAnswers);

/** The original manager, including the protocol registry and approval responders, stays here. */
export function invokeCodexHost(
  manager: CodexAppServerManager,
  method: PersistentHostMethod,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case "startSession": {
      const { gatewayMode: _gatewayMode, ...input } = decodeStart(args[0]);
      const sessions = manager.inspectPersistentSessions();
      if (sessions.some(({ session }) => session.threadId === input.threadId)) {
        throw new Error(
          "Session already exists; adopt its snapshot or explicitly stop it before replacement",
        );
      }
      if (sessions.length >= 32) throw new Error("Persistent host session limit reached");
      return manager.startSession({
        ...input,
        agentGatewayCapabilityInput: AGENT_GATEWAY_NO_CAPABILITIES,
      });
    }
    case "sendTurn": {
      const input = decodeTurn(args[0]);
      const session = manager.listSessions().find((item) => item.threadId === input.threadId);
      if (session?.activeTurnId || session?.status === "connecting")
        throw new Error("An existing turn/startup must settle before sending another prompt");
      return manager.sendTurn(input);
    }
    case "steerTurn":
      return manager.steerTurn(decodeTurn(args[0]));
    case "interruptTurn":
      return manager.interruptTurn(
        decodeThreadId(args[0]),
        args[1] === undefined ? undefined : decodeTurnId(args[1]),
      );
    case "abandonTurn": {
      const detail = args[2];
      if (typeof detail !== "string" || !detail.trim() || detail.length > 4096) {
        throw new Error(
          "Stalled-turn cleanup requires a nonempty reason of at most 4096 characters",
        );
      }
      return manager.abandonTurn(decodeThreadId(args[0]), decodeTurnId(args[1]), detail);
    }
    case "respondToRequest":
      return manager.respondToRequest(
        decodeThreadId(args[0]),
        decodeRequestId(args[1]),
        decodeDecision(args[2]),
      );
    case "respondToUserInput":
      return manager.respondToUserInput(
        decodeThreadId(args[0]),
        decodeRequestId(args[1]),
        decodeAnswers(args[2]),
      );
    case "readThread":
      return manager.readThread(decodeThreadId(args[0]));
    case "stopSession":
      return manager.stopSession(decodeThreadId(args[0]));
    case "stopAll":
      return manager.stopAll();
    case "compactThread":
      return manager.compactThread(decodeThreadId(args[0]));
    case "rollbackThread": {
      const count = args[1];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
        throw new Error("Invalid rollback count");
      return manager.rollbackThread(decodeThreadId(args[0]), count);
    }
  }
}
