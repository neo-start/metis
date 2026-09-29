# Metis 三面折叠：配色候选

用户已喜欢第二轮立方体 02「三面折叠」，希望换色。此页比较 4 个新配色与原版绿色。用户于 2026-09-23 选择「先用蔚蓝」，现作为当前应用标识；接入范围见 [品牌记录](../workbench/branding.md)。

直接打开 [index.html](index.html)。复用上一轮本地展示页，支持浅/深/网格背景、小尺寸、放大、下载与收藏编号；收藏采用独立key。

01 蔚蓝、02 鸢尾紫、03 日光橙、04 石墨灰。所有新图使用内置 `image_gen.imagegen` 编辑源图 `../metis-cube-logo-options/images/02-folded-cube.png`；prompt要求只换色并保持几何、比例、圆角与透明背景。不使用CSS滤镜、程序上色或图像后处理。完整提示词与来源见 [generation.json](generation.json)。

源绿色文件为逐字节复制，保存在 images/00-original-green.png 供对照。验证仅限生成图片本身、源码/语法/引用与格式，未浏览器QA或截图。
