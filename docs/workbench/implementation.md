# 开发状态 · 2026-09-23

用户已授权在 `~/Stars` 开发，并要求尽量复用 T3 与 Synara 源码。旧的 product-scope.md 保留范围讨论；本文件记录实施状态。

## 已实施

以 Synara 完整工程作为底座，保留 Electron、React、Effect 后端、现有 provider adapters、会话存储和工作区功能。新增 `/workbench` 概览：真实最近任务、项目入口、Agent 配置状态、历史导入入口；无示例会话。无已恢复会话时可显示首页，已有会话保持原恢复逻辑。

T3 的 `threadSort.ts` 时间处理和稳定排序，以及 `ThreadSearchMatch.tsx` 中的搜索高亮，已直接移植并用于首页。精确来源、删减部分和适配说明见根目录 THIRD_PARTY_NOTICES.md。

产品名已由用户确定为 Metis；应用标题、开发桌面显示名、首页和文档已更新。现有数据目录、profile 与协议标识保持兼容，不迁移或清空会话。开发启动器只监听回环地址。主仓库 LICENSE、上游版权和原 README 保留；`@synara/*` 包名保持兼容。

## 本轮连接实现

已接入连接设置页、桌面 HTTP bearer 认证、可信 Origin CORS、T3 HTTPS URL/fragment 工具和 opt-in remote launcher。设备/配对接口保持 Synara 的现有契约，ServerConfig 仅新增可选 publicUrl。详细设置与边界见 [remote-access.md](remote-access.md)。

手机独立 HTML 交互稿仍是示例；真实 HTTPS 入口已接通，手机跨网体验未验收。`metis:serve` / `metis:remote` 默认复用桌面现有数据。首次启动共享服务前退出独占后台的 Electron；之后 macOS/Linux Electron 可识别已有服务并作为客户端连接，退出窗口不停止服务，继续使用原有配对和 Cookie。此模式还未接入后台到桌面浏览器/电脑控制 host 的桥接，也未支持 Windows ACL。旧独立远程 profile 由 `--isolated` 显式访问。数据库生命周期锁阻止同时打开两实例。Termany 只做参考调研，未导入其 AGPL 源码。

## 分支式回复（2026-09-25）

对话里每条助手回复的动作栏新增「Reply here」：在该回复正下方展开回复框，发送即以该轮为分叉点创建 fork 并把回复排队发出（`InlineReplyComposer` + `useComposerSlashCommands.createForkThreadFromMessage`）。有分叉的回复下方显示分支条（`ForkBranchStrip`：本对话在前、各 fork 依创建时间排列）；fork 线程在「Continued from chat」分隔线下显示同一分叉点的兄弟分支。侧栏把 fork 嵌套在源对话之下（`buildProjectThreadTree` 以 `forkSourceThreadId` 作为树边，源对话缺席时 fork 回退为顶层行）。

分叉点不新增持久字段：fork 导入的消息保留源消息的 role 与 createdAt，`lib/threadForkPoints.ts` 以最后一条 `fork-import` 消息的 (role, createdAt, 同键序号) 回查源线程的消息（序号用于区分缓冲投递下同一时间戳的多条助手消息）；子线程的键通过一次性 `getThreadDetailSnapshot` 串行取得并在会话内缓存，失败 15 秒后重试，不走实时订阅。

服务端 `orchestration/forkTruncation.ts`：fork 导入的前缀短于源线程当前可导入消息（页脚「从此处分叉」、就地回复，或源线程分叉后继续推进）时，`ProviderCommandReactor` 不再原生续接源会话（那样模型会看到用户舍弃的后续轮次），改为新开会话并用导入的对话记录做上下文引导；完整 fork 仍原生续接。

分叉出的线程没有 session，排队回复原本会被自动派发的「disconnected」门永久挂住；`queuedComposerDrain.grantQueuedComposerFirstSend` 只对该线程放行一次首发，session 出现或队列清空即撤销。点分支条切换线程时带上分叉点，目标对话滚到同一轮而非末尾。

两个从对话流里弹出的小输入框（选中文字新建对话 `SelectionNewChatComposer`、就地回复 `InlineReplyComposer`）共用 `TranscriptQuickComposerForm`：编辑器外壳、页眉/页脚插槽、发送按钮、错误行与防重复提交流程只写一份。

## 对话中切 provider（2026-09-26）

已开始的对话仍锁定 provider，但 `ComposerModelPicker` 不再把其它 provider 的标签和收藏预设过滤掉；在非当前 provider 的标签页顶部提示「选中即交接」。选中其它 provider 的模型走 `ChatView.switchThreadProvider`：对话在跑就先 `interruptThreadTurn`，用 `threadQuiescence.waitForThreadToSettle`（轮询 store，判据 `canCreateThreadHandoff`，20 秒超时）等它静止，再以选中的模型调 `useThreadHandoff.createThreadHandoff(thread, provider, { modelSelection })`。

服务端 `ProviderCommandReactor` 收到带 `handoff` 的 `thread.created` 时查源线程：`orchestration/handoffContinuation.ts` 的 `shouldContinueAfterHandoff` 只在源线程最新一轮是 `interrupted` 时成立，随后派发一条 `dispatchMode: "queue"`、`dispatchOrigin: "automation"` 的续跑轮（commandId 与 messageId 都是 `server:handoff-continue:<eventId>`，重放可去重）。菜单里的「Hand off thread」走同一条规则；从已完成的对话交接不会自动发轮。重启后的续跑由 `restartResume.ts`（他人未提交改动，设置项 `resumeChatsAfterRestart` 默认开）负责，本轮未动。

## 飞书桥接（2026-09-26）

见 [feishu.md](feishu.md)。服务端新增 `feishu/` 模块与 `@larksuiteoapi/node-sdk` 依赖；凭据在数据目录的 `feishu-app.json`，缺失即关闭。

## 继续复用的顺序

1. 使用继承的本机会话和工作区完成真实任务验收，确认授权、中断、恢复和成果查看。
2. 对照 T3 的 shared client-runtime 与连接管理，适配远程客户端的数据订阅、认证和断线恢复；服务端仍持有唯一任务状态。
3. 复用可兼容的 T3 手机交互及客户端组件。当前 T3 原生移动端不能直接接 Synara 的协议与存储，需独立适配后验收，不将源码存在视作功能已完成。
4. 基于实际使用统一两边的任务交接、自动化与成果入口；有成熟模块优先移植，不重写已有核心。

## 当前边界

此版本是本地开发分支，不是正式签名安装包。本机共享服务已通过自有 Cloudflare Tunnel 接通 HTTPS；手机跨网配对仍待用户确认。未自动导入个人会话，也未发起付费模型任务。继承功能仍需按使用场景验收；编译通过不等同于每个 provider 实测成功。

按用户约定不执行前端测试或浏览器 QA。本轮做类型、lint、格式、构建与非前端身份隔离检查；实际执行结果由完成记录给出。
