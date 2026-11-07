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

## 主动发送文字、截图和文件

Agent 工具 `synara_send_feishu` 复用上述机器人凭据和 `allowedOpenIds`，支持 `kind: "text"`（`text`）、`kind: "image"`（截图/图片的 `path`）和 `kind: "file"`（文件的 `path`）。仅在用户明确要求发到飞书时调用；普通回复里的本地链接不会触发上传。一个请求发送一条消息。

- `requestId` 必填，同一次发送的重试必须沿用原值。成功返回飞书 `messageId` 才代表确认发送。
- 白名单只有一人时自动选该收件人；多人时必须指定其中一人的 `recipientOpenId`。不接受任意收件人或群聊。
- 文件必须在当前线程工作目录内，路径会解析真实路径，拒绝越界软链接、目录、空文件和超限文件。图片最大 10 MiB，文件最大 25 MiB。
- 上传使用现有 SDK 的 `im.v1.image.create` / `im.v1.file.create`，发送使用 `im.v1.message.create`。机器人需要相应的图片/文件资源上传权限（`im:resource`）及消息发送权限。权限失败会明确报错，不会宣称已发送。
- `<数据目录>/userdata/feishu-outbound/` 保存请求内容摘要、上传资源 key 和消息回执；开发模式在 `dev/feishu-outbound/`。相同请求重试不会重新上传已确认的资源，成功回执可跨重启复用。更换内容或收件人必须使用新的请求 ID。
- 未确认的发送以固定 UUID 重试；超过 30 分钟停止自动重发，要求先核对飞书，避免越过远端去重窗口后重复发送。工具会在上传及发送前重查白名单和当前轮次有效性。

示例：`{"requestId":"home-screenshot-1","kind":"image","path":"artifacts/home.png"}`。

## 旧会话映射

旧模式的 `<数据目录>/feishu-chats.json` 记录 chat_id → threadId，优先跟随 provider handoff 后继，否则在旧线程不可用时创建新会话。实例总控模式完全忽略该映射且不改写它；当前载体由实例身份管理。

## 代码

- `apps/server/src/feishu/feishuBridgeConfig.ts`：配置解析、停止指令、回复排版（纯函数，有测试）。
- `apps/server/src/feishu/feishuControllerRoute.ts`：解析实例总控身份，缺少活动总控时拒绝回退。
- `apps/server/src/feishu/Layers/FeishuBridge.ts`：`createLarkChannel` 长连接、收消息→`thread.turn.start`、轮询线程壳判定一轮结束、`channel.stream` 流式更新。
- `apps/server/src/feishu/feishuInboundAttachments.ts`：有界下载、MIME 识别、受管附件入库、提交失败清理；图片走既有 provider 图像输入，文件走既有文件路径交付。
- `apps/server/src/feishu/FeishuOutbound.ts` 与 `agentGateway/feishuTools.ts`：主动发送图片、文件及文字，校验收件人、工作目录和持久回执。
- 接线：`serverLayers.ts` 的 `feishuBridgeLayer`，`effectServer.ts` 在订阅作用域里 `feishuBridge.start()`。

## 未做

Router 会根据新建任务及后续补充的对应轮次结果生成自然语言汇报，再回复到对应飞书入站消息；补充按持久消息 ID 关联轮次，等待输出落库后发送，重连会重试未确认发送的结果。已发送确认丢失时仍可能重复。升级前已结束的投递记录不会自动重放。

普通 Router 消息（包括问候、状态和停止确认）统一由 Router 生成回复，不再先发送固定“收到”文案。生成失败不会回退成模板式成功回复；完成汇报生成失败保留待投递状态。成功生成的回复在重试和重启时复用，不重复生成。旧版已保存的首句与结果回执保留原有去重和引用关系。附件及审批消息仍使用专门的流式卡片和交互协议，其传输/审批状态不代表 Router 已生成会话回复。

飞书流式卡片的初始正文只显示省略号和 SDK 的 typing 光标，不显示“收到”“处理好后回复”等固定会话文案。Router 回复和附件/普通执行通道共用这一规则；附件下载前仍先打开卡片，执行后的实际助手输出继续更新到同一卡片。普通 Router 消息接收并持久化后，会并行打开等待卡片；卡片创建不阻塞 Router 接收。生成的回复替换同一张卡片的占位内容，任务完成汇报另开流式卡片，沿用 SDK 的打字动画。等待卡片只是传输状态，不是额外发送的 Router 首句。当前 Router 返回完整结构化回复后才更新正文，不逐 token 转发模型输出。等待超过两分钟时结束光标并提示后续发送，最终回复仍由持久投递队列负责；发送失败可重试。正常关闭、撤销白名单或会话失效会结束等待状态；进程崩溃后已有卡片由飞书超时结束，恢复投递使用新卡片，不保证复用崩溃前的卡片。

飞书卡片审批尚未接入。实例总控的普通回复已可回传；网页发起的轮次不会自动广播到飞书，可在用户要求时通过发送工具投递文字、截图或文件。历史消息不会自动重放。
