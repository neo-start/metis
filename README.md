# Metis

整合 T3 Code 与 Synara 能力的本地 Agent 工作台，产品名已确定为 Metis，当前为独立开发版。

## 启动

需要 Node.js 24 与 npm。依赖安装后，在本目录运行：

```sh
npm run metis
```

macOS/Linux 默认先启动或连接持续运行的本机共享后台，再打开已构建的 Electron 桌面窗口；退出窗口不会停止任务。需要停止后台时，使用桌面菜单的停止后台操作，或 `npm run metis -- --stop-background`。源码变更后先运行下方 `build:desktop` 更新。可加 `--dev` 使用热更新（本机当前遇到 FSEvent 文件监听错误，默认采用构建版）。首次使用保留上游引导与授权流程；完成后从左侧「工作台」进入统一首页。启动器通过 npm 获取固定版本 Bun，不修改全局工具安装。

只运行热更新网页版时，先停止共享后台和桌面开发进程，再运行：

```sh
node scripts/workbench.mjs --web
```

浏览器入口为 http://127.0.0.1:5843/workbench，网页版后端端口为 4783。默认桌面连接 `http://127.0.0.1:4785` 的共享后台；`--dev` 模式仍由 Electron 管理开发后端，不能把 Vite 地址直接当成已认证的网页客户端。

热更新开发模式与默认共享后台共用本项目的 `.agent-workbench/` 数据目录，不能同时拥有该目录。桌面开发配置另存于 `agent-workbench-dev`，不会复用已安装 Synara 的配置。按 Ctrl+C 结束当前开发进程。启动前可加 `--dry-run` 查看目录与端口。

### 持续运行的共享服务

默认桌面启动后共享后台已在运行。需要独立启动前台服务时，先停止已有后台，再运行 `npm run metis:serve`，使用同一份现有会话数据，在电脑浏览器访问 `http://127.0.0.1:4785`。首次管理员配对链接写入 `.agent-workbench/owner-pairing-url.txt`，5 分钟有效，只可使用一次。关闭浏览器页面不会停止服务；终端中 Ctrl+C 才会结束前台服务。

配置自己的 HTTPS 域名和 Cloudflare Tunnel 后，改用 `npm run metis:remote`，电脑与已配对手机连接同一个后端。两个命令默认使用桌面现有 `.agent-workbench/` 数据；之前独立远程目录可用 `-- --isolated` 打开。数据库锁阻止同时启动两个后端，不复制或重置会话。

共享服务启动后，再运行 `npm run metis` 即可打开 Electron 桌面窗口。macOS/Linux 桌面会识别同一数据目录中的运行服务，使用已有 HTTPS 入口（本机服务使用回环入口）；退出桌面不会关闭共享后台或手机连接。桌面保留独立登录会话：首次启动可使用尚未消费且未过期的本机管理员配对链接，之后由 Electron profile 记住登录。共享后台可连接桌面提供的浏览器和电脑控制 host；这类工具依赖桌面在线。Windows 共享后台支持仍待接入。

旧 `workbench` 命令与数据目录保留兼容；改名不会迁移原会话或原生 CLI 账号。

任务管理入口见 [Agent 任务管理](docs/workbench/agent-task-management.md)。

## 当前实现

- 直接以 Synara 源码为底座，沿用 Agent 适配、会话、历史导入、权限确认、工作区、交接、自动化、Studio 等现有实现。
- 新增连接真实项目和会话状态的工作台首页，集中展示最近任务、Agent 状态和常用入口。
- 直接移植 T3 的会话排序和搜索高亮代码；排序适配本工作台的最近执行与编辑时间。
- 独立的本地数据、桌面开发身份和启动命令。
- 「手机与远程连接」设置页接入一次性配对、设备列表和撤销接口；本地/远程共享服务默认复用桌面数据，可在浏览器关闭后继续工作。

T3 原生移动端与完整云端控制服务尚未接入，也未逐项验证所有继承能力或进行真实 Agent 任务验收。共享后台仍运行在本机，公网入口需自行配置；没有发布签名安装包。完整范围和迭代状态见 [开发说明](docs/workbench/implementation.md)。

手机与隧道配置见 [远程连接说明](docs/workbench/remote-access.md)；[手机交互稿](docs/workbench/mobile-preview/index.html) 为示例数据，未连接服务。

## Logo

当前采用 **三面折叠 · 蔚蓝**（用户于 2026-09-23 选择）。原图用于应用内 Logo、启动页和网页图标；本机 macOS 开发版默认 Dock/Finder 图标采用用户要求的白色圆角底板、居中 Logo。按钮主题色沿用现有系统。素材来源、接入范围见 [品牌记录](docs/workbench/branding.md)。

保留 [配色对比](docs/metis-logo-colors/index.html) · [第一轮 10 个方向](docs/metis-logo-options/index.html) · [第二轮 10 个立方体方向](docs/metis-cube-logo-options/index.html)。

## 源码复用

优先复用两个上游的成熟实现，再补必要适配。以 Synara 的数据模型和执行核心作为当前主干；T3 的模块逐项核对协议、状态与依赖后移植，避免维护两套互不相通的任务记录。

- Synara 上游 remote：`upstream-synara`。
- T3 参考源码：`.upstream/t3code/`，不参与构建，不提交嵌套仓库。
- 版本锚点：[upstream.json](docs/workbench/upstream.json)。
- 文件来源与改动：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 原 Synara 文档：[UPSTREAM_README.md](docs/workbench/UPSTREAM_README.md)。

保留原 MIT 许可证及版权信息。保留 `@synara/*` 包名和协议标识以减少无关改动。

## 开发检查

```sh
npm exec --yes --package=bun@1.4.2 -- bun install --frozen-lockfile
npm exec --yes --package=bun@1.4.2 -- bun run fmt:check
npm exec --yes --package=bun@1.4.2 -- bun run lint
npm exec --yes --package=bun@1.4.2 -- bun run typecheck
npm exec --yes --package=bun@1.4.2 -- bun run build:desktop
```

按用户约定，不自行添加或执行前端测试、浏览器 QA；非前端的隔离与运行边界检查按改动执行。
