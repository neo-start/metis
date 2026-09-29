// Purpose: Floating composer that retains a transcript quote while the user writes a new prompt.

import type { ThreadEnvironmentMode } from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowUpRightIcon, XIcon } from "~/lib/icons";
import { resolveThreadEnvironmentPresentation } from "~/lib/threadEnvironment";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerEnvironmentPicker } from "./ComposerEnvironmentPicker";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import {
  TranscriptQuickComposerForm,
  useTranscriptQuickComposerSubmit,
} from "./TranscriptQuickComposerForm";
import type { PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";

interface SelectionNewChatComposerProps {
  action: PendingTranscriptSelectionAction;
  defaultEnvMode: ThreadEnvironmentMode;
  canUseWorktree: boolean;
  onSend: (prompt: string, envMode: ThreadEnvironmentMode) => Promise<void>;
  onOpenInChat: (prompt: string, envMode: ThreadEnvironmentMode) => Promise<void>;
  onClose: () => void;
}

export function SelectionNewChatComposer({
  action,
  defaultEnvMode,
  canUseWorktree,
  onSend,
  onOpenInChat,
  onClose,
}: SelectionNewChatComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [envMode, setEnvMode] = useState(canUseWorktree ? defaultEnvMode : "local");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerPromptEditorHandle>(null);
  const environmentMenuOpenRef = useRef(false);
  const { busy, error, submittingRef, submit } = useTranscriptQuickComposerSubmit<
    "send" | "compose"
  >({
    readPrompt: () => inputRef.current?.readSnapshot().value ?? prompt,
    promptOptionalFor: ["compose"],
    fallbackError: "Could not start the chat. Try again.",
    onSubmit: async (nextPrompt, intent) => {
      await (intent === "send" ? onSend : onOpenInChat)(nextPrompt, envMode);
      onClose();
    },
  });
  const selections = [
    {
      type: "assistant-selection" as const,
      id: action.selection.assistantMessageId,
      ...action.selection,
    },
  ];

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const position = () => {
      const { width, height } = surface.getBoundingClientRect();
      const top =
        action.placement === "top"
          ? action.top + TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX - height
          : action.top;
      surface.style.left = `${Math.max(8, Math.min(action.left, window.innerWidth - width - 8))}px`;
      surface.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    };
    position();
    inputRef.current?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(surface);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [action]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !submittingRef.current &&
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-composer-environment-menu]")
        )
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current && !environmentMenuOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, submittingRef]);

  return (
    <div
      ref={surfaceRef}
      data-transcript-selection-action="true"
      role="dialog"
      aria-label="New chat from selection"
      className="fixed z-50 w-[320px] max-w-[calc(100vw-16px)] text-foreground"
      // No overflow on this wrapper: a scroll box is square and would clip the rounded
      // surface's shadow into hard corners. The editor caps and scrolls its own height.
      style={{ left: action.left, top: action.top }}
    >
      <TranscriptQuickComposerForm
        inputRef={inputRef}
        value={prompt}
        cursor={cursor}
        busy={busy}
        error={error}
        placeholder="Ask about this selection…"
        editorAriaLabel="Message for new chat"
        sendAriaLabel="Send to new chat"
        header={
          <>
            <AssistantSelectionsSummaryChip selections={selections} />
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => {
                  void submit("compose");
                }}
              >
                Open in chat
                <ArrowUpRightIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Close new chat composer"
                disabled={busy}
                onClick={onClose}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </>
        }
        footerLeading={
          <ComposerEnvironmentPicker
            environmentPresentation={resolveThreadEnvironmentPresentation({ envMode })}
            onEnvModeChange={setEnvMode}
            canSwitchToWorktree={canUseWorktree && envMode === "local"}
            disabled={busy}
            onOpenChange={(open) => {
              environmentMenuOpenRef.current = open;
            }}
          />
        }
        onChange={(value, nextCursor) => {
          setPrompt(value);
          setCursor(nextCursor);
        }}
        onSend={() => {
          void submit("send");
        }}
      />
    </div>
  );
}
