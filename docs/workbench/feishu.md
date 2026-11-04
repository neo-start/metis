# 飞书接入

在手机上通过飞书私聊 Metis。可将 BOT 接到持久的实例总控，与桌面总控共享当前对话、模型、权限和长期记忆。每句话排队执行一轮，Metis 将该轮回复流式更新到飞书消息里，结束后附线程链接（已配置公开地址时）。

## 实例总控与旧会话模式

- 在私有配置中设置 `"target": "controller"`，每条消息和停止指令都通过 `MetisControllerService.overview()` 解析实例当前总控，不读取旧的 chat → thread 映射，也不按同名标题认定身份。
- 在桌面执行 `/clear` 或切换 provider 后，下一条飞书消息跟随新的总控载体。总控暂不可用时提示先在 Metis 中打开总控，不另建替代会话。
- 飞书沿用当前总控的模型、运行权限和交互模式；配置里的 `modelSelection` 仅用于旧模式新建会话。所有获准发送者共享总控上下文，`allowedOpenIds` 应仅包含允许使用该实例总控的所有者。
- 省略 `target` 或设为 `"chat"` 保持旧行为：每个飞书私聊映射到一条独立的主页总控会话，首次创建使用 `modelSelection`（缺省 Pi / `openrouter/deepseek/deepseek-v4.1-flash`）。旧会话与历史保留，不自动归档、迁移或重放。
- 回复依据入站消息 ID 对应的持久轮次回传；网页或其他消息的较新轮次不会被当成该消息的回复。命令回执防止已接收事件在 `/clear` 后再次执行。
- `target` 在桥接启动时读取，修改后需让运行中的后端加载新版代码并重启。发送者白名单仍会在每条消息前重新读取。

## 传输与附件

- 传输：飞书「长连接」（本机主动出站 websocket），不需要公网回调地址，断线自动重连。
- 只回应 `feishu-app.json` 里 `allowedOpenIds` 列出的发送者，群聊一律忽略。
- 发「停」「stop」会打断当前这一轮。
- 线程需要批准或回答时，飞书会收到一条提醒，但要回 Metis 里处理；手机上直接批准是第三层的事。
- 私聊图片和文件通过消息资源接口下载，接入与网页上传相同的受管附件存储，再随用户消息交给当前 provider。音频/视频按普通文件传递，不承诺转写。单条最多 8 个附件，图片 10 MiB、文件 25 MiB，沿用现有附件限制；表情包 API 不支持下载，会提示改发图片。
- 附件下载或保存失败时明确报错，本条不会降级成只有占位文字的模型任务；成功接收的附件沿用发送者、线程和消息归属验证。白名单之外的消息不下载附件。

## 配置

凭据文件 `<数据目录>/feishu-app.json`（0600，目录被 git 忽略）：

```json
{
  "appId": "cli_…",
  "appSecret": "…",
  "allowedOpenIds": ["ou_…"],
  "target": "controller",
  "publicOrigin": "https://metis.example"
}
```

`modelSelection` 与 `publicOrigin` 可省略；后者缺省取 `METIS_PUBLIC_URL`，没有就不附链接。文件不存在或仍是占位内容时桥接关闭，服务照常启动，日志里有 `feishu bridge disabled` 和原因。

飞书开放平台侧：接收入站资源使用 SDK `im.v1.messageResource.get`，携带原消息 ID 和资源 key；不能替换成仅获取机器人上传资源的 `image.get/file.get`。若该接口返回权限错误，需要在应用后台启用其要求的消息资源读取权限并发布配置。

自建应用；事件订阅方式选「长连接」；添加事件 `im.message.receive_v1`；权限至少 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message`、`contact:user.base:readonly`；发布版本后机器人才可在私聊里收到消息。

旧模式使用 Pi 时：`~/.pi/agent/auth.json` 里要有 OpenRouter 的 `api_key`（终端 `pi` 里 `/login` 选 OpenRouter）。实例总控模式复用总控现有 provider 配置。

## 会话映射

旧模式的 `<数据目录>/feishu-chats.json` 记录 chat_id → threadId，优先跟随 provider handoff 后继，否则在旧线程不可用时创建新会话。实例总控模式完全忽略该映射且不改写它；当前载体由实例身份管理。

## 代码

- `apps/server/src/feishu/feishuBridgeConfig.ts`：配置解析、停止指令、回复排版（纯函数，有测试）。
- `apps/server/src/feishu/feishuControllerRoute.ts`：解析实例总控身份，缺少活动总控时拒绝回退。
- `apps/server/src/feishu/Layers/FeishuBridge.ts`：`createLarkChannel` 长连接、收消息→`thread.turn.start`、轮询线程壳判定一轮结束、`channel.stream` 流式更新。
- `apps/server/src/feishu/feishuInboundAttachments.ts`：有界下载、MIME 识别、受管附件入库、提交失败清理；图片走既有 provider 图像输入，文件走既有文件路径交付。
- 接线：`serverLayers.ts` 的 `feishuBridgeLayer`，`effectServer.ts` 在订阅作用域里 `feishuBridge.start()`。

## 未做

子任务结果单独主动推送、飞书卡片审批尚未接入。附件出站见下文。实例总控的普通回复已可回传；网页发起的轮次不会自动广播到飞书。历史消息不会自动重放。

## 出站媒体（需部署包含此变更的后端）

根因：此前只有 `channel.stream` 文本回传；本地 Markdown 图片、`view_image` 和浏览器截图只供本机/模型查看，没有媒体上传或发送回执。`publicOrigin` 仅用于线程链接。此实现通过飞书应用 SDK 的 multipart 上传取得 `image_key/file_key`，再调用消息 API；不依赖公网文件托管。

Agent 调用 `metis_feishu_media`，例如：

```json
{
  "action": "send",
  "requestId": "requested-browser-proof-1",
  "caption": "你要的页面截图",
  "attachments": [{ "kind": "image", "path": "/本轮/browser-proof/返回的实际artifactPath.png" }]
}
```

先使用 `browser_screenshot({kind:"proof"})` 取得实际 `artifactPath`；示例路径不能直接使用。`send` 立即上传并发送；`attach` 上传并登记本轮回复附件，仅该轮 `completed` 后发送，桥接会在最终文字中附投递结果。普通文本中的路径不触发上传，网页发起的轮次无飞书绑定，也不能指定 chat/user 收件人。两种入口使用同一个持久发送队列。

- 输入支持 `kind: image/file/audio/video`；`path` 与 `attachmentId` 二选一，最多 8 个、每个最多 25 MiB。显式本地文件须位于当前线程工作区或该线程自己的 browser-proof 目录；拒绝 URL、隐藏/私有路径、工作区外路径、符号链接和空文件。其他生成结果请先按用户授权存入工作区。受管附件 ID 必须同时匹配当前飞书应用、发送者和线程，并且未过期。
- PNG/JPEG/GIF/WebP 且不超过 10 MB 可作为图片；PNG/GIF 预检平台分辨率上限，其余图片由平台继续校验。其他图片格式、超限原生图片、非 Opus 音频、非 MP4 视频、缺失时长均明确回退为普通文件。超过应用 25 MiB 上限直接拒绝，不自动压缩/转码。原生格式损坏或平台进一步拒绝时保留失败码，不宣称成功。
- 原生音频须 Ogg Opus；视频须可识别的 MP4 容器。两者需填写正整数 `durationMs`（毫秒），在文件上传时传递；可选 `coverPath` 仅用于视频，会作为图片另行上传。不自动探测编解码器、转码或猜测时长；文件头预检不等于完整媒体解码验证。
- 可用 `{"action":"status","requestId":"…"}` 在同线程后续飞书轮次查回执。`sent` 且有 `messageId` 才表示 API 确认发送；`queued` 仅表示待投递，`partial/failed/unknown/cancelled` 均不能当全部成功。同一个 requestId 和相同请求只回放回执，不重新上传或发送；不同内容或跨轮重用发送 ID 拒绝。明确失败需修正后仅重试未发送项，使用新 ID；未知结果不能换 ID 重发。
- `cancel` 停止尚未投递的项；无法撤回已发送或正在请求中的消息。停止/失败轮次取消已登记附件；排队超过 24 小时取消。说明文字与附件按顺序发送，逐项记回执；未知发送后停止其余项。
- `<stateDir>/feishu-media` 使用现有私有原子文件写入保存入站绑定及发送记录。每次发消息先落盘发送意图；进程丢失后该项转 `unknown`，不会自动重发。恢复轮询只处理尚未开始发送的项。`status` 可按当前聊天、应用身份、上传 key、时间窗口查找唯一匹配消息；存在重复 key、多个匹配、时间偏差、读取权限不足或超出有界扫描范围时保持未知。说明文字无法这样查证，须人工核对。保留原 ID，不清空回执后重试。记录不保存凭据和媒体字节，临时媒体复用受管存储配额和清理机制。

官方接口依据（2026-11-04 核对官方文档及已锁定的 `@larksuiteoapi/node-sdk@1.74.0` 类型/实现）：[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)、[消息内容](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[读取历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)。平台上传图片上限 10 MB（GIF 2000×2000，其余 12000×12000），文件上限 30 MB；本应用沿用更小的 25 MiB 文件上限。文件上传类型为 `stream/opus/mp4`，原生消息类型为 `file/audio/media`，图片 `image_type=message`。发送 `uuid` 官方去重窗口只有一小时，本地持久回执继续防重，不能依赖过期 UUID 重发。

需开启机器人能力，上传权限 `im:resource` 或平台提供的 `im:resource:upload`、发送权限 `im:message:send_as_bot`（或官方列出的等价权限）；查证还需要历史消息读取权限。权限/应用版本请由所有者在飞书后台核对并发布；本实现不修改权限。错误返回安全的 `feishu_api_<code>/feishu_http_<status>`，不会返回携带凭据的 SDK/Axios 原始错误。

### 发布与真人验收

变更在隔离 worktree 验证，未写运行中的 dist、未重启部署、未向真实飞书发送。发布协调者先确认 Metis 活动会话可安全切换，再合并分支、按现有流程构建并重启后端；此文档不是自动重启授权。恢复后核对当前用户入站消息的 p2p chat、sender、thread/turn 绑定，使用该用户明确请求的截图调用 `send`，核对真实 `messageId` 与手机可见结果，再按需验收其他媒体。不得猜收件人、借用其他项目群或以本地模拟结果代替真人验收。

本地测试使用真实 SDK、临时 SQLite、临时文件和仅监听 127.0.0.1 的 HTTP 服务验证 multipart 字节→key→消息请求；Opus/MP4 使用结构化协议夹具，不证明真实飞书播放器能播放。桥接测试使用实际编排轮次验证 attach 完成、回执和 Markdown 不自动上传。
