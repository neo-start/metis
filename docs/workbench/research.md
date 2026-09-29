# T3 Code / Synara 与统一 Agent 桌面构想的对照

调研日期：2026-09-23。范围：官方站点、文档、GitHub README/许可证及部分公开源码；没有安装、运行或实测应用。下载的官网截图仅用于理解布局，不能作为稳定性证据。

## 判断

两者均与“在一个桌面图形界面中使用本机 Codex、Claude Code 等 Agent，管理会话、观察执行并查看文件结果”的构想高度重合。用户尚未说明 Emdash 不合适的具体原因，也未确认最终交互方向，因此这里是基于目前构想的选型建议。

- T3 Code 以统一 Agent 会话、开发任务及多设备访问为重点，官方提供桌面、Web、iOS、Android 客户端；执行发生在运行服务的机器上。可作为统一聊天与远程接续体验的参照。
- Synara 集成项目、任务、会话、终端、文件/编辑器、浏览器预览、diff/Git、Agent 交接和自动化。导入本地旧会话和非编程成果管理与当前探索尤其相关，建议先体验其关键流程。
- 两者均 MIT；可评估直接使用或基于现有项目定制，不应把从零开发作为既定选择。两者 README 均明确仍处早期，不能仅凭功能目录判定稳定性。

## 已核实的关键点

### T3 Code

- 当前 README 列 Codex、Claude Code、Cursor、Grok Build、OpenCode、Antigravity；大部分沿用本机已安装并认证的运行时。Antigravity 可由应用管理安装/登录，不能笼统说每个 Agent 都必须预装 CLI。
- 项目/会话、工具调用展开、附件、diff 和 Git/PR 操作；桌面、Web、手机连接执行环境。
- 新会话支持工作区设置；文档区分普通新会话与 New worktree，也可以在既有 worktree 中新建会话。不是所有操作都强制新建 worktree。
- Claude 文档说明沿用其配置目录和原有登录，可配置独立账号实例；实例之间的原生会话兼容性有限制。
- 本轮未充分确认与 Synara 完全等价的旧会话导入、跨不同 Agent 的交接功能，不标记为“没有”，也不将 model switching 当作跨 Agent 无损接续。

### Synara

- README 明确可以使用原目录或托管 worktree。当前开发构建列 Codex、Claude、Cursor、Antigravity、Grok、Droid、OpenCode、Pi、Devin；不能无条件保证每一发行版都有 main 的全部功能。
- 本地 Codex / Claude 历史导入：发现已有目录和原生历史，按需选择项目/会话；继续沿用原项目文件夹，不复制仓库或强制新建 worktree。
- 导入创建独立的原生会话副本；此后在 Synara 续聊不会追加到原对话。文件仍共享原目录。当前界面历史主要恢复用户/助手文本，旧工具事件、附件等不会全部重建为交互项；不是无损双向同步。
- 跨 Agent handoff：保留任务与工作区，传递有限长度的对话摘录。源码 `apps/server/src/orchestration/handoff.ts` 明确有消息裁剪和总长度预算，不能称为内部上下文完整迁移；也不能迁移原生 session ID、隐藏推理、后台子 Agent 或权限机制。交接是接续，不代表两个 Agent 同时改同一目录。
- Studio 文档已覆盖调研报告、长文写作、图片/媒体输出、长期产物整理；“多 CLI + 非编程任务”不是尚无人覆盖的差异点。
- 本地优先，不要求 Synara 云工作区账号；模型执行仍由各自 provider 接收必要输入，不能说所有数据离线。

## 对自研的建议

先用同一个真实流程检验两者：选择现有目录和 Agent，发送附件/任务，查看操作与产物，中断/重开并继续；Synara 再验证旧会话导入及 Claude → Codex 交接是否符合预期。先找出实际不满意的交互，再决定定制或从零实现。该建议不是本轮安装、导入真实项目或发起 Agent 请求的授权。

潜在需要实测的缺口：历史接续的完整性、现有 skills/MCP/hooks 兼容性、交接后遗漏约束、会话与成果导航是否足够直观。不能宣称这些产品一定缺失这些能力。

## 一手来源

- T3 官网：https://t3.codes/
- T3 README：https://github.com/pingdotgg/t3code
- T3 许可证：https://github.com/pingdotgg/t3code/blob/main/LICENSE
- T3 架构：https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md
- T3 会话：https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
- T3 配置：https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md
- T3 Claude：https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md
- Synara 官网：https://www.trysynara.com/
- Synara README：https://github.com/Emanuele-web04/synara
- Synara 许可证：https://github.com/Emanuele-web04/synara/blob/main/LICENSE
- Synara 导入：https://github.com/Emanuele-web04/synara/blob/main/docs/project-import.md
- Synara 交接：https://www.trysynara.com/docs/workflows/handoffs
- 交接源码：https://github.com/Emanuele-web04/synara/blob/main/apps/server/src/orchestration/handoff.ts
- Synara Studio：https://www.trysynara.com/docs/workflows/studio

源码树快照：T3 `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`，Synara `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。公开资料副本保存在本目录；通过 main URL 获取的各文件可能与树快照存在时间差，不声称固定提交的完整审计。
