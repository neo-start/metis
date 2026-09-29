# Metis · 立方体 Logo 候选

打开 [index.html](index.html) 查看本轮 10 个立方体方向，直接打开本地文件即可，无需服务、构建或网络。[上一轮方案](../metis-logo-options/index.html) 保留。

- 10 张图像分别使用内置 `image_gen.imagegen` 独立生成，每个方向使用不同结构提示词，没有用 CSS 或 SVG 代替真实生成。
- 所有交付图像均为工具原始输出的 1254 × 1254 RGBA PNG，逐字节复制到 `images/`，未进行图片后处理；原始文件仍在生成目录。
- 只读解码确认每张 PNG 的 alpha 最小值为 0、最大值为 255，均含完全透明与完全不透明像素。
- [generation.json](generation.json) 记录完整提示词、生成方式、原始路径、尺寸、SHA-256 和透明通道统计。
- 展示页复用上一轮独立 HTML/CSS/JS，支持浅色／深色／透明网格、24／32／48 CSS px 画布预览、放大和键盘左右切换、原图下载、收藏与复制编号。本轮收藏使用独立 localStorage key。
- 复制候选时会明确标识“Metis 立方体 Logo 候选”；本地文件权限不允许剪贴板访问时显示可手动复制的文字。
- 均为探索候选，未替换正式图标。小尺寸保留生成器原始留白；字标搭配只供比较比例。
- 验证限于来源哈希、PNG 数据、相对引用、JavaScript 语法、格式和静态 lint；未运行前端测试、浏览器自动化、截图或页面视觉 QA。

| 编号 | 方向                           | PNG                                       |
| ---- | ------------------------------ | ----------------------------------------- |
| 01   | 负形 M 立方 / M Core           | [原图](images/01-negative-m-cube.png)     |
| 02   | 三面折叠 / Folded Volume       | [原图](images/02-folded-cube.png)         |
| 03   | 空心框架 / Open Frame          | [原图](images/03-open-cube-frame.png)     |
| 04   | 三元协作 / Agent Assembly      | [原图](images/04-three-agent-cube.png)    |
| 05   | 一线成方 / One Continuous Line | [原图](images/05-single-line-cube.png)    |
| 06   | 内外同频 / Nested Cubes        | [原图](images/06-nested-cubes.png)        |
| 07   | 切角洞见 / Corner Insight      | [原图](images/07-corner-cut-cube.png)     |
| 08   | 步进方块 / Stepped Logic       | [原图](images/08-stepped-voxel.png)       |
| 09   | 穿行立方 / Woven Space         | [原图](images/09-woven-cube-path.png)     |
| 10   | 悬浮三面 / Floating Faces      | [原图](images/10-floating-cube-faces.png) |

生成日期：2026-09-23。
