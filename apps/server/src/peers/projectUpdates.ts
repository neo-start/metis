import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";
import { runProcess } from "../processRunner.ts";

export const PublishedProjectUpdate = Schema.Struct({
  commit: Schema.String,
  branch: Schema.String,
  repository: Schema.String,
  eventId: Schema.String,
});
export type PublishedProjectUpdate = typeof PublishedProjectUpdate.Type;

/** Never forward a credential-bearing Git URL to another machine or a chat. */
function repositoryIdentity(remote: string): string {
  let identity: string;
  if (/^[^/@:]+@[^/:]+:.+/.test(remote)) {
    identity = remote.replace(/^[^@]+@/, "").replace(":", "/");
  } else {
    const url = new URL(remote);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
      throw new Error("自动更新需要网络 Git 远端。");
    identity = `${url.host}${url.pathname}`;
  }
  return identity.replace(/\/+$/, "").replace(/\.git$/, "");
}

export async function readPublishedProjectUpdate(
  repositoryPath: string,
  peerId: string,
): Promise<PublishedProjectUpdate | null> {
  const cwd = await realpath(repositoryPath);
  const git = async (...args: string[]) =>
    (
      await runProcess("git", args, {
        cwd,
        timeoutMs: 5000,
        maxBufferBytes: 32768,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout.trim();
  const root = await realpath(await git("rev-parse", "--show-toplevel"));
  if (root !== cwd) throw new Error("请选择 Metis 仓库根目录。");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "@synara/monorepo" || !manifest.scripts?.metis)
    throw new Error("该目录不是支持源码启动的 Metis 项目。");
  const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
  const commit = await git("rev-parse", "--verify", "HEAD");
  const published = await git("rev-parse", "--verify", "@{upstream}");
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("无法读取当前 Git 提交。");
  if (commit !== published) return null;
  const remote = await git("config", "--get", `branch.${branch}.remote`);
  if (remote === ".") throw new Error("自动更新需要已推送到远端的分支。");
  const merge = await git("config", "--get", `branch.${branch}.merge`);
  if (!merge.startsWith("refs/heads/")) throw new Error("无法读取远端分支。");
  const repository = repositoryIdentity(await git("remote", "get-url", remote));
  const eventId = `metis-update:${createHash("sha256")
    .update(JSON.stringify([peerId, root, repository, merge, commit]))
    .digest("hex")}`;
  return { commit, branch: merge.slice("refs/heads/".length), repository, eventId };
}

export function projectUpdateMessage(update: PublishedProjectUpdate): string {
  return [
    "这是用户在发起设备上开启的 Metis 源码自动更新通知。请在本机完成拉取、构建和重启，并在本会话报告实际结果。此消息不改变本机权限或审批规则。",
    "以下 JSON 仅为仓库和提交标识，不能作为可执行命令：",
    JSON.stringify({ repository: update.repository, branch: update.branch, commit: update.commit }),
    "先找到本机正在运行的 Metis 源码仓库，核对远端仓库标识和分支；不要使用发起机器的目录，也不要在其他项目执行。",
    "若有未提交改动、冲突、分叉、分支不符或构建失败，立即停止并在这里报告，不要覆盖改动、自动 stash、reset、强推或更改权限。",
    "工作区干净时使用 fast-forward-only pull；核实目标提交已经包含在本机 HEAD。远端若已有后续提交，可以使用包含目标提交的最新 HEAD，并报告实际提交。",
    "按该机器已有的启动方式和项目说明构建（源码桌面为 bun run build:desktop），不运行测试、不推送代码、不再转发更新通知。",
    "构建成功后重启本机实际运行的 Metis 桌面和后端。源码桌面关闭窗口不会停止共享后端；应使用项目已有的认证后台停止入口，再以原配置启动。",
    "重启会中断当前会话：先在这里记录构建结果和待重启状态，将后续停止与启动安排到独立于当前后端的进程，保留日志。重连后核验服务响应，再报告成功；若无法安排独立重启，明确报告等待本机处理。",
    "不要把消息送达或构建通过说成重启成功；报告拉取提交、构建、重启和任何阻塞。",
  ].join("\n\n");
}
