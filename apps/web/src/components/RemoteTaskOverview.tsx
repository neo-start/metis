import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { MonitorIcon } from "~/lib/icons";
import type {
  PeerOverview,
  PeerTask,
  PeerTaskAttention,
  PeerTaskResponse,
} from "@synara/contracts";
import { ApprovalRequestId } from "@synara/contracts";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { UserInputQuestionForm } from "./chat/UserInputQuestionForm";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { useNowMs } from "~/hooks/useNowMs";
import { useRemoteTasks } from "~/hooks/useRemoteTasks";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
} from "./settings/SettingsPanelPrimitives";

const states = {
  queued: "排队中",
  running: "执行中",
  waiting: "需要处理",
  completed: "已完成",
  error: "失败",
  interrupted: "已中断",
};
const finished = (task: PeerTask) => ["completed", "error", "interrupted"].includes(task.state);
const dateLabel = (date?: string) =>
  date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString() : "未知";

function RemoteTaskResponseForm({
  attention,
  disabled,
  onRespond,
}: {
  attention: PeerTaskAttention;
  disabled: boolean;
  onRespond: (response: PeerTaskResponse["response"]) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const progress = derivePendingUserInputProgress(attention.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  if (attention.kind === "approval") {
    let payload: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(attention.detail);
      if (value && typeof value === "object" && !Array.isArray(value))
        payload = value as Record<string, unknown>;
    } catch {
      /* Older peers may send plain detail text. */
    }
    const kind = payload.requestKind;
    return (
      <div className="mt-3 space-y-2">
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 text-ui-xs"
          aria-label="执行设备的完整审批请求"
        >
          {attention.detail}
        </pre>
        <ComposerPendingApprovalPanel
          approval={{
            requestId: ApprovalRequestId.makeUnsafe(attention.requestId),
            ...(attention.lifecycleGeneration
              ? { lifecycleGeneration: attention.lifecycleGeneration }
              : {}),
            responseAttemptKey: attention.responseAttemptId ?? attention.createdAt,
            createdAt: attention.createdAt,
            detail: typeof payload.detail === "string" ? payload.detail : "执行设备请求审批",
            requestKind:
              kind === "command" ||
              kind === "file-read" ||
              kind === "file-change" ||
              kind === "permissions"
                ? kind
                : "tool",
            sessionApprovalAvailable: false,
            ...(payload.approvalScope === "computer-task"
              ? { approvalScope: "computer-task" }
              : {}),
          }}
          pendingCount={1}
          isResponding={disabled}
          onRespond={async (_id, decision) => {
            if (decision === "acceptForSession") return;
            await onRespond({ kind: "approval", decision });
          }}
        />
      </div>
    );
  }
  const advance = async () => {
    if (disabled || !progress.canAdvance) return;
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(attention.questions, answers);
    if (!resolved) return;
    setSubmissionVersion((version) => version + 1);
    try {
      await onRespond({ kind: "userInput", answers: resolved });
    } catch {
      /* Mutation error stays visible in the shared overview. */
    }
  };
  return activeQuestion ? (
    <div className="mt-3">
      <UserInputQuestionForm
        questions={attention.questions}
        answers={answers}
        questionIndex={questionIndex}
        submissionVersion={submissionVersion}
        isResponding={disabled}
        autoAdvance={false}
        keyboardShortcuts="local"
        onToggleOption={(questionId, label) => {
          const draft = togglePendingUserInputOptionSelection(
            activeQuestion,
            answers[questionId],
            label,
          );
          setAnswers((current) => ({ ...current, [questionId]: draft }));
          return draft;
        }}
        onAdvance={() => void advance()}
        onPrevious={() => setQuestionIndex(Math.max(0, questionIndex - 1))}
      >
        <div className="mt-3 space-y-2">
          <Textarea
            aria-label={`回答：${activeQuestion.question}`}
            placeholder="或输入回答"
            value={progress.customAnswer}
            disabled={disabled}
            maxLength={16000}
            onChange={(event) =>
              setAnswers((current) => ({
                ...current,
                [activeQuestion.id]: setPendingUserInputCustomAnswer(
                  current[activeQuestion.id],
                  event.target.value,
                ),
              }))
            }
          />
          <Button
            size="xs"
            disabled={disabled || !progress.canAdvance}
            onClick={() => void advance()}
          >
            {progress.isLastQuestion ? "发送回答" : "下一题"}
          </Button>
        </div>
      </UserInputQuestionForm>
    </div>
  ) : null;
}

function RemoteTaskRow({
  task,
  view,
  unavailable,
  observationStale,
  pending,
  onRequest,
}: {
  task: PeerTask;
  view: PeerOverview;
  unavailable: boolean;
  observationStale: boolean;
  pending: boolean;
  onRequest: (
    peerId: string,
    request: PeerTaskResponse | { action: "cancel"; taskId: string },
  ) => Promise<void>;
}) {
  const peer = view.peers.find((entry) => entry.id === task.peerId);
  const local = task.direction === "incoming";
  const stale = unavailable || observationStale || task.stale === true;
  const canRespond = !local && peer?.capabilities?.includes("task-responses-v1");
  const controlUnavailable = pending || unavailable || !view.enabled || !peer?.online;
  const disabled = controlUnavailable || stale;
  return (
    <SettingsListRow
      title={`${local ? `本机 · ${view.name}` : `远程 · ${peer?.name ?? task.peerId}`} · ${states[task.state]}`}
      description={
        <div className="space-y-2">
          <p className="whitespace-pre-wrap break-words text-foreground">{task.text}</p>
          <p className="text-ui-xs">
            {local ? `来自 ${peer?.name ?? task.peerId}` : "在对方设备执行"} ·{" "}
            {stale ? "状态可能已过期" : "状态已同步"}
            {!local && !peer?.online ? " · 离线 / 重连中" : ""}
          </p>
          <p className="text-ui-xs">
            更新于 {dateLabel(task.updatedAt ?? task.createdAt)} · 执行观测于{" "}
            {dateLabel(task.observedAt)}
            {!local && <> · 传输接收于 {dateLabel(task.syncedAt)}</>}
          </p>
          {task.localRecovery?.map((recovery) => (
            <p key={recovery.requestId} className="text-ui-sm text-foreground">
              {recovery.status === "responding" ? "审批响应仍在处理中。" : "审批交付结果不确定。"}
              {local ? "请打开本机会话检查和恢复。" : "请在执行设备的会话中检查和恢复。"}
            </p>
          ))}
          {task.state === "waiting" && !task.localRecovery?.length && (
            <p className="text-ui-sm text-foreground">
              {local
                ? "请打开本机会话处理审批或问题。"
                : stale
                  ? "执行观测已过期或未知，请等待执行设备刷新；通信正常不代表执行状态已刷新。"
                  : canRespond && task.attention?.length
                    ? "可在下方处理执行设备的请求。"
                    : "请在执行设备处理；对方尚未提供可远程处理的请求。"}
            </p>
          )}
          {task.result && (
            <Collapsible>
              <CollapsibleTrigger className="text-ui-sm text-primary underline underline-offset-4">
                {finished(task) ? "查看结果" : "查看最新进展"}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-sm">
                  {task.result}
                </p>
              </CollapsiblePanel>
            </Collapsible>
          )}
          {local && task.threadId && (
            <Link
              to="/$threadId"
              params={{ threadId: task.threadId }}
              className="text-ui-sm text-primary underline underline-offset-4"
            >
              打开本机任务会话
            </Link>
          )}
          {canRespond &&
            !finished(task) &&
            task.attention?.map((attention) => (
              <RemoteTaskResponseForm
                key={`${attention.kind}:${attention.requestId}:${attention.lifecycleGeneration}:${attention.createdAt}:${attention.responseAttemptId}`}
                attention={attention}
                disabled={disabled}
                onRespond={(response) =>
                  onRequest(task.peerId, {
                    action: "respond",
                    taskId: task.id,
                    requestId: attention.requestId,
                    lifecycleGeneration: attention.lifecycleGeneration,
                    responseAttemptId: attention.responseAttemptId,
                    createdAt: attention.createdAt,
                    response,
                  })
                }
              />
            ))}
        </div>
      }
      actions={
        !local && !finished(task) ? (
          <Button
            size="xs"
            variant="outline"
            // Cancellation targets the owned task, not a cached interaction.
            // Keep it available for online peers without observation metadata.
            disabled={controlUnavailable}
            onClick={() => {
              void onRequest(task.peerId, { action: "cancel", taskId: task.id }).catch(() => {});
            }}
          >
            请求取消
          </Button>
        ) : undefined
      }
    />
  );
}

/** Same task surface in settings and the workspace; no remote thread navigation
 * through the local thread router, and no optimistic approval-success claim. */
export function RemoteTaskOverview({
  owner,
  compact = false,
}: {
  owner?: boolean;
  compact?: boolean;
}) {
  const { query, mutation, authorized } = useRemoteTasks(owner);
  const [open, setOpen] = useState(false);
  const view = query.data?.overview;
  const now = useNowMs(authorized && Boolean(view?.tasks.length));
  if (!authorized) return null;
  const tasks =
    view?.tasks.toSorted(
      (a, b) =>
        Number(finished(a)) - Number(finished(b)) ||
        Number(b.state === "waiting") - Number(a.state === "waiting") ||
        b.createdAt.localeCompare(a.createdAt),
    ) ?? [];
  const content = (
    <div className="space-y-3">
      {query.isError && (
        <p role="alert" className="text-ui-sm text-destructive">
          连接中断，显示最后一次同步状态。{query.error.message}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-ui-sm text-destructive">
          {mutation.error.message} 响应不会自动重试；请刷新状态后确认。
        </p>
      )}
      {mutation.isSuccess && (
        <p role="status" className="text-ui-sm text-muted-foreground">
          请求已受理，后续状态由执行设备同步。
        </p>
      )}
      {tasks.length ? (
        <SettingsCard>
          {tasks.map((task) => (
            <RemoteTaskRow
              key={`${task.direction}:${task.peerId}:${task.id}`}
              task={task}
              view={view!}
              unavailable={query.isError}
              observationStale={
                task.observationAgeMs == null ||
                task.observationAgeMs + Math.max(0, now - query.dataUpdatedAt) > 15000
              }
              pending={mutation.isPending}
              onRequest={async (peerId, request) => {
                await mutation.mutateAsync({ action: "remote", peerId, request });
              }}
            />
          ))}
        </SettingsCard>
      ) : (
        <SettingsEmptyState layout="status">
          {query.isPending ? "正在同步设备任务…" : "还没有跨设备任务。在我的设备中配对后即可委派。"}
        </SettingsEmptyState>
      )}
    </div>
  );
  if (!compact) return content;
  if (!view?.peers.length && !tasks.length) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start text-ui-sm"
        onClick={() => setOpen(true)}
      >
        <MonitorIcon className="size-4" />
        设备任务{" "}
        <span className="ml-auto text-ui-xs text-muted-foreground">
          {tasks.filter((task) => !finished(task)).length} 进行中
          {tasks.some((task) => task.state === "waiting") ? " · 待处理" : ""}
        </span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>设备任务</DialogTitle>
            <DialogDescription>
              本机与已配对设备的执行进展。断线后保留状态，重连自动同步。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto p-4">{content}</div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
