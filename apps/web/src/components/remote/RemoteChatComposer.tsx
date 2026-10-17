import type { OrchestrationThread } from "@synara/contracts";
import { useRef, type ReactNode, type RefObject } from "react";
import { HiOutlineHandRaised } from "react-icons/hi2";
import { CentralIcon } from "~/lib/central-icons";
import { DeviceLaptopIcon, FastModeIcon, PlusIcon } from "~/lib/icons";
import { RUNTIME_MODE_PRESENTATION } from "~/lib/runtimeMode";
import { resolveThreadModelSummary } from "~/lib/threadModelSummary";
import { cn } from "~/lib/utils";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ProviderIcon } from "../ProviderIcon";
import { ChatComposerFooter } from "../chat/ChatComposerFooter";
import { TranscriptQuickComposerForm } from "../chat/TranscriptQuickComposerForm";
import {
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  RUNTIME_AUTO_ACCENT_CLASS_NAME,
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const noAction = () => {};

export function RemoteChatComposer({
  inputRef,
  thread,
  deviceName,
  value,
  cursor,
  busy,
  pending,
  error,
  onChange,
  onSend,
  onStop,
  attachments,
  hasAttachments,
  uploadStatus,
  onAddFiles,
}: {
  inputRef: RefObject<ComposerPromptEditorHandle | null>;
  thread: OrchestrationThread | undefined;
  deviceName: string;
  value: string;
  cursor: number;
  busy: boolean;
  pending: boolean;
  error: string | null;
  onChange: (value: string, cursor: number) => void;
  onSend: () => void;
  onStop: () => void;
  attachments: ReactNode;
  hasAttachments: boolean;
  uploadStatus: string | null;
  onAddFiles: (files: File[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const running = thread?.latestTurn?.state === "running";
  const model = resolveThreadModelSummary(thread?.modelSelection);
  const runtimeMode = thread?.runtimeMode;
  const hasContent = value.trim().length > 0 || hasAttachments;
  return (
    <div
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (!busy && !pending) onAddFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        aria-label="添加图片和文件"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onAddFiles(files);
        }}
      />
      <div className="mb-2 flex min-w-0 items-center gap-2 px-3 text-ui-sm text-muted-foreground">
        <DeviceLaptopIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{deviceName}</span>
      </div>
      <TranscriptQuickComposerForm
        layout="chat"
        inputRef={inputRef}
        value={value}
        cursor={cursor}
        busy={busy}
        editorDisabled={pending}
        error={error}
        attachments={attachments}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          if (!busy && !pending) onAddFiles(files);
        }}
        header={
          uploadStatus || pending ? (
            <span role="status" className="text-ui-xs text-muted-foreground">
              {uploadStatus ?? "消息正在确认；再次发送会确认同一条消息。"}
            </span>
          ) : null
        }
        placeholder={running ? "继续追问…" : "发消息给远端 Metis…"}
        editorAriaLabel="给远端主控的消息"
        sendAriaLabel={pending ? "确认发送" : "发送消息"}
        onChange={onChange}
        onSend={onSend}
        footer={
          <ChatComposerFooter
            isComposerFooterCompact={false}
            leadingControls={
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="添加图片和文件"
                        disabled={busy || pending}
                        onClick={() => fileInput.current?.click()}
                      />
                    }
                  >
                    <PlusIcon className="size-4" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">添加图片和文件 · 最多 8 个，单个文件 25 MB</TooltipPopup>
                </Tooltip>
                {runtimeMode && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          className={cn(
                            "inline-flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-ui-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            runtimeMode === "full-access" && RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
                            runtimeMode === "auto" && RUNTIME_AUTO_ACCENT_CLASS_NAME,
                          )}
                        />
                      }
                    >
                      {runtimeMode === "full-access" ? (
                        <CentralIcon name="shield-access" className="size-3.5 shrink-0" />
                      ) : runtimeMode === "auto" ? (
                        <CentralIcon name="shield-code" className="size-3.5 shrink-0" />
                      ) : (
                        <HiOutlineHandRaised aria-hidden="true" className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">
                        {RUNTIME_MODE_PRESENTATION[runtimeMode].label}
                      </span>
                    </TooltipTrigger>
                    <TooltipPopup side="top" variant="picker">
                      当前使用远端对话的权限设置，请在执行电脑修改。
                    </TooltipPopup>
                  </Tooltip>
                )}
                {running && hasContent && (
                  <Button type="submit" variant="ghost" size="sm" disabled={busy}>
                    {pending ? "确认发送" : "排队发送"}
                  </Button>
                )}
              </>
            }
            composerPickerControls={
              model ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        tabIndex={0}
                        className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-sm px-2 py-1 text-ui-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-80"
                      />
                    }
                  >
                    <ProviderIcon provider={model.provider} className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{model.modelLabel}</span>
                    {model.fastMode && (
                      <FastModeIcon
                        aria-hidden="true"
                        className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
                      />
                    )}
                    {model.statusLabel && (
                      <span className={cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
                        {model.statusLabel}
                      </span>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="top" variant="picker">
                    {model.modelLabel}
                    {model.statusLabel ? ` · ${model.statusLabel}` : ""}。模型由执行电脑管理。
                  </TooltipPopup>
                </Tooltip>
              ) : null
            }
            contextMeter={null}
            interactionMode="default"
            resetInteractionMode={noAction}
            sidebarAction={null}
            voice={{
              enabled: false,
              recording: false,
              transcribing: false,
              durationLabel: "",
              waveformLevels: [],
              onCancel: noAction,
              onSubmit: noAction,
              onToggle: noAction,
            }}
            pendingInput={null}
            submission={{
              phase: running ? "running" : "ready",
              busy,
              connecting: false,
              expired: false,
              preparingImages: false,
              preparingWorktree: false,
              hasContent,
              hasPendingUserInputs: false,
              showPlanFollowUp: false,
              hasPrompt: hasContent,
              onInterrupt: onStop,
              interruptDisabled: busy,
              interruptTitle: "停止远端当前回复",
              sendAriaLabel: pending ? "确认发送" : "发送消息",
              onImplementInNewThread: noAction,
            }}
          />
        }
      />
    </div>
  );
}
