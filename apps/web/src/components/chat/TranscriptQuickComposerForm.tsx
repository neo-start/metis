// FILE: TranscriptQuickComposerForm.tsx
// Purpose: Shared body for the small composers that pop out of the transcript
//          (new chat from a selection, inline reply under a turn): editor shell,
//          header/footer slots, send button, error line, and the guarded submit flow.
// Layer: Chat transcript UI
// Exports: TranscriptQuickComposerForm, useTranscriptQuickComposerSubmit

import {
  useRef,
  useState,
  type ClipboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";

import { ComposerSendArrowIcon, LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

export interface TranscriptQuickComposerSubmitState<Intent extends string> {
  readonly busy: boolean;
  readonly error: string | null;
  /** True from the moment a submit is accepted until it settles; read it in dismiss handlers. */
  readonly submittingRef: RefObject<boolean>;
  readonly submit: (intent: Intent) => Promise<void>;
  readonly settle: (error: string | null) => void;
}

/**
 * The submit flow both quick composers share: reject double submits, require a
 * prompt (per intent), mark busy, surface the failure inline, and reset on error.
 * Success leaves `busy` on — the caller is about to close or navigate away.
 */
export function useTranscriptQuickComposerSubmit<Intent extends string>(input: {
  readPrompt: () => string;
  onSubmit: (prompt: string, intent: Intent) => Promise<void>;
  /** Intents that may run with an empty prompt (e.g. "open in chat"). */
  promptOptionalFor?: readonly Intent[];
  fallbackError: string;
  /** Extra guard consulted before accepting a submit (e.g. a send already in flight elsewhere). */
  isBlocked?: () => boolean;
  initialBusy?: boolean;
}): TranscriptQuickComposerSubmitState<Intent> {
  const [busy, setBusy] = useState(input.initialBusy ?? false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  /** Leave the busy state from outside (a submit that settled in another instance). */
  const settle = (settledError: string | null) => {
    submittingRef.current = false;
    setBusy(false);
    setError(settledError);
  };

  const submit = async (intent: Intent) => {
    const prompt = input.readPrompt();
    const promptRequired = !(input.promptOptionalFor ?? []).includes(intent);
    if (submittingRef.current || input.isBlocked?.() || (promptRequired && !prompt.trim())) {
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await input.onSubmit(prompt, intent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : input.fallbackError);
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return { busy, error, submittingRef, submit, settle };
}

interface TranscriptQuickComposerFormProps {
  readonly inputRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly value: string;
  readonly cursor: number;
  readonly busy: boolean;
  readonly error: string | null;
  /** Row above the editor: context chip / hint on the left, close or extra actions on the right. */
  readonly header: ReactNode;
  readonly attachments?: ReactNode;
  readonly onPaste?: ClipboardEventHandler<HTMLElement>;
  /** Leading footer content (e.g. an environment picker); the send button always trails. */
  readonly footerLeading?: ReactNode;
  /** Full chat surfaces can reuse the standard composer footer and editor spacing. */
  readonly footer?: ReactNode;
  readonly layout?: "compact" | "chat";
  /** Lock an unconfirmed draft while keeping its retry action available. */
  readonly editorDisabled?: boolean;
  readonly placeholder: string;
  readonly editorAriaLabel: string;
  readonly sendAriaLabel: string;
  readonly onChange: (value: string, cursor: number) => void;
  /** Enter (without Shift) and the send button both call this. */
  readonly onSend: () => void;
  /**
   * Disclosure state for the form body. It animates *inside* the raised surface so
   * the surface's rounded shadow is never clipped by the disclosure's overflow box.
   */
  readonly open?: boolean;
}

export function TranscriptQuickComposerForm({
  inputRef,
  value,
  cursor,
  busy,
  error,
  header,
  attachments,
  onPaste,
  footerLeading,
  footer,
  layout = "compact",
  editorDisabled = false,
  placeholder,
  editorAriaLabel,
  sendAriaLabel,
  onChange,
  onSend,
  open = true,
}: TranscriptQuickComposerFormProps) {
  return (
    <div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
      <div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
        <DisclosureRegion open={open}>
          <form
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              onSend();
            }}
          >
            <div
              className={cn(
                COMPOSER_EDITOR_PADDING_CLASS_NAME,
                layout === "compact" && "px-2.5 pt-2 pb-1",
              )}
            >
              {(header || layout === "compact") && (
                <div className="mb-1 flex items-center justify-between gap-2">{header}</div>
              )}
              {attachments}
              <ComposerPromptEditor
                ref={inputRef}
                value={value}
                cursor={cursor}
                terminalContexts={[]}
                disabled={busy || editorDisabled}
                ariaLabel={editorAriaLabel}
                className={layout === "compact" ? "min-h-[1lh]" : ""}
                placeholder={placeholder}
                onRemoveTerminalContext={() => {}}
                onPaste={onPaste ?? (() => {})}
                onChange={onChange}
                onCommandKeyDown={(key, event) => {
                  if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                  onSend();
                  return true;
                }}
              />
            </div>
            {error ? (
              <p role="alert" className="px-3 pb-2 text-ui leading-snug text-destructive">
                {error}
              </p>
            ) : null}
            {footer ?? (
              <div
                className={cn(
                  COMPOSER_FOOTER_ROW_CLASS_NAME,
                  "gap-2",
                  !footerLeading && "justify-end",
                )}
              >
                {footerLeading}
                <Button
                  type="submit"
                  variant="prominent"
                  size="icon-xs"
                  className="size-7 rounded-full sm:size-7"
                  aria-label={sendAriaLabel}
                  disabled={busy || !value.trim()}
                >
                  {busy ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : (
                    <ComposerSendArrowIcon
                      aria-hidden="true"
                      className="size-5 shrink-0 translate-y-px"
                    />
                  )}
                </Button>
              </div>
            )}
          </form>
        </DisclosureRegion>
      </div>
    </div>
  );
}
