import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { useChatTranscriptScroll } from "../chat/useChatTranscriptScroll";
import type { OrchestrationThread, PeerChatRequest, PeerChatReply } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppSettings } from "~/appSettings";
import { useTheme } from "~/hooks/useTheme";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { remoteChat, remoteChatsKey, remoteThreadKey, useRemoteDevices } from "~/lib/remoteChats";
import { RemoteChatContentContext } from "~/lib/remoteChatContent";
import { WorkspaceFileOpenerContext } from "~/lib/workspaceFileOpener";
import { cn, randomUUID } from "~/lib/utils";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "~/session-logic";
import { normalizeChatMessage } from "~/storeNormalization";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { RenameDialog } from "../RenameDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ComposerColumnFrame } from "../chat/ComposerColumnFrame";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { UserInputQuestionForm } from "../chat/UserInputQuestionForm";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { TranscriptQuickComposerForm } from "../chat/TranscriptQuickComposerForm";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
} from "../chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "../chat/composerPickerStyles";

type Snapshot = {
  thread: OrchestrationThread;
  revision?: string | undefined;
  before?: string | null | undefined;
};
const noAction = () => {};
const remoteFileOpener = {
  openFile: () => {
    toastManager.add({
      type: "info",
      title: "文件位于远端电脑",
      description: "请在执行电脑查看此文件。",
    });
    return true;
  },
};
const readStorage = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

function RemoteQuestion({
  prompt,
  busy,
  onAnswer,
}: {
  prompt: ReturnType<typeof derivePendingUserInputs>[number];
  busy: boolean;
  onAnswer: (
    answers: NonNullable<ReturnType<typeof buildPendingUserInputAnswers>>,
  ) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const question = prompt.questions[index];
  const advance = async (overrides?: Record<string, PendingUserInputDraftAnswer>) => {
    const next = { ...answers, ...overrides };
    if (index < prompt.questions.length - 1) {
      setIndex(index + 1);
      return;
    }
    const result = buildPendingUserInputAnswers(prompt.questions, next);
    if (!result) return;
    try {
      await onAnswer(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败");
    }
  };
  return (
    <UserInputQuestionForm
      questions={prompt.questions}
      submissionVersion={0}
      isResponding={busy}
      answers={answers}
      questionIndex={index}
      onToggleOption={(id, label) => {
        const item = prompt.questions.find((q) => q.id === id)!;
        const next = togglePendingUserInputOptionSelection(item, answers[id], label);
        setAnswers((current) => ({ ...current, [id]: next }));
        return next;
      }}
      onAdvance={(overrides) => void advance(overrides)}
      onPrevious={() => setIndex(Math.max(0, index - 1))}
    >
      {question && (
        <Input
          aria-label="自定义回答"
          placeholder="输入回答…"
          value={answers[question.id]?.customAnswer ?? ""}
          onChange={(event) =>
            setAnswers((current) => ({
              ...current,
              [question.id]: { customAnswer: event.target.value },
            }))
          }
        />
      )}
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
      <Button type="button" size="sm" disabled={busy} onClick={() => void advance()}>
        {index < prompt.questions.length - 1 ? "下一项" : "提交回答"}
      </Button>
    </UserInputQuestionForm>
  );
}

function Conversation({
  instance,
  peerId,
  chatId,
  name,
  enabled,
}: {
  instance: string;
  peerId: string;
  chatId: string;
  name: string;
  enabled: boolean;
}) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const key = remoteThreadKey(instance, peerId, chatId);
  const storageKey = `metis-remote-draft:${instance}:${peerId}:${chatId}`;
  const pendingKey = `${storageKey}:pending`;
  const [draft, setDraft] = useState(() => readStorage(storageKey, ""));
  const [cursor, setCursor] = useState(draft.length);
  const [pending, setPending] = useState<Extract<PeerChatRequest, { action: "chat.send" }> | null>(
    () => readStorage(pendingKey, null),
  );
  const pendingRef = useRef(pending);
  const submittingRef = useRef(false);
  const editor = useRef<ComposerPromptEditorHandle | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const [older, setOlder] = useState<OrchestrationThread["messages"]>([]);
  const [olderThreadId, setOlderThreadId] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [renameOpen, setRenameOpen] = useState(false);
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    refetchInterval: 1500,
    queryFn: async (): Promise<Snapshot> => {
      const previous = cache.getQueryData<Snapshot>(key);
      const result = await remoteChat(peerId, {
        action: "chat.read",
        chatId,
        ...(previous?.revision ? { revision: previous.revision } : {}),
      });
      if (!result.thread) {
        if (previous) return previous;
        throw new Error("远端没有返回对话内容，请重试。");
      }
      // Keep already received messages while polling the current tail. Old pages
      // and streamed updates are never injected into the local orchestration store.
      const sameThread = previous?.thread.id === result.thread.id;
      const messages = sameThread
        ? [
            ...new Map(
              [...previous.thread.messages, ...result.thread.messages].map((message) => [
                message.id,
                message,
              ]),
            ).values(),
          ]
        : result.thread.messages;
      return {
        thread: { ...result.thread, messages },
        revision: result.revision,
        before: sameThread ? previous.before : result.before,
      };
    },
  });
  const thread = query.data?.thread;
  const mutate = useMutation({
    mutationFn: (request: PeerChatRequest) => remoteChat(peerId, request),
    onSuccess: async (result: PeerChatReply) => {
      if (result.chats.length) cache.setQueryData(remoteChatsKey(instance, peerId), result);
      await Promise.all([
        cache.invalidateQueries({ queryKey: remoteChatsKey(instance, peerId), exact: true }),
        cache.invalidateQueries({ queryKey: key }),
      ]);
    },
    onError: (error) =>
      toastManager.add({ type: "error", title: "远端操作未确认", description: error.message }),
  });
  const history = useMutation({
    mutationFn: async () => {
      scroll.onTranscriptNavigate();
      const before = olderCursor === undefined ? query.data?.before : olderCursor;
      if (!before) return;
      const page = await remoteChat(peerId, { action: "chat.read", chatId, before });
      if (page.thread) {
        setOlderThreadId(page.thread.id);
        setOlder((current) => [...page.thread!.messages, ...current]);
      }
      setOlderCursor(page.before ?? null);
    },
    onError: (error) =>
      toastManager.add({ type: "error", title: "无法加载历史", description: error.message }),
  });
  const send = async () => {
    if (
      submittingRef.current ||
      mutate.isPending ||
      !enabled ||
      (!pendingRef.current && !draft.trim())
    )
      return;
    submittingRef.current = true;
    scroll.armTranscriptAutoFollow(scrollThreadId, true);
    const request = pendingRef.current ?? {
      action: "chat.send" as const,
      chatId,
      id: randomUUID(),
      text: draft.trim(),
    };
    pendingRef.current = request;
    setPending(request);
    localStorage.setItem(pendingKey, JSON.stringify(request));
    try {
      await mutate.mutateAsync(request);
      pendingRef.current = null;
      setPending(null);
      localStorage.removeItem(pendingKey);
      setDraft("");
      setCursor(0);
      localStorage.removeItem(storageKey);
    } catch {
      /* Stable id and text remain available for confirmation/retry. */
    } finally {
      submittingRef.current = false;
    }
  };
  const stop = () => {
    if (thread?.latestTurn)
      mutate.mutate({
        action: "chat.stop",
        chatId,
        id: randomUUID(),
        turnId: thread.latestTurn.turnId,
      });
  };
  const messages = useMemo(() => {
    const merged = new Map(
      [...(olderThreadId === thread?.id ? older : []), ...(thread?.messages ?? [])].map(
        (message) => [message.id, message],
      ),
    );
    return [...merged.values()].map((message) =>
      normalizeChatMessage({ ...message, attachments: [], skills: [], mentions: [] }, undefined),
    );
  }, [older, olderThreadId, thread?.id, thread?.messages]);
  const timeline = useMemo(
    () =>
      deriveTimelineEntries(
        messages,
        [...(thread?.proposedPlans ?? [])],
        deriveWorkLogEntries(thread?.activities ?? [], thread?.latestTurn?.turnId),
      ),
    [messages, thread?.proposedPlans, thread?.activities, thread?.latestTurn?.turnId],
  );
  const scrollThreadId = ThreadId.makeUnsafe(`remote:${instance}:${peerId}:${chatId}`);
  const hasStreamingAssistantText = messages.some(
    (message) => message.role === "assistant" && message.streaming && message.text.length > 0,
  );
  const scroll = useChatTranscriptScroll({
    activeThreadId: scrollThreadId,
    legendListRef: listRef,
    timelineEntries: timeline,
    hasStreamingAssistantText,
    composerTranscriptInsetPx: 0,
    isInactiveSplitPane: false,
  });
  useEffect(() => {
    if (
      submittingRef.current ||
      !pending ||
      !thread?.messages.some((message) => message.id === `peer:chat:${instance}:${pending.id}`)
    )
      return;
    pendingRef.current = null;
    setPending(null);
    setDraft("");
    setCursor(0);
    localStorage.removeItem(pendingKey);
    localStorage.removeItem(storageKey);
    mutate.reset();
  }, [pending, thread?.messages, instance, pendingKey, storageKey, mutate]);
  const approval = thread
    ? derivePendingApprovals(thread.activities, thread.pendingInteractions)[0]
    : undefined;
  const questions = thread
    ? derivePendingUserInputs(thread.activities, thread.pendingInteractions)[0]
    : undefined;
  const running = thread?.latestTurn?.state === "running";
  const gutter = useDesktopTopBarTrafficLightGutterClassName();
  const rightGutter = useDesktopTopBarWindowControlsGutterClassName();
  const title = thread?.title.replace(/^Remote · /, "") ?? "Metis 总控";
  return (
    <RouteInsetSurface>
      <div className={cn("flex h-full min-h-0 flex-col", CHAT_BACKGROUND_CLASS_NAME)}>
        <header
          className={cn(
            "flex shrink-0 items-center gap-3",
            CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            gutter,
            rightGutter,
          )}
        >
          <SidebarHeaderNavigationControls />
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-medium">{title}</div>
            <div className="truncate text-ui-xs text-muted-foreground">
              {name} · Metis 总控 ·{" "}
              {!enabled
                ? "协作已关闭"
                : query.error
                  ? "连接中断"
                  : query.data
                    ? "已连接"
                    : "连接中…"}
            </div>
          </div>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="sm" aria-label="对话操作" />}>
              ···
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end">
              <MenuItem disabled={!thread || mutate.isPending} onClick={() => setRenameOpen(true)}>
                重命名
              </MenuItem>
              <MenuItem
                disabled={!thread || running || mutate.isPending}
                onClick={() =>
                  void mutate
                    .mutateAsync({ action: "chat.archive", chatId, id: randomUUID() })
                    .then(() => navigate({ to: "/" }))
                    .catch(noAction)
                }
              >
                归档对话
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        </header>
        {query.error && (
          <div
            role="status"
            className="flex items-center gap-2 px-4 py-2 text-ui text-muted-foreground"
          >
            <span className="flex-1">{query.error.message} · 已加载的内容保留</span>
            <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
              重连
            </Button>
          </div>
        )}
        {(olderCursor === undefined ? query.data?.before : olderCursor) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={history.isPending}
            onClick={() => history.mutate()}
          >
            加载更早的消息
          </Button>
        )}
        <div className="relative min-h-0 flex-1">
          <RemoteChatContentContext.Provider value={true}>
            <WorkspaceFileOpenerContext.Provider value={remoteFileOpener}>
              <MessagesTimeline
                listRef={listRef}
                followLiveOutput={hasStreamingAssistantText && !scroll.isUserScrollDetached}
                onIsAtEndChange={scroll.onIsAtEndChange}
                onNavigate={scroll.onTranscriptNavigate}
                onMessagesScroll={scroll.onMessagesScrollBase}
                onMessagesWheel={scroll.onMessagesWheelBase}
                onMessagesClickCapture={scroll.onMessagesClickCaptureBase}
                onMessagesPointerDown={scroll.onMessagesPointerDownBase}
                onMessagesPointerUp={scroll.onMessagesPointerUpBase}
                onMessagesPointerCancel={scroll.onMessagesPointerCancelBase}
                onMessagesTouchStart={scroll.onMessagesTouchStartBase}
                onMessagesTouchMove={scroll.onMessagesTouchMoveBase}
                onMessagesTouchEnd={scroll.onMessagesTouchEndBase}
                hasMessages={messages.length > 0}
                isWorking={running}
                activeTurnInProgress={running}
                activeTurnStartedAt={thread?.latestTurn?.startedAt ?? null}
                timelineEntries={timeline}
                messageChangeSignal={thread?.messages}
                turnDiffSummaryByAssistantMessageId={new Map()}
                revertTurnCountByUserMessageId={new Map()}
                onRespondToAsyncUserInput={async (messageId, answers) => {
                  await mutate.mutateAsync({
                    action: "chat.async-answer",
                    chatId,
                    id: randomUUID(),
                    messageId,
                    answers: [...answers],
                  });
                }}
                onOpenTurnDiff={() => {
                  remoteFileOpener.openFile();
                }}
                onRevertUserMessage={noAction}
                isRevertingCheckpoint={false}
                onImageExpand={noAction}
                markdownCwd={undefined}
                workspaceRoot={undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={settings.timestampFormat}
                chatFontSizePx={settings.chatFontSizePx}
                emptyStateContent={
                  <div className="text-center text-ui text-muted-foreground">
                    {query.isPending
                      ? "连接远端主控…"
                      : "与同一个 Metis 开始新的对话，共享记忆，独立上下文。"}
                  </div>
                }
              />
            </WorkspaceFileOpenerContext.Provider>
          </RemoteChatContentContext.Provider>
        </div>
        <div className="shrink-0 px-3 pb-3 pt-2">
          <ComposerColumnFrame>
            {scroll.showScrollToBottom && (
              <Button variant="ghost" size="sm" onClick={scroll.onScrollToBottom}>
                回到最新消息
              </Button>
            )}
            {thread?.session?.lastError && (
              <p role="alert" className="pb-2 text-ui text-destructive">
                {thread.session.lastError}
              </p>
            )}
            {approval && (
              <ComposerPendingApprovalPanel
                approval={approval}
                pendingCount={1}
                isResponding={mutate.isPending}
                onRespond={async (requestId, decision, lifecycleGeneration) => {
                  await mutate.mutateAsync({
                    action: "chat.approval",
                    chatId,
                    id: randomUUID(),
                    requestId,
                    decision,
                    ...(lifecycleGeneration ? { lifecycleGeneration } : {}),
                  });
                }}
              />
            )}
            {questions && (
              <RemoteQuestion
                key={`${questions.requestId}:${questions.lifecycleGeneration}`}
                prompt={questions}
                busy={mutate.isPending}
                onAnswer={async (answers) => {
                  await mutate.mutateAsync({
                    action: "chat.answer",
                    chatId,
                    id: randomUUID(),
                    requestId: questions.requestId,
                    ...(questions.lifecycleGeneration
                      ? { lifecycleGeneration: questions.lifecycleGeneration }
                      : {}),
                    answers,
                  });
                }}
              />
            )}
            <TranscriptQuickComposerForm
              inputRef={editor}
              value={pending?.text ?? draft}
              cursor={cursor}
              busy={!enabled || mutate.isPending}
              error={mutate.error?.message ?? null}
              header={
                pending ? (
                  <span className="text-ui-xs text-muted-foreground">
                    消息正在确认；再次发送会确认同一条消息。
                  </span>
                ) : null
              }
              footerLeading={
                <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-xs text-muted-foreground">
                  <span className="truncate">
                    {thread?.modelSelection.model} · {name}
                  </span>
                  {running && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={mutate.isPending}
                      onClick={stop}
                    >
                      停止
                    </Button>
                  )}
                </div>
              }
              placeholder="发消息给远端 Metis…"
              editorAriaLabel="给远端主控的消息"
              sendAriaLabel={pending ? "确认发送" : "发送消息"}
              onChange={(value, position) => {
                if (pending) return;
                setDraft(value);
                setCursor(position);
                localStorage.setItem(storageKey, JSON.stringify(value));
              }}
              onSend={() => void send()}
            />
            {thread?.claudeCacheReview && (
              <p className="pt-2 text-ui-xs text-muted-foreground">
                远端正在等待上下文缓存确认，请在执行电脑处理。
              </p>
            )}
          </ComposerColumnFrame>
        </div>
        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="重命名远端对话"
          initialValue={title}
          onSave={async (next) => {
            await mutate.mutateAsync({
              action: "chat.rename",
              chatId,
              id: randomUUID(),
              title: next,
            });
          }}
        />
      </div>
    </RouteInsetSurface>
  );
}
export function RemoteChatView({ peerId, chatId }: { peerId: string; chatId: string }) {
  const devices = useRemoteDevices();
  const peer = devices.data?.peers.find((entry) => entry.id === peerId);
  if (!devices.data || !peer || !devices.owner)
    return (
      <RouteInsetSurface>
        <div className="p-6 text-ui text-muted-foreground">
          {devices.isPending ? "加载设备…" : "设备未配对，或当前账号无权访问。"}
        </div>
      </RouteInsetSurface>
    );
  return (
    <Conversation
      key={`${devices.data.instanceId}:${peerId}:${chatId}`}
      instance={devices.data.instanceId}
      peerId={peerId}
      chatId={chatId}
      name={peer.name}
      enabled={devices.data.enabled}
    />
  );
}
