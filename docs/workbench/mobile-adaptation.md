# 手机端适配建议 · 2026-09-23

本轮是源码核对与方案说明，没有启用远程访问、修改监听地址或开始移动端移植。用户问「怎么适配手机端」，以下顺序为建议，未逐项确认。

## 结构

手机 Web / 原生 App → 认证与连接 → 同一个 Workbench 执行服务 → Mac 上的 Codex / Claude 与项目文件。桌面与手机读取同一任务状态；不另建手机任务数据库或让 CLI 在手机上运行。

## 现成代码与适配边界

- Synara 已有手机侧栏与 ChatView 的移动断点，以及 AuthControlPlane 的配对链接、设备会话及撤销能力。首步延用现有 Web 客户端打通同一后端，小屏调整重点是导航、输入键盘、安全区、触控与文件/成果面板。
- T3 的 `apps/mobile` 是 React Native / Expo 原生工程，需要 Dev Client，不能只放入 Expo Go。可复用连接/扫码界面、会话和消息组件、移动文件交互。不会承诺整个 app 原样可连接当前 fork。
- T3 `packages/client-runtime` 分离 authorization、connection、rpc、platform、state。移动端与 Web 共享其行为；当前 Workbench 使用 Synara 的分组 RPC 与协商机制，T3 客户端按其 WsRpcGroup 契约运行。需适配方法、数据、流式订阅、权限响应、附件地址和版本协商；不要直接混用两边 contracts/event stores。
- T3 的托管 Connect 是另外的账号与中继服务；克隆源码不等于自动接入该服务。首步可选局域网或私有网络的 HTTPS，之后再评估中继部署与成本。

## 建议实施顺序

1. 手机网页连接同一服务：授权、项目/会话列表、实时进度、回复、批准/拒绝、停止、成果预览。电脑生成一次性配对链接，手机扫码换取独立且可撤销的设备会话。
2. 将连接、会话命令、状态订阅和附件访问收敛为移动端适配边界，复用 T3 的可兼容连接/重试模块，验证断线重连补齐事件和写操作幂等。手机断网不得重复提交命令。
3. 接入 T3 原生 App 界面，替换产品身份、服务配置和平台存储适配；签名、推送、分享扩展按本产品配置，不能直接使用上游凭据。
4. 需要桌面退出后仍执行时，把执行服务生命周期与 Electron 窗口分离。当前桌面管理其子后端，不是独立常驻服务；Mac 睡眠/断网时应明确离线，手机关闭不应取消后台任务。

第一项验收目标：电脑启动任务 → 手机看到同一记录与进度 → 手机上回复或处理授权 → 电脑立即看到结果 → 手机断网恢复后状态一致。

## 核对来源

- 本地 T3 `apps/mobile/README.md`、`packages/client-runtime/README.md`、`src/rpc/protocol.ts`、`apps/mobile/src/features/connection/pairing.ts`。
- 本地 Synara `apps/web/src/wsTransport.ts`、`components/ui/sidebar.tsx`、`components/ChatView.tsx`、`apps/server/src/auth/Services/AuthControlPlane.ts`、`apps/desktop/src/main.ts`。
- 在线复核：[T3 远程访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)、[T3 移动端源码](https://github.com/pingdotgg/t3code/tree/main/apps/mobile)。本地版本固定信息见 upstream.json。
