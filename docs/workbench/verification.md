# 首版检查记录 · 2026-09-23

- `bun run fmt:check`：通过。
- `bun run lint`：0 errors；保留 728 项上游 warning，本次新增文件无 lint warning。
- `bun run typecheck`：7 个工作区任务通过。
- `bun run build:desktop`：4 个构建任务通过，产出 Electron、Web 和后端。
- `bun run --cwd packages/shared test src/desktopIdentity.test.ts`：19 项通过。
- `bun run windows-runtime:check`：269 个应用文件边界检查通过（并非 Windows 实机测试）。
- 默认构建版桌面已启动；本机后端 `/health` 返回 `status=ok`、`startupReady=true` 和健康 projection。
- 原热更新启动在本机报 `unable to start FSEvent stream`；已停止该进程组，默认启动切为构建版，`--dev` 保留为可选入口。
- 本机缺少 Xcode actool，因此上游 Liquid Glass 图标生成被跳过，沿用现有回退图标。
- 按用户规则未做前端测试、浏览器/截图 QA；未启动真实模型任务、未验证移动端或完整继承功能。代码审阅仅确认所列 4 项修正，不能当作整页视觉验收。

日志保存在 `/Users/neo/output/agent-desktop-comparison-20260923/workbench-*.log`。状态数据库位于本项目 `.agent-workbench/userdata`。上游的默认 Chat/Studio 文档目录仍沿用 `~/Documents/Synara`；选择已有项目时使用其目录，尚未做全面品牌与默认文档目录迁移。

## 手机与连接迭代 · 2026-09-23

- fmt:check、lint、typecheck、build:desktop 全部通过；lint 0 errors / 728 继承 warnings；typecheck 7 tasks，build 4 tasks。
- 后端完整 auth 目录 + authEffectRoute + config/effectServer remoteAccess + trustedOrigins：11 files / 70 tests 通过。
- shared workbenchRemote：7 tests 通过。拒绝不安全 origin；凭据只放 URL fragment。
- Windows runtime boundary：269 source files 通过；没有 Windows 实机验证。
- 构建后临时工作区 HTTP 联通检查通过：owner bootstrap → client pairing → 重放拒绝 → client 管理请求403 → desktop CORS → revoke → session失效 → untrusted Origin403。临时数据已清理，未创建模型任务。
- 当前桌面已重启：launcher78725，backend78842，回环端口56404（重启可变）。health status=ok/startupReady=true。确认两条既有记录均无活动任务/待处理授权后重启，数据保留。
- 新桌面真实 HTTP bearer bootstrap/session/client-list/CORS 验证通过；临时验证会话已 logout。
- workbench:remote -- --dry-run 拒绝缺失配置：本机未安装 cloudflared，未提供 URL/tunnel token。没有真实公网隧道；connector 启停/跨网/手机浏览器未验收。
- UI 源码审阅：手机稿焦点/44px两项修正、连接设置加载状态/认证恢复/读屏倒计时/作废提示修正确认。无前端测试、浏览器、截图或视觉验收。

日志：/Users/neo/output/agent-desktop-comparison-20260923/remote-\*.log。凭据不写入记忆或此报告；开发日志不直接输出全文。

## Metis 命名与共享服务 · 2026-09-23

- 用户确定产品名 Metis。应用标题、首页、开发桌面显示名和文档已更新；数据目录、profile、协议与原生 CLI 配置保留兼容。正式 Logo 仍待用户从候选中选择。
- fmt:check / typecheck / build:desktop 通过；lint 0 errors / 728 继承 warnings。Windows runtime 静态边界检查通过。
- 12 启动配置/凭据隔离测试、77 后端认证/远程策略/数据库锁测试、26 shared 身份/URL 测试，共 115 项通过。无前端测试。
- 临时目录运行构建版共享服务：本机 owner 配对、单次使用、client 无管理权限、拒绝不可信 Origin、拒绝并行数据库 owner、重启后保留两类设备会话、设备撤销后失效均通过。未发起模型任务，验证目录与进程已清理。
- `metis:serve` 和 `metis:remote` 默认使用现有 `.agent-workbench`，不复制数据库；旧远程目录通过 `--isolated` 访问。当时完整 Electron 与常驻服务的同时接入尚未实现；后续已补齐，见下方最新记录。
- 确认 3 条既有会话均无活动执行后，已重启为 Metis.app；launcher10960 / desktop11375 / backend11422 / port56376，health ok/startupReady=true，重启前后仍有 3 条会话。进程/端口后续重启可变。
- 第一轮 10 个 AI Logo 已保存并展示在 `docs/metis-logo-options/index.html`，源码/语法/相对引用与原图 SHA-256 校验完成；未浏览器 QA 或截图。用户随后要求的第二轮 10 个立方体方向也已完成：`docs/metis-cube-logo-options/index.html`，10 张独立原图 alpha 范围均为 0–255，文件哈希与来源一致。两轮 HTML 均已打开供挑选，正式图标未替换。
- 尚未配置真实公网入口、连接手机或验证原生移动端。未发布签名安装包。

证据 `/Users/neo/output/metis-20260923/`。桌面日志为私有文件，不输出凭据。

## 蔚蓝 Logo 与白底桌面图标 · 2026-09-23

- 用户采用「三面折叠 · 蔚蓝」，随后根据 Dock 截图要求白底、居中。应用内保留透明蓝色原图，Dock/Finder 使用 ImageGen 编辑的白色圆角方底版；生成图片与提示词见 [品牌记录](branding.md)。
- fmt:check / typecheck / build:desktop 通过，lint 0 errors / 728 继承 warnings。原生图标相关 2 files / 11 tests 通过；Windows 静态边界 269 files 通过。无前端测试、浏览器或 Dock 截图 QA；只检查生成素材、源码及运行资源。
- 构建后的网页与服务端两份素材哈希均与源文件一致，实际 HTTP 返回透明 Logo 和白底图标的字节也匹配。
- 本地已重启至白底版：launcher45322 / desktop45743 / backend45760 / port64797（进程与端口后续可变），health ok / startupReady=true。
- 自有 Metis.app 的 Finder 自定义图标标志已写入，应用签名 CDHash 和 launcher metadata 哈希保持不变，没有重签或重置 TCC。只允许自有源码 launcher 和打包应用写图标元数据，保留共享 Electron 的保护。
- 没有发布安装包、开启公网或修改 Dagent/Fleet；Windows/Linux 原生发布图标迁移不在本次范围内。

检查与运行证据：`/Users/neo/output/metis-20260923/blue-adoption.json`、`blue-*.log`。

## 共享后台接入真实桌面 · 2026-09-23

- 新增原生共享服务接入：识别同一私有数据目录中的存活服务，沿用现有 owner/client 配对与 cookie 会话，不另启后端。导航限制在配置的 origin，退出桌面不拥有共享后台的停止权限。首次有效私有 owner 链接可自动配对，已有会话不静默重新授权。
- fmt:check / lint / typecheck / build:desktop 通过；lint 0 errors / 728 继承 warnings，typecheck 7 tasks，build 4 tasks；Windows runtime 静态检查通过。桌面完整原生测试 103 files / 1222 tests 通过、6 skipped；独立 launcher node:test 也通过。没有前端测试或浏览器 QA。
- HTTPS 公网入口已配置，health200 / startupReady=true；共享服务 launcher80783 / backend80784，Electron80884 已打开。用户随后提供原生 AppSnap 欢迎弹窗截图，指出其中旧品牌标题；未将其当作手机跨网或所有继承功能验收。
- 共享模式 Windows ACL、后端调用桌面 browser/computer host 的桥接仍未完成；Mac 必须在线。未发布签名安装包。

## 当前产品标题统一 · 2026-09-23

- AppSnap 欢迎弹窗标题改用 APP_BASE_NAME（Metis）；设置、引导、导入、原生错误/恢复对话框等当前产品名称同步。上游历史和署名保留。
- fmt:check / lint / typecheck / build:desktop 通过；lint 0 errors / 728 继承 warnings。75 项受影响原生测试通过。无前端测试、浏览器自动化或视觉 QA。
- 已构建并重开 Metis：launcher89011 / desktop89739；同一共享 backend80784 保持健康。HTTP 返回新资源，AppSnap 标题模板存在，旧标题不存在。
- 旧桌面 SIGTERM 后窗口/renderer 已退出，主进程仍残留；确认仅有 Electron helpers、无后端/provider 子进程后单独结束客户端再重开。共享后台未重启。原生退出残留仍需后续排查，本次不宣称优雅退出验收通过。
