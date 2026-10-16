import { useId, useRef, useState } from "react";
import type { ThreadId } from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import { TerminalIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { useTerminalStateStore } from "~/terminalStateStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "../ui/dialog";
import { randomTerminalId } from "../terminal/terminalIds";
import { terminalRuntimeRegistry } from "../terminal/terminalRuntimeRegistry";
import {
  isNativeAgentTerminal,
  NATIVE_AGENT_TERMINAL_PREFIX,
  nativeAgentTerminalCommandError,
} from "./nativeAgentTerminalSupport";

interface NativeAgentTerminalProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string> | undefined;
  terminalIds: string[];
  terminalTitles: Record<string, string>;
  activeTerminalId: string;
  onActiveTerminalChange: (terminalId: string) => void;
}

export function NativeAgentTerminal({
  threadId,
  cwd,
  runtimeEnv,
  terminalIds,
  terminalTitles,
  activeTerminalId,
  onActiveTerminalChange,
}: NativeAgentTerminalProps) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const fieldId = useId();
  const nativeTerminalIds = terminalIds.filter(isNativeAgentTerminal);

  const launch = async () => {
    if (busy.current) return;
    const validationError = nativeAgentTerminalCommandError(command);
    if (validationError) {
      setError(validationError);
      return;
    }
    const api = readNativeApi();
    if (!api || !cwd.trim()) {
      setError("The task terminal is not connected or has no working directory.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    const terminalId = `${NATIVE_AGENT_TERMINAL_PREFIX}${randomTerminalId()}`;
    const title = label.trim() || "Agent terminal";
    try {
      // Reserve the tab even if the open response is lost, so a possibly live
      // PTY remains discoverable. Opening the same ID is idempotent server-side.
      const store = useTerminalStateStore.getState();
      store.newTerminal(threadId, terminalId);
      store.setTerminalTitleOverride(threadId, terminalId, title);
      // Never put the command in persisted state or a render/reconnect effect.
      const snapshot = await api.terminal.open({
        threadId,
        terminalId,
        cwd,
        ...(runtimeEnv ? { env: runtimeEnv } : {}),
      });
      if (snapshot.status !== "running")
        throw new Error(
          "The terminal shell did not start. Inspect its output before trying again.",
        );
      await api.terminal.write({ threadId, terminalId, data: `${command}\r` });
      setCommand("");
      setLabel("");
      setOpen(false);
    } catch (cause) {
      // Delivery can be ambiguous after a disconnect. Do not retry the write.
      setError(
        `${describeErrorMessage(cause, "Could not send the command")} Inspect the terminal before launching again; a command may already have been delivered.`,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const stop = async (terminalId: string) => {
    if (busy.current) return;
    const api = readNativeApi();
    if (!api) {
      setError("The task terminal is not connected.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const confirmed = await api.dialogs.confirm(
        `Stop "${terminalTitles[terminalId] || "Agent terminal"}"?\nThis closes its shell and requests termination of its process tree. Unsaved CLI work may be lost. Terminal history is retained; the CLI's own saved sessions are unchanged.`,
      );
      if (!confirmed) return;
      await api.terminal.close({ threadId, terminalId, deleteHistory: false });
      terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
      useTerminalStateStore.getState().closeTerminal(threadId, terminalId);
    } catch (cause) {
      setError(
        describeErrorMessage(
          cause,
          "Could not stop the terminal. Its process may still be running.",
        ),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1">
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <TerminalIcon className="size-3.5" /> Agent terminal
      </Button>
      {isNativeAgentTerminal(activeTerminalId) ? (
        <span className="truncate text-ui-xs text-muted-foreground">
          Native CLI · terminal only
        </span>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!busy.current) setOpen(nextOpen);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Native Agent terminal</DialogTitle>
            <DialogDescription>
              Run a CLI without a provider adapter in this task’s terminal.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <p className="text-ui-sm text-muted-foreground">
              Terminal only: no structured approvals, usage tracking, agent status, or handoff to
              chat. The CLI manages its own permissions and sign-in. Closing this dialog leaves it
              running.
            </p>
            <div className="space-y-1 text-ui-sm">
              <span className="text-muted-foreground">New terminal directory</span>
              <p className="break-all">{cwd || "No task directory available"}</p>
              <p className="text-muted-foreground">
                Uses this task’s terminal environment on the connected server.
              </p>
            </div>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void launch();
              }}
            >
              <div className="space-y-1.5">
                <label className={dialogFieldLabelClassName} htmlFor={`${fieldId}-label`}>
                  Terminal name (optional)
                </label>
                <Input
                  id={`${fieldId}-label`}
                  value={label}
                  maxLength={80}
                  placeholder="Agent terminal"
                  disabled={pending}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className={dialogFieldLabelClassName} htmlFor={`${fieldId}-command`}>
                  CLI command
                </label>
                <Input
                  id={`${fieldId}-command`}
                  value={command}
                  maxLength={8_000}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Enter a CLI command"
                  disabled={pending}
                  aria-describedby={`${fieldId}-help`}
                  onChange={(event) => setCommand(event.target.value)}
                />
                <p id={`${fieldId}-help`} className="text-ui-xs text-muted-foreground">
                  Sent exactly as entered to a fresh shell. Include arguments and use that shell’s
                  quoting for paths with spaces. Only launch commands you trust. Commands can remain
                  in terminal or shell history.
                </p>
              </div>
              <Button type="submit" size="sm" disabled={pending || !command.trim() || !cwd.trim()}>
                {pending ? "Working…" : "Launch in new terminal"}
              </Button>
            </form>
            {error ? (
              <p role="alert" className="break-words text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            {nativeTerminalIds.length > 0 ? (
              <div className="space-y-2 border-t border-border/70 pt-3">
                <p className="text-ui-sm font-medium">This task’s Agent terminals</p>
                <p className="text-ui-xs text-muted-foreground">
                  Reattach opens the existing terminal without resending a command. A server restart
                  requires a manual CLI relaunch.
                </p>
                {nativeTerminalIds.map((terminalId) => (
                  <div key={terminalId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-ui-sm">
                      {terminalTitles[terminalId] || "Agent terminal"}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending}
                      aria-label={`Reattach ${terminalTitles[terminalId] || "Agent terminal"}`}
                      onClick={() => {
                        onActiveTerminalChange(terminalId);
                        setOpen(false);
                      }}
                    >
                      Reattach
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Stop ${terminalTitles[terminalId] || "Agent terminal"}`}
                      onClick={() => void stop(terminalId)}
                    >
                      Stop…
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
