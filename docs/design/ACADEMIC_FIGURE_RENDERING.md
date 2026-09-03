# 学术内容本地渲染能力设计 — Mermaid / LaTeX 公式 → PNG/SVG → docx/pdf 嵌图

**Status:** Design proposal v1（2026-09-02）
**关联:** `docs/design/RENDER_BOUNDARY.md`（渲染边界铁律）、`docs/design/FIGURE_STATS_WORKBENCH.md`（执行层插件三件套）、#811（图库域分离）、#775（PPT 导出）
**动机:** 专利/论文写作场景需要把 AI 生成或用户编写的 mermaid 图、LaTeX 公式渲染为位图并嵌入导出文档；渲染必须**本地完成、零外呼**（自托管数据不出境）。

---

## 1. 目标与非目标

**目标**
1. 写作文档/聊天中出现的 ```mermaid 围栏与 LaTeX 公式（`$...$` 行内、`$$...$$` 块级）可被渲染为图像
2. 导出 docx / pdf / pptx 时自动嵌入渲染结果（中文字形正确、清晰度 ≥150dpi 等效）
3. 渲染产物进入 #811 图库（预览/溯源/重下载/重渲染），与知识库文件域隔离
4. 前端所见即所得预览（离线渲染，不依赖服务端往返）
5. 全程本地：渲染器与字体全部打包在 worker 容器/web 前端包内，运行期无任何外部请求

**非目标（本期）**
- TikZ/chemfig 等完整 LaTeX 工具链（Phase 3，见 §8）
- PlantUML（需 JVM，暂不引入）
- 数学公式的 docx 原生 OMML 对象（用 PNG 嵌入替代，Phase 3 可选增强）

## 2. 渲染矩阵

| 类型 | 输入 | 渲染引擎 | 产物 | 嵌入形态 |
|---|---|---|---|---|
| mermaid 图 | ```mermaid 围栏 | mermaid ESM（本地 bundle）@ headless Chromium | SVG | 导出时 sharp→PNG |
| LaTeX 公式 | `$..$` / `$$..$$` | MathJax v3 tex-svg（本地 bundle）@ headless Chromium | SVG | 导出时 sharp→PNG |
| 既有 chart/scene SVG | render_chart/BioScene | server-ts 确定性内联（现状不变） | SVG | 导出时 sharp→PNG（现状） |
| TikZ 等（Phase 3） | latex 围栏 | texlive + dvisvgm（worker 外部进程，仿 preview.ts soffice 模式） | SVG | 同上 |

**关键决策 A — 单一 headless Chromium + 本地 HTML shell：**
mermaid 依赖 DOM 必须浏览器；统一用一个 shell 页面（`file://` 加载本地打包的 mermaid + MathJax，禁网络）承接所有 JS 类渲染，安全策略一处收口。备选"mathjax-full 纯 Node 出 SVG（免浏览器）"作为 shell 不可用时的降级路径，不作为主路径。

**关键决策 B — 产物以 SVG 为准、按需光栅化：**
渲染器产出 SVG（无限清晰、可重光栅化）；导出侧复用现有 sharp 光栅化先例（`asset-embed.ts` #fix 2026-09 的 density 150 教训：**SVG 字节绝不能按位图扩展名直嵌**）。web 预览直接 `<img>` 加载 SVG（SmartImg 现有模式）。

## 3. 架构与数据流

```
┌─ 控制面 server-ts ──────────────────────────────────────────────┐
│ figure.service                                                  │
│  ensureFigure(userId, {kind, source, options})                  │
│   1. sha256(kind+source+options) → FigureRender 表查缓存        │
│   2. miss → execution-plane enqueue sidecar.render_figure       │
│      → pollRenderJob（复用 asset-render-pipeline 模式）          │
│   3. fetchFile → 落盘 {TWIN_BASE_DIR}/{userId}/uploads/          │
│      fig_{kind}_{hash8}_{ts}.svg + FileIndex upsert(sha256)     │
│      + FigureRender 记录(源码留存=溯源/重渲染)                    │
│   4. 返回 { fileId, url=issueChartToken, width, height }        │
│                                                                 │
│ 消费方:                                                          │
│  · markdown-export.ts（管线 A，写作导出 docx/pdf）               │
│  · asset-embed.ts（管线 B，insert_asset 导出 docx/pptx/pdf）     │
│  · documents.service 保存钩子 → 预渲染预热（fire-and-forget）     │
└──────────────┬──────────────────────────────────────────────────┘
               │ POST /api/v1/execution/jobs（HTTP，#444 后无 Redis）
┌─ 执行面 worker ─▼───────────────────────────────────────────────┐
│ sidecar.render_figure handler                                   │
│  zod 入参校验 → page pool（≤ WORKER_MAX_CONCURRENT）             │
│  → shell.html(file://, 本地 mermaid+MathJax bundle)             │
│  → evaluate 渲染 → 提取 SVG 字符串 → saveFile → manifest/S3 双写 │
│  安全: securityLevel=strict · 禁 htmlLabels · 请求拦截仅本地      │
│       源码 ≤32KB · 单图超时 10s · 每 N job 回收 browser 进程      │
└─────────────────────────────────────────────────────────────────┘
```

## 4. 各层改动清单（对照现有代码）

### 4.1 contracts（packages/contracts）
- `renderJobType` 枚举（src/index.ts:129 单一来源）新增 `sidecar.render_figure`
- 新增 zod schema：`{ kind: 'mermaid'|'latex_math', source: string(≤32KB), display?: 'inline'|'block', theme?: string, scale?: number }`，出参 `{ svg: string, width, height, warnings?: string[] }`

### 4.2 worker（packages/worker）
- 新 handler `src/handlers/figure.ts`，注册进 `server.ts` HANDLERS 穷举 Record；沿用 `job-runner.ts`（有界并发/PersistentJobStore/recoverInterrupted/callback_url）
- `assets/shell.html` + 本地 bundle（mermaid ESM、MathJax tex-svg 字体打包进容器镜像）
- puppeteer-core + 容器内 Chromium（Dockerfile 增 `chromium` 与中文字体——已有 fonts-noto-cjk ✓）
- 失败语义：渲染失败返回结构化错误（含 mermaid/MathJax 的解析错误位置），不崩溃进程（对齐 PREVIEW_UNAVAILABLE 降级风格）

### 4.3 server-ts 控制面
- 新 `modules/figures/figure.service.ts`（ensureFigure/批量 ensureFigures/重渲染）
- 新 Prisma model `FigureRender`：`{ id, userId, kind, source, optionsJson, sha256, svgFileId, width, height, renderedMs, createdAt }`，`@@unique([userId, sha256])`——源码留存在库，支撑图库"溯源/重渲染"（现有"目录扫描+event 反查"模式做不到，这是 #811 验收的加强）
- 图库域分离收口三处：`files.service.ts isGeneratedFileId` 增 `^fig_`；`chart-library.service.ts` detectMode 增 fig_ 分支（读 FigureRender 元数据替代 event 反查）；知识库列表排除正则（files.router.ts:160/211）
- 下载沿用 chart-token（HMAC 自愈重签，SmartImg 兼容）

### 4.4 web 前端
- `MarkdownRenderer.tsx` code 组件拦截：`mermaid` 围栏 → 客户端 mermaid 渲染（lazy chunk 离线渲染；失败降级 SmartImg 指向 figure API）
- 数学：`$..$`/`$$..$$` 经 remark-math + rehype-katex（**katex 已在 packages/web 依赖**，补 remark/rehype 两个小包），字体本地打包
- 图库 UI（ChartLibrary.tsx / knowledge.tsx / writing.tsx）：fig_ 类型支持查看源码、一键重渲染、复制 md
- 写作编辑器：插入公式/图表入口（可选，P2）

### 4.5 导出接入
- **管线 A**（`documents/markdown-export.ts`）：`parseMarkdownBlocks` 新增 `figure` 块类型（```mermaid 围栏；math 块由文本预处理抽取）→ `ensureFigure` → 走现有 `loadExportImage` 路径（SVG→sharp→ImageRun/doc.image）。同步端点对未命中缓存的图给 **15s 预算**，超时降级为原 code block 文本（不阻塞导出）
- **预渲染预热**：`documents.service` 保存钩子扫描围栏/公式 → fire-and-forget ensureFigure。导出时基本全命中缓存
- **管线 B**（`asset-embed.ts`）：fence/公式 → image block 前先 ensureFigure（worker 渲染后在控制面统一 base64，与现状同构）
- **顺带修复**：`plot_*.png`（SVG 字节存 png 名）假扩展 bug —— 统一走"SVG 产物 + 如实扩展名 + 导出时光栅化"

## 5. 安全与资源约束

| 风险 | 对策 |
|---|---|
| mermaid/MathJax 源码注入（XSS in shell） | securityLevel=strict、禁 htmlLabels、MathJax safe 配置；shell 禁网络（request interception 仅 file://） |
| 资源耗尽（超大图/死循环动画） | 源码 ≤32KB、单图 10s 超时杀 page、SVG 尺寸上限（viewport 裁剪）、browser 进程每 50 job 回收 |
| worker 并发争用 | 复用 WORKER_MAX_CONCURRENT 有界并发；page pool 同上限 |
| 图源码泄漏 | FigureRender 按userId 隔离；下载走 chart-token |
| 版权/字体 | 全容器内字体（Noto CJK 已有）；MathJax SVG 内嵌字体路径，无外呼 |

## 6. 缓存与去重

- 命中键：`sha256(kind + '\n' + source + '\n' + canonical(options))`
- 三级：FigureRender 表（持久，跨文档跨会话）→ FileIndex sha256 去重（同内容落盘唯一）→ 前端客户端渲染（预览零往返）
- 重渲染（主题/密度变化）：同 source 新 options = 新 sha256 新产物，旧产物保留（版本不覆盖，对齐图库"重下载"语义）

## 7. 测试与验收

- worker 单测：mermaid/公式 golden SVG 快照；错误源码返回结构化错误；超时/超限拒绝
- 控制面单测：sha256 缓存命中不重复 enqueue；fig_ 三处域分离收口（图库可见/知识库不可见）；chart-token 下载
- 导出 e2e：含中文 mermaid + 行内/块级公式的文档 → docx/pdf 导出 → 断言图片嵌入数与扩展名如实；管线 B pptx 同验
- 安全用例：`<script>` 注入源码、外链图片 url、64KB 源码均被拒/净化
- 性能：10 图文档二次导出 <3s（全缓存命中）；冷渲染单图 <5s（mermaid）/ <2s（公式）

## 8. 分期

- **P1 核心闭环**：contracts+容器依赖 → worker 渲染器 → figure.service+图库域 → 管线 A/B 导出接入 + 保存预热
- **P2 体验**：前端 mermaid/KaTeX 预览、图库源码查看/重渲染 UI、plot 假扩展修复、PPT deck 内嵌
- **P3 扩展**：TikZ/chemfig（texlive+dvisvgm 外部进程，仿 preview.ts）、docx 原生 OMML 公式、PlantUML 评估

## 9. 备选方案记录（否决理由）

| 备选 | 否决理由 |
|---|---|
| @mermaid-js/mermaid-cli (mmdc) 独立进程 | 自带 puppeteer 全家桶难控版本；无法与 MathJax 共享浏览器；错误处理黑盒 |
| mathjax-full 纯 Node SVG 为主路径 | 可行但形成"公式一条路、图一条路"两套安全/超时/缓存收口；留作降级 |
| 前端渲染后回传 PNG | 主依赖浏览器能力、移动端不稳；导出质量不可控；仅作预览用途 |
| 在 server-ts 进程内起 puppeteer | 违反 RENDER_BOUNDARY 铁律；控制面内存/崩溃域被污染 |
