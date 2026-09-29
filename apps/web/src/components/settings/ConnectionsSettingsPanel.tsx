import type { AuthClientSession, AuthPairingCredentialResult } from "@synara/contracts";
import { buildWorkbenchPairingUrl, normalizeSecureRelayUrl } from "@synara/shared/workbenchRemote";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { serverAuthSessionQueryOptions, serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const CLIENTS_KEY = ["server", "auth", "clients"] as const;
const LINKS_KEY = ["server", "auth", "pairing-metadata"] as const;

// HTTP replies contain ISO strings; in-process NativeApi implementations may
// already carry decoded DateTime values.
function timestamp(value: unknown): number {
  return DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : Date.parse(String(value));
}

function dateLabel(value: unknown): string {
  const ms = timestamp(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "时间未知";
}

function deviceLabel(device: AuthClientSession): string {
  return (
    device.client.label ??
    ([device.client.os, device.client.browser].filter(Boolean).join(" · ") || "未命名设备")
  );
}

export function ConnectionsSettingsPanel() {
  const queryClient = useQueryClient();
  const config = useQuery(serverConfigQueryOptions());
  const session = useQuery({ ...serverAuthSessionQueryOptions(), refetchInterval: 15_000 });
  const owner = session.data?.authenticated === true && session.data.role === "owner";
  const origin = normalizeSecureRelayUrl(config.data?.publicUrl ?? "");
  const unconfigured = config.isSuccess && !origin;
  const [pairingNotice, setPairingNotice] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{
    link: AuthPairingCredentialResult;
    at: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now);
  const clients = useQuery({
    queryKey: CLIENTS_KEY,
    queryFn: () => ensureNativeApi().server.listAuthClients(),
    enabled: owner,
    refetchInterval: 10_000,
    retry: false,
    gcTime: 0,
  });
  const links = useQuery({
    queryKey: LINKS_KEY,
    queryFn: async () => {
      const result = await ensureNativeApi().server.listAuthPairingLinks();
      // Existing API returns credentials too. Keep them out of the query cache.
      return result.map(({ credential: _credential, ...metadata }) => metadata);
    },
    enabled: owner,
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      generated &&
      (timestamp(generated.link.expiresAt) <= now ||
        !owner ||
        (links.dataUpdatedAt > generated.at &&
          links.data &&
          !links.data.some((link) => link.id === generated.link.id)))
    ) {
      setGenerated(null);
      setPairingNotice("配对链接已失效或已使用，需要时可重新生成。");
    }
  }, [generated, now, owner, links.data, links.dataUpdatedAt]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CLIENTS_KEY }),
      queryClient.invalidateQueries({ queryKey: LINKS_KEY }),
    ]);
  };
  const runAction = async (id: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    try {
      await action();
    } catch {
      toastManager.add({
        type: "error",
        title: "操作未完成",
        description: "请确认电脑仍在线，刷新后重试。",
      });
    } finally {
      setBusy(null);
    }
  };
  const createLink = () =>
    runAction("create", async () => {
      if (!origin || !owner) return;
      const label = name.trim();
      const link = await ensureNativeApi().server.createAuthPairingToken(
        label ? { label } : undefined,
      );
      await refresh();
      setGenerated({ link, at: Date.now() });
      setPairingNotice("配对链接已生成，可以复制到自己的手机浏览器打开。");
    });
  const copyLink = () =>
    runAction("copy", async () => {
      if (!origin || !generated || timestamp(generated.link.expiresAt) <= Date.now()) return;
      await copyTextToClipboard(buildWorkbenchPairingUrl(origin, generated.link.credential));
      toastManager.add({
        type: "success",
        title: "配对链接已复制",
        description: "在你的手机浏览器中打开，链接只能使用一次。",
      });
    });
  const revokeDevice = (device: AuthClientSession) =>
    runAction(device.sessionId, async () => {
      const api = ensureNativeApi();
      if (
        !(await api.dialogs.confirm(
          `撤销「${deviceLabel(device)}」的访问？\n这台设备需要重新配对。电脑上已经开始的任务会继续执行。`,
        ))
      )
        return;
      await api.server.revokeAuthClient({ sessionId: device.sessionId });
      await refresh();
      toastManager.add({ type: "success", title: "设备访问已撤销" });
    });
  const activeLinks = (links.data ?? []).filter((link) => timestamp(link.expiresAt) > now);
  const accessError =
    session.isError || config.isError || (owner && (clients.isError || links.isError));

  return (
    <div className="space-y-6">
      <SettingsSectionShell title="连接这台电脑">
        <SettingsCard>
          <SettingsListRow
            title={
              config.isPending
                ? "正在读取远程地址…"
                : config.isError
                  ? "远程地址暂时无法读取"
                  : origin
                    ? "已配置远程地址"
                    : "目前仅供本机使用"
            }
            description={
              config.isPending ? (
                "请稍候。"
              ) : config.isError ? (
                "请重新加载连接信息。"
              ) : origin ? (
                <>
                  <span className="break-all">{origin}</span>
                  <p className="mt-1">手机通过这个地址访问同一工作区。电脑需要保持在线。</p>
                </>
              ) : (
                "开启 HTTPS 远程入口后，即可在其他网络的手机上继续任务。"
              )
            }
          />
          {unconfigured && (
            <div className="space-y-3 px-4 py-4 text-ui-sm text-muted-foreground">
              <p>
                远程入口尚未开启；配对链接不会代替网络连接。当前版本支持连接到你配置的 Cloudflare
                Tunnel。
              </p>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  查看连接设置
                </summary>
                <p className="max-w-prose leading-relaxed">
                  为远程服务配置 HTTPS
                  域名与隧道后，先退出当前桌面应用，再在项目目录运行以下命令。服务会使用现有工作区；在电脑浏览器完成首次管理员配对后，即可添加手机。
                </p>
                <code className="mt-3 block overflow-x-auto rounded-md bg-muted p-3 text-ui-sm">
                  npm run metis:remote
                </code>
                <p className="mt-3">配置说明：项目内 docs/workbench/remote-access.md</p>
              </details>
            </div>
          )}
        </SettingsCard>
      </SettingsSectionShell>

      {accessError && (
        <div role="alert">
          <SettingsEmptyState tone="destructive" layout="status">
            <p>连接信息加载失败，显示内容可能已过期。</p>
            <Button
              className="mt-3 min-h-11"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void runAction("refresh", async () => {
                  await Promise.all([session.refetch(), config.refetch(), refresh()]);
                })
              }
            >
              重新加载
            </Button>
          </SettingsEmptyState>
        </div>
      )}
      {session.isPending ? (
        <p role="status" className="text-ui text-muted-foreground">
          正在读取访问权限…
        </p>
      ) : !owner && !session.isError ? (
        <SettingsEmptyState layout="status">
          {session.data?.authenticated
            ? "请在首次配对的管理员设备上管理连接。你仍然可以继续使用已授权的任务。"
            : "请先用管理员配对链接连接此工作区，再管理其他设备。"}
        </SettingsEmptyState>
      ) : null}

      {owner && (
        <>
          <SettingsSectionShell title="添加手机或其他设备">
            <SettingsCard divided={false} className="space-y-4 p-4">
              <p className="text-ui-sm text-muted-foreground">
                配对后可以查看工作区内容、发送任务和处理操作确认。只在自己的设备上打开链接。
              </p>
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createLink();
                }}
              >
                <label className="min-w-0 flex-1 space-y-2 text-ui-sm">
                  <span>设备备注（可选）</span>
                  <Input
                    className="min-h-11"
                    value={name}
                    maxLength={80}
                    placeholder="例如：我的手机"
                    onChange={(event) => setName(event.target.value)}
                    disabled={!origin || busy !== null}
                  />
                </label>
                <Button
                  className="min-h-11"
                  type="submit"
                  disabled={!origin || accessError || busy !== null || generated !== null}
                >
                  {busy === "create" ? "正在生成…" : "生成一次性配对链接"}
                </Button>
              </form>
              {unconfigured && (
                <p className="text-ui-sm text-muted-foreground">请先配置上方的远程地址。</p>
              )}
              <p role="status" className="text-ui-sm text-muted-foreground">
                {pairingNotice}
              </p>
              {generated && origin && (
                <div className="space-y-3 border-t pt-4">
                  <p aria-hidden="true" className="text-ui">
                    {Math.max(1, Math.ceil((timestamp(generated.link.expiresAt) - now) / 1000))}{" "}
                    秒后失效
                  </p>
                  <p className="text-ui-sm text-muted-foreground">
                    到期时间：{dateLabel(generated.link.expiresAt)}
                    。配对成功或到期后，链接会自动失效。
                  </p>
                  <div className="space-y-1">
                    <p className="text-ui-sm text-muted-foreground">
                      链接打不开或提示无法使用时，在手机打开 {origin}/pair 并输入配对码：
                    </p>
                    <p className="select-all font-mono text-ui-lg tracking-widest">
                      {generated.link.credential.match(/.{1,4}/gu)?.join(" ")}
                    </p>
                  </div>
                  <Button
                    className="min-h-11"
                    disabled={busy !== null || accessError}
                    onClick={() => void copyLink()}
                  >
                    复制配对链接
                  </Button>
                </div>
              )}
            </SettingsCard>
          </SettingsSectionShell>
          <SettingsSectionShell
            title="已授权设备"
            action={
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={busy !== null || clients.isFetching}
                onClick={() => void runAction("refresh", refresh)}
              >
                刷新
              </Button>
            }
          >
            {clients.isPending ? (
              <p role="status" className="text-ui text-muted-foreground">
                正在读取设备…
              </p>
            ) : clients.data?.length ? (
              <SettingsCard>
                {clients.data.map((device) => (
                  <SettingsListRow
                    key={device.sessionId}
                    title={
                      <>
                        {deviceLabel(device)}
                        {device.current ? " · 当前设备" : ""}
                      </>
                    }
                    description={
                      <>
                        {device.role === "owner" ? "管理员" : "已授权"} ·{" "}
                        {device.connected ? "会话已连接" : "会话未连接"}
                        <p>授权于 {dateLabel(device.issuedAt)}</p>
                      </>
                    }
                    actions={
                      device.current ? undefined : (
                        <Button
                          variant="outline"
                          className="min-h-11"
                          disabled={busy !== null || accessError}
                          onClick={() => void revokeDevice(device)}
                        >
                          {busy === device.sessionId ? "正在撤销…" : "撤销访问"}
                        </Button>
                      )
                    }
                  />
                ))}
              </SettingsCard>
            ) : (
              !clients.isError && (
                <SettingsEmptyState layout="status">尚无已授权设备。</SettingsEmptyState>
              )
            )}
          </SettingsSectionShell>
          {(activeLinks.length > 0 || links.isPending) && (
            <SettingsSectionShell title="等待使用的配对链接">
              {links.isPending ? (
                <p role="status" className="text-ui text-muted-foreground">
                  正在读取链接…
                </p>
              ) : (
                <SettingsCard>
                  {activeLinks.map((link) => (
                    <SettingsListRow
                      key={link.id}
                      title={link.label ?? "未命名配对链接"}
                      description={`到期时间：${dateLabel(link.expiresAt)}`}
                      actions={
                        <Button
                          variant="outline"
                          className="min-h-11"
                          disabled={busy !== null || accessError}
                          onClick={() =>
                            void runAction(link.id, async () => {
                              await ensureNativeApi().server.revokeAuthPairingLink({ id: link.id });
                              if (generated?.link.id === link.id) {
                                setGenerated(null);
                                setPairingNotice("配对链接已作废，需要时可重新生成。");
                              }
                              await refresh();
                            })
                          }
                        >
                          作废链接
                        </Button>
                      }
                    />
                  ))}
                </SettingsCard>
              )}
            </SettingsSectionShell>
          )}
        </>
      )}
    </div>
  );
}
