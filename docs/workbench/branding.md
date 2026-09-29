# Metis 品牌标识

2026-09-23 用户选择第二轮立方体 02「三面折叠」，再从配色探索中确定「先用蔚蓝」。这是当前采用方案，可继续迭代。

- 原图：[三面折叠 · 蔚蓝](../metis-logo-colors/images/01-blue.png)，1254 × 1254 透明 PNG。
- 来源：内置 ImageGen 以绿色原图为编辑目标，仅探索颜色；完整提示词及来源记录在 [generation.json](../metis-logo-colors/generation.json)。应用内 Logo 沿用这张原图。
- 原图 SHA-256：`a8d374d5dba03fef9cc094ec78f71f68db5b169a58e40bafe8ae651083bf0f4b`。
- 网页 Logo：`apps/web/public/metis-logo-blue.png`，为原图逐字节复制。应用内沿用 `SynaraLogo` 组件的 SVG props 接口，内部引用原 PNG；启动页、网页 favicon、工作台标题统一使用这个标识。
- 桌面图标：用户看到透明 Logo 在 Dock 上的效果后，明确要求白底、居中。以蔚蓝原图为编辑目标，通过内置 ImageGen 添加白色圆角方底，保留中央三角留白。素材是 `apps/desktop/resources/metis-app-icon-blue.png`，网页副本为 `apps/web/public/metis-app-icon-blue.png`，用于 Apple touch icon 和 macOS 默认图标预览。编辑提示词与来源见 [app-icon-generation.json](app-icon-generation.json)。
- 本机 macOS 开发版的默认 Dock 图标使用白底 PNG，Finder 图标复用既有 NSWorkspace 持久化机制，写入签名包外的自定义图标元数据；不会为换图标重新签名或重置隐私权限。只允许已打包应用或当前源码目录下本项目自有 Metis.app 接收该元数据，不修改共享 Electron 程序。原有用户自选图标选项保留。
- 包、协议、数据库及 profile 名称不改；主题的 primary / focus / status 色不随 Logo 改色。

本次范围为当前本地开发应用；Windows/Linux 原生图标、正式安装包、Icon Composer 与发布品牌身份仍沿用上游配置，未宣称完成发布品牌迁移。保留上游 MIT 许可和作者署名。

## 界面标题统一 · 2026-09-23

用户根据 AppSnap 欢迎弹窗截图要求相关 title 都改为 Metis。已统一 AppSnap 欢迎、设置与权限说明、引导和导入、技能/MCP 设置、内置浏览器、个人卡片、配对与退出页面及原生恢复/错误弹窗中的当前产品显示名称。AppSnap 标题使用既有 APP_BASE_NAME。历史更新日志、上游署名、协议/包名、数据目录及 profile 标识保留；反馈入口仍如实注明发送到上游 Synara 团队。未修改交互或样式。
