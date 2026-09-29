# Metis — Claude Code 接手说明

更新：2026-09-24 11:16（Asia/Shanghai）。本文件整理当前有效上下文，旧笔记里与它冲突的进程号、品牌、连接状态以本文件为准。运行状态是快照，执行操作前需重新确认。

## 先看这里

项目是 `/Users/neo/Stars/agent-workbench`，产品名 **Metis**。用户要一个真正的桌面 Agent 工作台，结合 T3 Code 与 Synara 的能力，并能在异地手机上访问电脑中的同一工作区。当前是 Synara 底座上的开发版本，已选择性移植 T3 模块，远未完成两者所有功能。

**（已于 2026-09-24 修复并经用户实测成功，见下文「Claude Code 排查与修复」。）原问题：用户手机打开配对链接，看到 `This pairing link could not be used.`。原因未确认，故障未修复，手机连接从未验收成功。** 上一条建议只是重新生成链接再打开，并不是修复结果。请优先查清这一问题，不要继续重复同一份配对教程，也不要先扩展其他功能。

本次交接只写文档，没有重启服务、改业务代码、消费配对凭据或发送消息给 Claude。

## 工作区与用户约束

- 先读根目录 [AGENTS.md](../../AGENTS.md)；[CLAUDE.md](../../CLAUDE.md) 已导入它。
- 当前分支 `main`，HEAD `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。Metis 改动尚未提交；大量修改和未跟踪文件共同组成当前工作成果，不能 reset、stash、覆盖、清理未跟踪文件或重克隆代替它们。
- 用户授权在 `~/Stars` 开发这个独立项目，并明确要求尽量复用 T3 和 Synara 源码。先搜索已有实现，再写适配。保留许可与来源记录；不要拼接不兼容的事件库和认证体系。
- **没有明确要求时，不新增或执行前端测试、浏览器自动化、截图或视觉 QA。** 允许格式、lint、类型、构建和相关非前端检查。不要把常规“帮我修复”自动解释成解除这条约束。
- 用户重视真实桌面体验：不要用打开网站替代“打开 Metis”。代码变更后需要构建并更新本地使用的程序，但重启前先确认活动任务和后端所有权。
- Hover 按钮预留空间，短 opacity/轻微位移动效；按钮本身有 hover/pressed/focus 状态，支持 reduced-motion。复用现有图标和主色，不动画 width/height/padding/margin。
- UI 字体遵循用户设置的 `text-ui*` / `text-chat*` tokens，优先复用现有组件。
- 此项目与 Dagent/Fleet 分开。**没有修改 Fleet 的授权**；Dagent 旧任务只允许在 `/Users/neo/Maxgent/wt-dev` 开发，本次不要转去修改它们。
- 不输出或记录 token、cookie、配对链接完整凭据、私钥；不通过打印环境变量或完整日志来排查。

## 产品与来源决策

- 用户试过 Emdash 后明确拒绝，`~/Stars/emdash` 已删除，不要恢复它。
- 用户要 T3 + Synara 的能力，不是只做多终端壳或静态 UI。核心目标包括多 CLI/provider、项目/会话、工作区、差异与结果、跨设备续接；具体支持程度须实测，不能因上游有源码就宣称已完成。
- 以 **Synara** 为运行和数据模型底座：`https://github.com/Emanuele-web04/synara`，基线 commit 同当前 HEAD。
- **T3 Code** 只读参考位于 `.upstream/t3code`，commit `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`，来源 `https://github.com/pingdotgg/t3code`。
- 两者 MIT；见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)、[upstream.json](upstream.json)。Termany 仅调研，AGPL，未引入源码。
- 已直接适配 T3 的 threadSort 子集、搜索高亮、HTTPS origin 校验和 URL fragment token 写入；未移植整套 T3 云控制服务、账号或原生移动端。
- T3 Connect 的托管服务不会随 clone 免费取得；目前手机走自有 Cloudflare Tunnel + Web，尚无原生手机 App、二维码或推送。

## 已实现的内容和代码入口

| 模块             | 当前实现                                                                                            | 入口                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作台           | `/workbench` 展示真实项目、最近任务、搜索、provider 状态及新任务/历史导入等入口；保留既有会话恢复   | `apps/web/src/components/WorkbenchHome.tsx`、`apps/web/src/routes/_chat.workbench.tsx`                                                      |
| T3 复用          | 排序、搜索高亮、连接 URL 工具                                                                       | `packages/shared/src/workbenchThreadSort.ts`、`apps/web/src/components/HighlightedSearchText.tsx`、`packages/shared/src/workbenchRemote.ts` |
| 桌面入口         | 默认构建版 Electron；有共享后台则作为客户端接入，否则启动独占后台                                   | `scripts/workbench.mjs`、`apps/desktop/src/main.ts`                                                                                         |
| 共享服务/隧道    | 同一数据目录、单后端所有权、健康等待、私有一次性 owner 链接、日志遮盖凭据                           | `scripts/workbench-remote.ts`、`scripts/lib/metis-runtime.ts`                                                                               |
| 桌面接入共享服务 | 检查私有文件权限/归属/符号链接、存活 PID、地址；原生 Cookie 配对；导航限制在配置 origin；不另启后台 | `apps/desktop/src/metisSharedService.ts`、`main.ts` 的 `bootstrap` / `loadMetisSharedWindow`                                                |
| 连接设置         | 管理员生成一次性配对链接，查看/作废链接，查看/撤销设备；普通 client 无管理权限                      | `apps/web/src/components/settings/ConnectionsSettingsPanel.tsx`                                                                             |
| HTTP 认证适配    | 桌面独占模式可用启动凭据换普通 HTTP session；公网模式禁止此捷径；可信 Origin/CORS 仍生效            | `apps/web/src/wsNativeApi.ts`、`apps/server/src/http.ts`、`apps/server/src/auth/Layers/ServerAuth.ts`                                       |
| 配对页           | `/pair#token=…`，先清除 fragment，再 POST bootstrap，成功后转 `/`                                   | `apps/web/src/bootstrap.ts`、`apps/web/src/pairingBootstrap.ts`                                                                             |
| 品牌             | 当前应用标题及 AppSnap 等当前界面文案改为 Metis；保留上游历史署名/兼容标识                          | `apps/web/src/branding.ts`、`AppSnapWelcomeDialog.tsx`、桌面 `main.ts`                                                                      |

共享模式认证沿用既有接口，没有新增一套认证协议。原生首次启动可消费私有、未过期 owner 链接；已有 cookie 失效时不静默重新授权。否则由用户在已登录管理员设备生成链接，原生弹窗经用户点击才读取剪贴板。

## 品牌和资源：用户已确认

- 产品名 **Metis**，不用希腊字母作为主名。
- Logo 是第二轮立方体方案 02「三面折叠 / Folded Volume」，用户选择**蔚蓝**。
- 应用内透明 Logo：`apps/web/public/metis-logo-blue.png`；来源 `docs/metis-logo-colors/images/01-blue.png`。
- 用户随后明确要求 Dock 图标**白底、Logo 居中**，已生成并认可：`apps/desktop/resources/metis-app-icon-blue.png`，网页副本用于 Apple touch 等。
- 沿用 `SynaraLogo` 组件名称只是兼容接口。不要为了改品牌迁移数据库、profile、`@synara/*` 包名或协议。
- 本地桌面 bundle ID `local.agentworkbench.desktop.dev`，profile `agent-workbench-dev`；正式发布各平台身份仍未全面迁移。
- 详见 [branding.md](branding.md) 及同目录 ImageGen 来源记录。换图标未重签应用、未重置 TCC。

## 当前运行快照

2026-09-24 11:15（上海）重新核对：

| 项目                    | 值                                                                   |
| ----------------------- | -------------------------------------------------------------------- |
| 公网入口                | `https://metis.clipmind.tech`                                        |
| 本机共享服务            | `http://127.0.0.1:4785`                                              |
| 两端 `/health`          | HTTP 200，`status=ok`，`startupReady=true`                           |
| 共享 launcher / backend | PID `80783` / `80784`，均仍存活                                      |
| 桌面 Electron           | PID `89739`，仍存活                                                  |
| 共享服务启动时间        | `2026-09-23T14:47:46.359Z`                                           |
| 桌面可执行文件          | `apps/desktop/.electron-runtime/Metis.app/Contents/MacOS/Electron`   |
| 数据目录                | `.agent-workbench/`，数据库 `.agent-workbench/userdata/state.sqlite` |

这些 PID **不是重启脚本参数**，操作前重新检查进程身份。只读 `metis-service.json` 可以确认运行元数据，不要泄露同目录的敏感文件。

Cloudflare：用户自己的 `metis-tunnel`，路由已保存为 `metis.clipmind.tech → HTTP 127.0.0.1:4785`。本机官方 `cloudflared` 位于 `/Users/neo/.local/bin/cloudflared`，此前安装版本 2026.9.1。当前网络 QUIC 不通，私有启动脚本设置 `TUNNEL_TRANSPORT_PROTOCOL=http2` 后已连通；入口仍是 HTTPS。

私有文件只说明位置，不复制内容：

- `.agent-workbench/run-remote.zsh`：0700，加载现有域名、cloudflared 路径和凭据，启动远程服务。**它不转发命令行参数，不能给它附加 `--dry-run` 来模拟启动。**
- `.agent-workbench/cloudflare-tunnel-token`：0600，已配置的隧道凭据。
- `.agent-workbench/metis-service.json`：运行元数据。
- `.agent-workbench/owner-pairing-url.txt`：启动时产生的 5 分钟一次性 owner 链接，过期会删除；交接时该文件不存在，这是预期情况，不代表服务坏了。

共享后台目前是独立运行进程，不是已安装的系统登录自启 daemon。电脑必须在线、不休眠；关闭网页不结束任务，桌面客户端不拥有共享后台的停止权限。不要再次启动一个竞争同一数据库的服务。

## 手机配对故障：已知与未知分开

用户先问“怎么连手机”，随后报告 `This pairing link could not be used.`。已提供的流程是：电脑 Metis 设置 → 手机与远程连接 → 生成一次性配对链接 → 复制到手机 Safari/Chrome 打开；5 分钟、单次使用。配对成功后才可直接访问根域名。

已确认：

1. 本机与公网健康检查正常。
2. 用一个明显无效、非真实用户凭据请求公网 `POST /api/auth/bootstrap`，返回预期 HTTP 401 JSON `Invalid bootstrap credential.`，同域 Origin 被接受。只证明请求可到达认证处理器，**不证明真实凭据兑换成功**。
3. `pairingBootstrap.ts` 对缺少 token、非 2xx 和 fetch 异常都显示同一个错误页。页面一进入就清除 URL fragment，复制失败页地址重试会缺 token。
4. 正常流程只有一个 bootstrap 调用入口，没有找到“React StrictMode 双调用”证据。
5. 只读连接当前 SQLite 返回 `database is locked`；没有绕过锁、复制活动数据库、改数据或重启服务来读配对记录。
6. 现有日志不足以证明这次请求的具体失败原因。没有消费用户真实配对链接来做验证。

仍未知：手机具体浏览器、是直接粘贴还是微信/飞书内打开、是否完整保留 fragment、真实 POST 的状态码、是否过期/已消费、失败发生在兑换前还是网络响应阶段。已通过异步问题询问打开方式，用户尚未回答，随后要求交接。

建议接手顺序（待实施，不是已完成）：

1. 先取得手机打开方式和一次新尝试的时间/可观察错误信息，不需要用户公开完整凭据。
2. 在现有认证边界内区分缺少 token、401、403、网络错误；如增加诊断，只记录安全状态码/原因类别，不记 credential、URL fragment 或 session token。
3. 用独立临时 home/端口做后端真实 HTTP 配对闭环检查；需要手机或前端验收时遵守用户限制，不能把现有健康检查当作替代。
4. 给出有证据的修复；只在确有必要、确认任务状态后更新正在运行的后端。不要清理数据库/账号或放宽 Origin、单次使用、过期和设备撤销规则来“修复”。

关键后端文件：`apps/server/src/auth/Layers/BootstrapCredentialService.ts`（5 分钟 TTL、消费语义），`apps/server/src/persistence/Layers/AuthPairingLinks.ts`（持久化及消费），`apps/server/src/auth/Layers/ServerAuth.ts`（统一为401的错误映射），`apps/server/src/http.ts`（bootstrap/cookie/CORS），`apps/server/src/trustedOrigins.ts`。

### 2026-09-24 11:30 Claude Code 排查与修复

证据（数据库只读快照，只查时间/状态列）：两条 client 配对链接 14:52:08Z、15:06:37Z 生成，均**未消费、未撤销**；用户 15:08:18Z 报错，距第二条生成仅 1 分 40 秒，排除过期。带正确凭据的兑换请求从未到达并成功，原因只剩：fragment 丢失（聊天软件链接识别截断 `#` 之后）、网络/Cloudflare 拦截、或打开了旧链接。服务端当时无请求级日志，无法再细分。

已改：

- `apps/web/src/pairingBootstrap.ts`：按原因分别提示（缺配对码 / 401 失效 / 其他 4xx 拦截 / 5xx 电脑离线 / 网络错误）并显示诊断状态码；页面内可手动输入 12 位配对码或粘贴整条链接；网络与 5xx 失败保留同一码可重试。改编自 T3 `PairingRouteSurface.tsx`，已记入 THIRD_PARTY_NOTICES 与 upstream.json。
- `ConnectionsSettingsPanel.tsx`：生成后同时显示分组配对码，并提示可打开 `<域名>/pair` 手输。
- `ServerAuth.ts`：兑换失败记 `Rejected pairing credential exchange.` + 固定原因串，不记凭据。**需重启共享后台才生效，尚未重启。**
- 已重建 `apps/web/dist`，公网 `/pair` 已是新页面；后台未重启。

检查：fmt:check 仅 `.impeccable/hook.cache.json`（hook 缓存，git 排除）不合格，源码通过；lint 0 errors / 728 warnings；typecheck 通过；server `src/auth` + `authEffectRoute` 8 files / 54 tests 通过。未跑前端测试或视觉 QA。2026-09-24 用户实测：手机配对成功（未记录走的是链接还是手输配对码）。

### 2026-09-24 12:00 监测后改进（已构建，待重启共享后台）

- 用量显示：本机 TUN 代理把外部域名解析到 198.18.0.0/15，出站策略拒绝，Codex/Claude 用量每分钟失败。新增 `OutboundHttpPolicy.allowProxyFakeIp`（`packages/shared/src/outboundHttp*.ts`），只对固定官方地址（Codex 用量与 token 刷新、Claude 用量）开启；其他出站（含凭据可改地址的 Devin）不变。
- `ClaudeAdapter.ts`：`commands_changed` 等 7 个内部 system 子类型按 T3 做法静默消费，不再产生「Runtime warning」。
- Claude 进程空闲 10 分钟退出是设计（`ProviderService.ts` 的 `SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS`，下一轮 `--resume`），未改。后台 Haiku 用量用户认可，不处理。
- 检查：typecheck 通过；lint 0 errors / 728 warnings；server ClaudeAdapter+providerUsage 20 files / 414 passed；shared outbound 18 passed。`apps/server/dist` 已重建，含以上改动和配对失败日志。**共享后台尚未重启**（自动模式拒绝了停止进程的操作，需用户执行）。

### 2026-09-24 17:15 共享模式接上内置浏览器/操作电脑（已构建，待重启）

- 原因：后台按启动时的环境变量去连桌面端的本地接口；共享后台由启动脚本单独拉起并删掉这些变量，桌面端在共享分支里也不开接口，于是报 `BrowserHostUnavailable`。
- `scripts/lib/metis-runtime.ts`：`metisDesktopHostBridge` 固定 `<home>/run/browser-host.sock`、`cua-host.sock`（0700 目录，路径超 100 字节或 Windows 时不提供）；`metisServerEnvironment` 只传路径与 `SYNARA_BROWSER_HOST_CAPABILITY_FD=3`，密钥不进环境变量。
- `scripts/workbench-remote.ts`：生成密钥，写 0600 的 `desktop-host.json` 给桌面端读，经 fd 3 交给后台；退出时删除；隧道进程不继承这些变量。
- `apps/desktop/src/metisSharedService.ts` `readMetisDesktopHostBridge`：只认本启动器 pid、`run/` 下固定文件名、私有目录。`main.ts` `startMetisSharedDesktopHosts`：共享分支里开浏览器接口；macOS 上用固定地址开操作电脑接口（先清残留套接字）。
- 验证：typecheck、lint 0 errors；scripts metis-runtime 14 passed，desktop metisSharedService 26 passed；隔离 home（端口 4799，--local）实启：文件权限正确、后台环境只有路径、fd 3 已消费，退出后自动清理。**未做端到端（需重启真实服务并重开桌面后让 agent 开网页）**。
- 已知限制：密钥文件与隧道凭据同在 `.agent-workbench/`，同一用户的进程可读；Linux 操作电脑接口不支持固定地址，共享模式下只接浏览器。

### 2026-09-25 Claude 缓存过期提示可记住选择（已构建，待重启）

- 设置 `providers.claudeAgent.cacheReviewDecision`（`ask`/`continue`/`compact`，默认 ask）；web 映射为 `claudeCacheReviewDecision`，Settings → Models「When Claude's prompt cache expires」。
- `ComposerClaudeCacheReviewPanel` 加「Remember this choice」勾选（/compact 请求不显示）；`ChatView` 在有记住的选择时，对每个 pending 复核只自动发一次同样的 `thread.claude-cache.respond`；压缩不可用或自动发送失败时保留面板手动选择。需要有客户端打开该对话才会自动回答。
- 检查：typecheck、lint 0 errors；contracts 256 passed、server serverSettings 11 passed；只补了两个前端测试的类型夹具字段，未运行前端测试。web 与 server 已构建；**旧后台会忽略新设置字段，需重启共享后台**。

### 2026-09-25 用量展示模块（已上线网页）

- 抽出共享 `components/ProviderUsageCard.tsx`（原在 Settings → Usage 内）与 `hooks/useProviderUsageOverview.ts`；设置页改用它们，行为不变。
- 工作台首页右栏新增「用量」卡片（`WorkbenchHome.tsx` `WorkbenchUsageSection`），链接到 Settings → Usage。
- 侧边栏底部常驻 `SidebarProviderUsage.tsx`：每个已登录模型一行，显示最紧额度的剩余百分比（`selectPrimaryProviderUsageDisplayRow`），点击进 Settings → Usage；在设置页隐藏。
- 数据沿用 `serverAllProviderUsageQueryOptions`（60s 轮询，后台 5 分钟缓存与 429 退避）。用量出站：代理 fake-IP 修复已随 09-25 17:10 重启生效；无凭据探测 anthropic 429、chatgpt 401，严格模式仍报保留地址（对照成立）。
- 检查：typecheck、lint 0 errors / 728 warnings；web 已构建，未做前端测试或视觉验收。

## 其他已知未完成项

- ~~共享模式的后台 → Electron browser/computer host 桥接未接入~~：2026-09-24 已实现，待重启后端到端验证（见上文）。
- 共享模式 Windows ACL 尚未适配，因此 Windows attachment 明确拒绝；macOS/Linux 路径有实现，但 Linux 没有实机验收。
- 退出残留：旧 Electron `80884` 收到 SIGTERM 后 renderer 退出，主进程仍残留。确认只剩 Electron helpers、没有 backend/provider 子进程后，曾单独结束旧客户端，再打开新桌面；共享后端持续健康。**不能宣称正常优雅退出已验收**，需要后续排查。
- `--dev` 热更新曾遇本机 `unable to start FSEvent stream`，默认改用构建版。
- 没有原生手机端、二维码、推送、自有云端控制服务、系统登录自启或签名安装包。
- 没有逐一实测所有 provider、真实付费模型任务、跨网审批/重连/撤销闭环。
- 本地会话历史导入是副本，不是与原 CLI 历史双向同步；handoff 不是内部 context 无损搬运。
- 旧默认文档路径仍可能是 `~/Documents/Synara`。许可、历史 changelog、协议/包名中的 Synara 是有意保留；不要全仓无差别替换。

## 命令与验证记录

在项目根目录执行。不要为了查看页面重启已有共享服务。

```sh
cd /Users/neo/Stars/agent-workbench

# 桌面；已运行时不需要重复打开，默认连接已有共享后台
npm run metis

# 启动前只检查命令配置，不连接隧道
npm run metis:serve -- --dry-run
npm run metis:remote -- --dry-run

# 仅在确认当前没有同数据目录 owner 后才真正启动共享服务
# npm run metis:serve
# /bin/zsh .agent-workbench/run-remote.zsh

# 修改代码后的既有检查命令
npm exec --yes --package=bun@1.4.2 -- bun run fmt:check
npm exec --yes --package=bun@1.4.2 -- bun run lint
npm exec --yes --package=bun@1.4.2 -- bun run typecheck
npm exec --yes --package=bun@1.4.2 -- bun run build:desktop
```

`metis:serve/remote` 默认复用 `.agent-workbench`；`--isolated` 才访问旧独立远程 profile `.agent-workbench-remote`。隔离后端验证可设置 `METIS_HOME` / `METIS_PORT`，不要将它与 `--isolated` 混用。源码桌面入口会自行设置固定 home，不能假设给 `npm run metis` 一个环境变量就能隔离。

最近完成的检查：

- fmt:check、lint、typecheck、build:desktop 通过；lint 为 **0 errors / 728 继承 warnings**；typecheck 7 tasks、build 4 tasks。
- 共享桌面接入：原生完整套件 **103 files / 1222 passed / 6 skipped**；独立 launcher `node:test` 通过；Windows runtime 静态边界通过，不等于 Windows 实机验证。
- 标题更新后：受影响原生 **3 files / 75 tests** 通过。
- 更早共享认证隔离环境曾验证 owner/client、一次性消费、重放拒绝、权限/Origin、设备撤销及重启保留会话，详见 [verification.md](verification.md)。它们不代表本次手机失败已经被覆盖。
- 没有前端测试、浏览器自动化或视觉 QA。用户提供的 AppSnap 截图只说明其看到该界面。

日志目录 `/Users/neo/output/metis-20260923/`：`desktop-attach-*.log`、`brand-titles-*.log`、`remote-desktop-shared-live.log`、`desktop-brand-titles-live.log`。可能涉及敏感信息，读取时只输出所需且已脱敏的字段。源码开发桌面 `initializePackagedLogging()` 在非 packaged 情况下不初始化文件 sink；不要把没有 desktop-main.log 当作未启动。

## 进一步阅读与交接边界

项目资料：[README](../../README.md)、[implementation](implementation.md)、[remote-access](remote-access.md)、[verification](verification.md)、[branding](branding.md)、[PRODUCT](../../PRODUCT.md)、[DESIGN](../../DESIGN.md)。`mobile-preview/index.html` 是示例交互稿，不是真实已连接的手机应用。

本机长期记忆：`/Users/neo/.codex_memory/README.md`、`current/agent-desktop.md`、`sessions/2026-09-23-metis-shared-desktop-brand-titles.md`、`sessions/2026-09-23-metis-mobile-pairing-failure.md`。旧 current 文档有按时间追加的互相覆盖记录，优先本交接文件及实际源码/运行状态。

当前接手目标：**修复并确认手机配对，再处理共享模式桌面退出和原生能力接入，之后继续产品开发。** 本文件中的后续建议不是新的部署、发布或外部平台修改授权。
