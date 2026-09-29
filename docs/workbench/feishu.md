# 飞书接入 · 2026-09-26

在手机上通过飞书私聊 Metis：一条飞书私聊对应一条常驻的 Metis 线程（总控），你发的每句话是一轮，Metis 边跑边把回复流式更新到飞书消息里，跑完发最终回复和线程链接。

## 现状（第一层：最小闭环）

- 传输：飞书「长连接」（本机主动出站 websocket），不需要公网回调地址，断线自动重连。
- 只回应 `feishu-app.json` 里 `allowedOpenIds` 列出的发送者，群聊一律忽略。
- 总控不属于任何项目：它是一条置顶的主页对话「Metis 总控」（kind 为 chat 的容器，文件夹在聊天工作区根目录下的 `metis-console`，侧栏把归属显示为 Metis 本身）。provider 默认 Pi，模型 `openrouter/deepseek/deepseek-v4.1-flash`，运行模式 full-access。Pi 会话自带 Metis Agent Gateway 工具，总控可以在各项目里建线程、派任务、等结果。
- 发「停」「stop」会打断当前这一轮。
- 线程需要批准或回答时，飞书会收到一条提醒，但要回 Metis 里处理；手机上直接批准是第三层的事。
- 附件暂不带入，只处理文字。

## 配置

凭据文件 `<数据目录>/feishu-app.json`（0600，目录被 git 忽略）：

```json
{
  "appId": "cli_…",
  "appSecret": "…",
  "allowedOpenIds": ["ou_…"],
  "modelSelection": { "provider": "pi", "model": "openrouter/deepseek/deepseek-v4.1-flash" },
  "publicOrigin": "https://metis.example"
}
```

`modelSelection` 与 `publicOrigin` 可省略；后者缺省取 `METIS_PUBLIC_URL`，没有就不附链接。文件不存在或仍是占位内容时桥接关闭，服务照常启动，日志里有 `feishu bridge disabled` 和原因。

飞书开放平台侧：自建应用；事件订阅方式选「长连接」；添加事件 `im.message.receive_v1`；权限至少 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message`、`contact:user.base:readonly`；发布版本后机器人才可在私聊里收到消息。

Pi 侧：`~/.pi/agent/auth.json` 里要有 OpenRouter 的 `api_key`（终端 `pi` 里 `/login` 选 OpenRouter）。

## 会话映射

`<数据目录>/feishu-chats.json` 记录 chat_id → threadId。线程被归档后下一条消息会新建线程并覆盖映射。

## 代码

- `apps/server/src/feishu/feishuBridgeConfig.ts`：配置解析、停止指令、回复排版（纯函数，有测试）。
- `apps/server/src/feishu/Layers/FeishuBridge.ts`：`createLarkChannel` 长连接、收消息→`thread.turn.start`、轮询线程壳判定一轮结束、`channel.stream` 流式更新。
- 接线：`serverLayers.ts` 的 `feishuBridgeLayer`，`effectServer.ts` 在订阅作用域里 `feishuBridge.start()`。

## 未做

第二层（总控派单的提示词与工具面收窄、结果回执直达飞书）、第三层（飞书卡片审批、附件）。
