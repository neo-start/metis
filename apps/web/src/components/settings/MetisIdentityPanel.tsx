import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MetisControlInput } from "@synara/contracts";
import { METIS_IDENTITY_QUERY_KEY, useMetisController } from "~/hooks/useMetisController";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { SettingsCard, SettingsRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

export function MetisIdentityPanel() {
  const { query, open, owner } = useMetisController();
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: (input: MetisControlInput) => ensureNativeApi().metis.control(input),
    onSuccess: (identity) => cache.setQueryData(METIS_IDENTITY_QUERY_KEY, identity),
  });
  if (!owner) return null;
  const identity = query.data;
  return (
    <SettingsSectionShell title="Metis 总控">
      <SettingsCard>
        <SettingsRow
          title="我的 Metis"
          description="同一个实例身份贯穿对话、模型切换与重启，拥有独立的灵魂和长期记忆。"
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={open.isPending}
              onClick={() => open.mutate()}
            >
              打开总控
            </Button>
          }
        >
          {identity && (
            <p className="mt-2 break-all text-ui-xs text-muted-foreground select-all">
              身份 {identity.id}
            </p>
          )}
        </SettingsRow>
        <SettingsRow
          title="持续积累经验"
          description="总控空闲时整理新增的会话经验，每小时最多自动整理一批，会使用总控所选模型。无新增内容不调用模型；可随时关闭。"
          status={identity?.growthEnabled ? "已开启" : "已关闭"}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!identity || change.isPending}
              onClick={() => change.mutate({ action: "growth", enabled: !identity?.growthEnabled })}
            >
              {identity?.growthEnabled ? "关闭" : "开启"}
            </Button>
          }
        >
          {identity?.lastReflectionAt && (
            <p className="mt-2 text-ui-sm text-muted-foreground">
              上次完成：{new Date(identity.lastReflectionAt).toLocaleString()}
            </p>
          )}
          {identity?.reflection?.summary && (
            <p className="mt-2 text-ui-sm text-muted-foreground">{identity.reflection.summary}</p>
          )}
          <Button
            className="mt-3"
            size="xs"
            variant="outline"
            disabled={
              !identity?.threadId || change.isPending || identity.reflection?.state === "running"
            }
            onClick={() => change.mutate({ action: "reflect" })}
          >
            现在整理
          </Button>
        </SettingsRow>
      </SettingsCard>
      {(query.error || change.error || identity?.error) && (
        <p role="alert" className="mt-2 text-ui-sm text-destructive">
          {query.error?.message ?? change.error?.message ?? identity?.error}
        </p>
      )}
    </SettingsSectionShell>
  );
}
