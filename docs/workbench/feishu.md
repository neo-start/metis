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

子任务结果单独主动推送、飞书卡片审批、附件向飞书发送尚未接入。实例总控的普通回复已可回传；网页发起的轮次不会自动广播到飞书。历史消息不会自动重放。
