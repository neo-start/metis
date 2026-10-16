import { RemoteTaskOverview } from "~/components/RemoteTaskOverview";
import { REMOTE_TASKS_KEY, useRemoteTasks } from "~/hooks/useRemoteTasks";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PeerControlInput, PeerRemoteRequest } from "@synara/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi } from "~/nativeApi";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSectionShell,
  SettingsSelectPopup,
} from "./SettingsPanelPrimitives";

const KEY = REMOTE_TASKS_KEY;

export function PeerSettingsPanel({ owner }: { owner: boolean }) {
  const cache = useQueryClient();
  const { query } = useRemoteTasks(owner);
  const view = query.data?.overview;
  const [name, setName] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null | undefined>(undefined);
  const [peerId, setPeerId] = useState("");
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [lastError, setLastError] = useState("");
  const mutation = useMutation({
    mutationFn: (input: PeerControlInput) => ensureNativeApi().peers.control(input),
    onSuccess: (result, input) => {
      cache.setQueryData(KEY, result);
      setLastError("");
      if (input.action === "configure") {
        setName(null);
        setTemplate(undefined);
      }
      if (
        input.action === "remote" &&
        (input.request.action === "task" || input.request.action === "message")
      ) {
        setText("");
        setRequestId(crypto.randomUUID());
      }
      if (input.action === "pair")
        toastManager.add({
          type: "success",
          title: "配对请求已发送",
          description: "请在另一台 Metis 核对校验码并确认。",
        });
      void cache.invalidateQueries({ queryKey: KEY });
    },
    onError: (error) => {
      setLastError(error.message);
      void cache.invalidateQueries({ queryKey: KEY });
    },
  });
  const configure = (enabled: boolean) => {
    if (!view) return;
    mutation.mutate({
      action: "configure",
      enabled,
      name: name ?? view.name,
      templateThreadId: template === undefined ? view.templateThreadId : template,
    });
  };
  const send = (request: PeerRemoteRequest) =>
    mutation.mutate({ action: "remote", peerId: target, request });
  const selectedTemplate = template === undefined ? view?.templateThreadId : template;

  return (
    <SettingsSectionShell title="我的设备 · 局域网协作">
      {!owner ? (
        <SettingsEmptyState layout="status">请从本机所有者窗口管理设备配对。</SettingsEmptyState>
      ) : !view ? (
        <SettingsEmptyState layout="status" tone={query.isError ? "destructive" : "muted"}>
          {query.isError ? query.error.message : "正在读取设备信息…"}
        </SettingsEmptyState>
      ) : (
        <>
          <SettingsCard>
            <SettingsRow
              title="实例 ID"
              description="在另一台 Metis 输入这个 ID，核对校验码后即可双向通信和派任务。"
              status={<code className="break-all select-all">{view.instanceId}</code>}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void copyTextToClipboard(view.instanceId).catch((error: unknown) =>
                      setLastError(String(error)),
                    )
                  }
                >
                  复制 ID
                </Button>
              }
            />
            <SettingsRow
              title="局域网协作"
              description="首次配对需要本机确认。已配对设备可以互发消息，并按本机配置创建任务。"
              status={
                view.enabled
                  ? view.listeningPort
                    ? "已开启"
                    : "监听未启动，请关闭后重新开启"
                  : "已关闭"
              }
              control={
                <Button
                  size="xs"
                  variant={view.enabled ? "outline" : "default"}
                  disabled={mutation.isPending}
                  onClick={() => configure(!view.enabled)}
                >
                  {view.enabled ? "关闭协作" : "开启协作"}
                </Button>
              }
            />
            <SettingsRow
              title="本机接收配置"
              description="每个远程任务新建会话，使用所选会话的项目、模型和权限模式。原会话不会收到远程任务；同一时间执行一个远程任务。"
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={mutation.isPending || (name === null && template === undefined)}
                  onClick={() => configure(view.enabled)}
                >
                  保存
                </Button>
              }
            >
              <div className="mt-3 grid gap-3">
                <Input
                  aria-label="设备名称"
                  value={name ?? view.name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
                <Select
                  value={selectedTemplate ?? "none"}
                  onValueChange={(value) => setTemplate(value === "none" ? null : String(value))}
                >
                  <SelectTrigger aria-label="接收任务使用的会话配置" className="w-full">
                    <SelectValue>
                      {view.templates.find((entry) => entry.id === selectedTemplate)?.title ??
                        "仅接收消息，暂不执行任务"}
                    </SelectValue>
                  </SelectTrigger>
                  <SettingsSelectPopup>
                    <SelectItem value="none">仅接收消息，暂不执行任务</SelectItem>
                    {view.templates.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.title}
                      </SelectItem>
                    ))}
                  </SettingsSelectPopup>
                </Select>
              </div>
            </SettingsRow>
            {view.addresses.length > 0 && (
              <SettingsListRow
                title="备用连接地址"
                description={
                  <span className="font-mono break-all select-all">
                    {view.addresses.join(" · ")}
                  </span>
                }
              />
            )}
          </SettingsCard>
          {(lastError || view.error) && (
            <p role="alert" className="text-ui-sm text-destructive">
              {lastError || view.error}
            </p>
          )}
          {view.enabled && (
            <SettingsCard>
              <SettingsRow
                title="添加我的设备"
                description="两台设备都开启协作后，输入对方的实例 ID。发现受限时可补充对方显示的地址。"
              >
                <div className="mt-3 grid gap-2">
                  <Input
                    aria-label="对方实例 ID"
                    placeholder="metis-…"
                    value={peerId}
                    onChange={(event) => setPeerId(event.target.value.trim().toLowerCase())}
                  />
                  <Input
                    aria-label="备用 IP 和端口"
                    placeholder="备用地址（可选）：192.168.1.20:端口"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={mutation.isPending || !/^metis-[a-f0-9]{32}$/.test(peerId)}
                    onClick={() =>
                      mutation.mutate({
                        action: "pair",
                        peerId,
                        ...(address.trim() ? { address: address.trim() } : {}),
                      })
                    }
                  >
                    请求配对
                  </Button>
                </div>
              </SettingsRow>
              {view.nearby
                .filter((entry) => !view.peers.some((peer) => peer.id === entry.id))
                .map((entry) => (
                  <SettingsListRow
                    key={entry.id}
                    title={entry.name}
                    description={entry.id}
                    actions={
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setPeerId(entry.id);
                          setAddress(entry.address);
                        }}
                      >
                        选择
                      </Button>
                    }
                  />
                ))}
              {view.pending.map((pending) => (
                <SettingsListRow
                  key={pending.id}
                  title={`${pending.name} · ${pending.incoming ? "请求配对" : "等待对方确认"}`}
                  description={
                    <>
                      <div className="font-mono text-foreground">校验码 {pending.code}</div>
                      <div className="break-all">{pending.peerId}</div>
                      <div>
                        请确认两端校验码相同。确认后允许双向通信和任务指挥；请求 5 分钟内有效。
                      </div>
                    </>
                  }
                  actions={
                    pending.incoming ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({ action: "reject", requestId: pending.id })
                          }
                        >
                          拒绝
                        </Button>
                        <Button
                          size="xs"
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({ action: "approve", requestId: pending.id })
                          }
                        >
                          确认配对
                        </Button>
                      </>
                    ) : undefined
                  }
                />
              ))}
            </SettingsCard>
          )}
          {view.peers.length > 0 && (
            <SettingsCard>
              {view.peers.map((peer) => (
                <SettingsListRow
                  key={peer.id}
                  title={`${peer.name} · ${peer.online ? "在线" : "未连接"}`}
                  description={
                    <>
                      <div className="break-all font-mono">{peer.id}</div>
                      {peer.error && <div>{peer.error}</div>}
                    </>
                  }
                  actions={
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!view.enabled}
                        onClick={() => setTarget(peer.id)}
                      >
                        通信 / 派任务
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={mutation.isPending}
                        onClick={() => {
                          void ensureNativeApi()
                            .dialogs.confirm(
                              `解除与 ${peer.name} 的配对？后续请求将被拒绝；已经开始的本机任务可在对应会话中停止。`,
                            )
                            .then((confirmed) => {
                              if (confirmed) mutation.mutate({ action: "revoke", peerId: peer.id });
                            });
                        }}
                      >
                        解除配对
                      </Button>
                    </>
                  }
                />
              ))}
            </SettingsCard>
          )}
          {view.enabled && target && view.peers.some((peer) => peer.id === target) && (
            <SettingsCard>
              <SettingsRow
                title={`发送到 ${view.peers.find((peer) => peer.id === target)?.name}`}
                description="消息进入对方收件箱；任务会启动独立 Agent 会话。发送超时后请查看下方记录，系统会自动重试。"
              >
                <div className="mt-3 space-y-3">
                  <Textarea
                    aria-label="消息或任务内容"
                    value={text}
                    onChange={(event) => {
                      setText(event.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                    maxLength={32000}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={mutation.isPending || !text.trim()}
                      onClick={() => send({ action: "message", id: requestId, text })}
                    >
                      发送消息
                    </Button>
                    <Button
                      size="xs"
                      disabled={mutation.isPending || !text.trim()}
                      onClick={() => send({ action: "task", id: requestId, text })}
                    >
                      委派任务
                    </Button>
                  </div>
                </div>
              </SettingsRow>
            </SettingsCard>
          )}
          <RemoteTaskOverview owner={owner} />
          {view.messages.length > 0 && (
            <SettingsCard>
              {view.messages
                .slice(-12)
                .toReversed()
                .map((message) => (
                  <SettingsListRow
                    key={`${message.direction}:${message.peerId}:${message.id}`}
                    title={`${message.direction === "incoming" ? "收到消息" : message.delivered ? "消息已送达" : "等待送达"} · ${view.peers.find((peer) => peer.id === message.peerId)?.name ?? message.peerId}`}
                    description={<p className="whitespace-pre-wrap break-words">{message.text}</p>}
                  />
                ))}
            </SettingsCard>
          )}
        </>
      )}
    </SettingsSectionShell>
  );
}
