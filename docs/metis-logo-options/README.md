# Metis Logo 候选

直接打开 [index.html](index.html) 即可，无需构建、服务或网络。

- 10 个方向分别由内置 `image_gen.imagegen` 生成，使用独立提示词；没有以 CSS/SVG 替代生成图像。
- 所有交付图像为工具原始输出的 1254 × 1254 RGBA PNG，逐字节复制到 `images/`，没有图片后处理；原始文件保留。
- [generation.json](generation.json) 包含完整提示词、生成方式、原始路径、输出尺寸与 SHA-256。
- 页面支持浅色／深色／透明网格背景、24／32／48 CSS px 画布预览、放大与键盘左右切换、原图下载、收藏及复制候选。收藏仅保存在当前浏览器；若本地文件模式不允许剪贴板访问，会显示可手动复制的文字。
- 当前均为候选，未替换正式应用图标。预览字标只展示搭配比例。透明原图保留生成器的留白，图形本体小于标注画布尺寸。
- 独立静态页面未移植 React 应用组件；读取了现有移动预览与品牌导出实现，沿用中性控件与交互原则，无新增第三方前端依赖。
- 验证限于文件、来源哈希、JavaScript 语法、格式与相对链接。遵从用户限制，未运行前端测试、浏览器自动化、截图或视觉 QA。

| 编号 | 方向                     | PNG                                    |
| ---- | ------------------------ | -------------------------------------- |
| 01   | 折光 M / Folded M        | [原图](images/01-folded-m.png)         |
| 02   | 解题之线 / Thread Path   | [原图](images/02-thread-path.png)      |
| 03   | 智流汇合 / Confluence    | [原图](images/03-agent-confluence.png) |
| 04   | 洞见之火 / Insight Flame | [原图](images/04-insight-flame.png)    |
| 05   | 谋略之盾 / Metis Shield  | [原图](images/05-metis-shield.png)     |
| 06   | 星图节点 / North Star    | [原图](images/06-north-star.png)       |
| 07   | 思维折页 / Thought Fold  | [原图](images/07-thought-fold.png)     |
| 08   | 智慧之种 / Wisdom Seed   | [原图](images/08-wisdom-seed.png)      |
| 09   | 智慧印记 / Greek Imprint | [原图](images/09-greek-imprint.png)    |
| 10   | 无缝接续 / Continuity    | [原图](images/10-continuous-orbit.png) |

生成日期：2026-09-23。
