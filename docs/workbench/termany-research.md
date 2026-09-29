# Termany 核对 · 2026-09-23

用户在继续 Workbench 开发时补充 Benn 的 Termany 推文，要求顺便查看。仅调研；没有安装、克隆或导入 Termany 源码，没有更换 T3 + Synara 底座。

官方仓库：https://github.com/thinkany-ai/termany（当前默认分支 dev）
官网：https://termany.sh/

截至核对时，官网标注 v0.2.5。除终端外，当前 README 已包含可复用 Bot、单聊/群聊、负责人分派、@成员与 topic；旧推文没有覆盖这些新能力。官网/README 的说明尚未经本机安装验证。

可借鉴的能力：

- Workspace → Page → Tab → Pane，ACTIVE 集中显示 working/done/needs attention，减少逐个打开终端查看状态。
- 每个 pane 独立 SSH、远程端口转发、多个 worktree 的原生 CLI 历史恢复。
- 同窗格可切换文件/编辑器、Git diff、ACP 对话、浏览器；旁边审阅 agent 修改。
- CPU/内存/端口进程检查；Claude/Codex transcript 用量估算。其他 agent 的用量和历史并非同等支持。
- 可复用 Bot 身份与群聊分派，可以作为后续协作工作区参考。

架构是 React + xterm.js，共用 ITerminalBackend 抽象；Tauri 桌面当前仍携带 Node PTY/API server，通过本地 WebSocket 访问。README 仍将 server-side PTY reload reconnect、LocalPtyBackend 和 cloud sandbox 标为 roadmap，不能据此视作已解决手机异地访问和常驻服务。

建议：保留 T3 的连接/移动适配方向和 Synara 的任务/会话底座；优先借鉴 Termany 的多会话组织、SSH 环境和状态聚合交互。它当前采用 AGPL-3.0，包声明 AGPL-3.0-only；不把代码当作 MIT 直接并入当前 fork。若后续决定采用其源码，需先确定项目分发/许可方案或另行许可。此处是工程复用边界记录，非对所有分发情形的法律结论。

来源：[README](https://github.com/thinkany-ai/termany)、[官网](https://termany.sh/)、[LICENSE](https://github.com/thinkany-ai/termany/blob/dev/LICENSE)。
