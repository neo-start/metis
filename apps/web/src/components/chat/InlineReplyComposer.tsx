// FILE: InlineReplyComposer.tsx
// Purpose: Composer that opens directly under an assistant turn; sending starts a
//          new branch (a fork carrying the transcript up to that turn).
// Layer: Chat transcript UI
// Exports: InlineReplyComposer

import { useEffect, useRef, useState } from "react";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { GitForkIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import {
  TranscriptQuickComposerForm,
  useTranscriptQuickComposerSubmit,
} from "./TranscriptQuickComposerForm";

interface InlineReplyComposerProps {
  /** Identity of the turn being replied to; an unsent reply survives closing and reopening. */
  readonly draftKey: string;
  readonly onSend: (prompt: string) => Promise<void>;
  readonly onClose: () => void;
  readonly className?: string;
}

// Unsent inline replies, keyed by the turn they were typed under. Session-scoped
// on purpose: a reply is a quick aside, not a document worth persisting.
const inlineReplyDraftByKey = new Map<string, string>();
// The composer lives inside a virtualised row: scrolling it away unmounts it and
// scrolling back remounts it. A send in flight must survive that (no second fork
// from a second press), and the remount must not steal focus again.
const inlineReplySendingKeys = new Set<string>();
const inlineReplyFocusedKeys = new Set<string>();
// An instance mounted while its key's send is in flight subscribes here so the
// settle (success or failure) reaches it instead of the unmounted sender.
const inlineReplySettleListeners = new Map<string, Set<(error: string | null) => void>>();

function notifyInlineReplySettled(draftKey: string, error: string | null): void {
  for (const listener of inlineReplySettleListeners.get(draftKey) ?? []) {
    listener(error);
  }
}

export function InlineReplyComposer({
  draftKey,
  onSend,
  onClose,
  className,
}: InlineReplyComposerProps) {
  const [prompt, setPrompt] = useState(() => inlineReplyDraftByKey.get(draftKey) ?? "");
  const [cursor, setCursor] = useState(() => inlineReplyDraftByKey.get(draftKey)?.length ?? 0);
  const inputRef = useRef<ComposerPromptEditorHandle>(null);
  // Mounts closed and opens on the next frame so the shared disclosure motion
  // plays on entry; closing reverses it, then hands off to `onClose` to unmount.
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { busy, error, submittingRef, submit, settle } = useTranscriptQuickComposerSubmit<"send">({
    readPrompt: () => (inputRef.current?.readSnapshot().value ?? prompt).trim(),
    isBlocked: () => inlineReplySendingKeys.has(draftKey),
    initialBusy: inlineReplySendingKeys.has(draftKey),
    fallbackError: "Could not start the branch. Try again.",
    onSubmit: async (nextPrompt) => {
      inlineReplySendingKeys.add(draftKey);
      try {
        await onSend(nextPrompt);
        inlineReplyDraftByKey.delete(draftKey);
        inlineReplyFocusedKeys.delete(draftKey);
        notifyInlineReplySettled(draftKey, null);
      } catch (cause) {
        notifyInlineReplySettled(
          draftKey,
          cause instanceof Error ? cause.message : "Could not start the branch. Try again.",
        );
        throw cause;
      } finally {
        inlineReplySendingKeys.delete(draftKey);
      }
    },
  });

  useEffect(() => {
    if (!inlineReplySendingKeys.has(draftKey)) {
      return;
    }
    const listener = (settledError: string | null) => {
      if (settledError !== null) settle(settledError);
    };
    const listeners = inlineReplySettleListeners.get(draftKey) ?? new Set();
    listeners.add(listener);
    inlineReplySettleListeners.set(draftKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) inlineReplySettleListeners.delete(draftKey);
    };
    // Subscribe once per mount: only an instance born mid-flight needs the relay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimeoutRef.current !== null) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (open && !inlineReplyFocusedKeys.has(draftKey)) {
      inlineReplyFocusedKeys.add(draftKey);
      inputRef.current?.focus();
    }
  }, [draftKey, open]);

  const requestClose = () => {
    if (closeTimeoutRef.current !== null) return;
    inlineReplyFocusedKeys.delete(draftKey);
    setOpen(false);
    closeTimeoutRef.current = setTimeout(
      onClose,
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
  };

  return (
    <div
      data-inline-reply-composer="true"
      role="group"
      aria-label="Reply from this turn"
      className={cn("w-full min-w-0 text-foreground", className)}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && !submittingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }
      }}
    >
      <TranscriptQuickComposerForm
        open={open}
        inputRef={inputRef}
        value={prompt}
        cursor={cursor}
        busy={busy}
        error={error}
        placeholder="Reply to this turn…"
        editorAriaLabel="Reply from this turn"
        sendAriaLabel="Send as a new branch"
        header={
          <>
            <span className="inline-flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
              <GitForkIcon className="size-[1.125em] shrink-0" aria-hidden />
              <span className="truncate">Reply here — starts a new branch from this turn</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close reply"
              disabled={busy}
              onClick={requestClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </>
        }
        onChange={(value, nextCursor) => {
          setPrompt(value);
          setCursor(nextCursor);
          if (value.trim()) {
            inlineReplyDraftByKey.set(draftKey, value);
          } else {
            inlineReplyDraftByKey.delete(draftKey);
          }
        }}
        onSend={() => {
          void submit("send");
        }}
      />
    </div>
  );
}
