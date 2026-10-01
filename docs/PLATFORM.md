# Heurion 2.0 平台架构

**Status:** v0.2（2026-10-01）· P0 已实现（`apps/platform`）· **跟踪:** epic [#16](https://github.com/0xaicrypto/heurion2/issues/16) · **决策人:** JZ
**关系:** 本文是 v0.4 起的唯一架构。[DESIGN.md](DESIGN.md) 描述的 S 系列路线（dsh 用 python 改文件 + Collabora 编辑面）已于 2026-10-01 停用，保留为决策记录。

## 目录

1. [定位与范围](#1-定位与范围)
2. [原则](#2-原则)
3. [总体架构](#3-总体架构)
4. [数据模型](#4-数据模型)
5. [统一编辑框架](#5-统一编辑框架)
6. [doc 内核](#6-doc-内核)
7. [deck 内核](#7-deck-内核)
8. [MCP 接口面](#8-mcp-接口面)
9. [前端](#9-前端)
10. [决策记录](#10-决策记录)
11. [风险](#11-风险)
12. [分期 P0–P3](#12-分期-p0p3)

---

## 1. 定位与范围

**平台 = 自建 doc/slides 编辑平台 + 面向 agent 的结构化文档通道。**

- 平台持有带稳定 id 的结构化文档模型，对外暴露两类面：给**人**的编辑器（P1 起实时协同），给 **AI** 的 MCP 工具（结构化读写，写前守卫）。
- docx 先行（P0–P1）；deck 内核 P2；多用户 / 容器隔离沿用 DESIGN.md 的 M2 里程碑。
- doc 与 deck **能力对齐不再是设计约束**：两种媒体用两个内核，共享同一套平台底座（操作层、守卫、评论、引用、版本、MCP 约定）。

## 2. 原则

1. **平台持有真相与 id。** 结构化模型是唯一真相；docx/pptx 文件是导入 / 导出视图。id 由平台分配，写在模型节点上，不依赖文件内属性在编辑器间存活。
2. **AI 对文档的一切写入走操作层。** dsh 经 MCP `doc_edit(ops)` → 写前守卫 → 原子应用。dsh 的 **shell 保留**，只用于计算类任务（统计、作图、数字数、读资料）；文档不在工作区里，也没有任何「用文件写回文档」的入口，所以模型在结构上绕不过操作层。shell 产出的图经 `asset_upload` 进入平台。
3. **用户优先。** AI 的写入不能覆盖 `base_rev` 之后用户改过的块（`conflict_user_edited`）；用户的写入不受 AI 守卫阻挡。P0 的用户写入经 REST 进入同一操作层（actor=user）；P1 起改为编辑器直连协同层（CRDT 更新流）。
4. **dsh 仍是执行层。** 对话循环、工具执行、LLM 调用、子代理、上下文压缩不变；「office 文件读写」从 dsh 职责中移出（文档模型与守卫是平台核心，dsh 的 office 技能给不了结构化 id、写前守卫与原子 ops）。
5. **产品规则保留：** 评论 = 带锚点的编辑指令、用户优先、引用规范（insert_citation 单通道）、可回滚。语义不变，实现位置迁移到操作层。
6. **自研 = 组合成熟件，不从零造。** doc 内核 ProseMirror 模型 + Yjs（P1 编辑器 Tiptap）；deck 内核 Univer slides（Apache-2.0）+ fork Casual Slides 的 pptx 导入层。

## 3. 总体架构

```
dsh 子进程（每用户一个；shell 仅计算；工具 = heurion MCP）
   │ MCP（Streamable HTTP，/mcp，用户级范围令牌）
   ▼
apps/platform（Node + Hono）
 ├─ mcp/        MCP 工具面（读视图 / doc_edit / 评论 / 文献 / 引用 / 资产）+ 回合登记
 ├─ ops/        操作层：zod 校验 → 写前守卫 → 内存应用（prosemirror-transform）→ 单个 Yjs 事务
 ├─ model/      schema、id、markdown 方言、锚点、Documents（每文档 Y.Doc，updateYFragment 最小差异写入）
 ├─ views/      读视图（outline / read / search / diff）与渲染（HTML、markdown 导出）
 ├─ convert/    docx 导入（保留原始 XML）/ docx 修补式导出
 ├─ turns/      回合：登记 → dsh 执行 → 每份改过的文档打版本
 ├─ harness/    dsh 进程池、profile patch、事件映射
 ├─ http/       REST + SSE（前端、文档变更推送）
 ├─ web/        P0 单页（预览、选区评论、对话、版本、引用）
 └─ store/      node:sqlite
```

| 组件 | S 系列（已停用） | 平台 | 变化 |
| --- | --- | --- | --- |
| 真相 | docx/pptx 文件（版本库） | 结构化模型（Yjs） | ⛳ 核心 |
| 寻址 | 文件内 id 载体（paraId / shape id） | 平台块 id（模型节点属性） | ⛳ 核心 |
| AI 编辑 | dsh python 直接改文件 | MCP `doc_edit(ops)` + 写前守卫 | ⛳ 核心 |
| 守卫 | 写后审计（漂移 / 存活率 / DOI） | 写前强制 | ⛳ 核心 |
| 合并 | 三方合并（写后） | 节点级冲突守卫（P0）+ CRDT 合并（P1） | ⛳ 核心 |
| 评论 | 文件内 comments.xml 同步 | 平台评论（锚 = 文本上的 comment mark），导出时写入 comments.xml | 迁移 |
| 编辑面 | Collabora iframe（WOPI） | P0 只读预览 + 选区评论；P1 Tiptap；P2 Univer | 迁移 |
| dsh 进程 | 每文档一个 | 每用户一个（一个会话可编辑多份文档） | 变化 |

## 4. 数据模型

`node:sqlite`（`apps/platform/src/store/db.ts`）：

```
docs(id, owner, title, kind doc|deck, rev, state BLOB)   -- state = Y.encodeStateAsUpdate
op_log(doc_id, rev, actor ai|user|system, turn_id, ops, affected)   -- 每次提交一行，只增
node_changes(doc_id, rev, node_id, actor, kind)          -- 节点级变更索引（冲突守卫）
versions(doc_id, seq, rev, source create|import|turn|user|restore, turn_id, note, state BLOB)
node_src(doc_id, node_id, xml)                           -- 导入时每个块的原始 OOXML（逐字节）
doc_packages(doc_id, kind, bytes)                        -- 导入的原始文件包（导出底座）
assets(id, owner, mime, name, bytes)                     -- 图片等资产
citations(id, doc_id, doi, pmid, formatted, url)         -- UNIQUE(doc_id, doi)
comments(id, doc_id, node_id, snippet, status, resolved_by) / comment_replies(…, role, text, turn_id)
turns(id, user_id, doc_id, message, status) / messages(doc_id, role, text, turn_id)
```

- **rev**：每次提交加一，模型读到的 rev 作为下一次写入的 `base_rev`。
- **版本**：回合结束（本回合改过的每份文档各一版）/ 手动保存 / 导入 / 回滚时打快照；与上一版 rev 相同则不重复打。回滚 = 把旧快照作为一次用户提交写回并打新版本（历史只增）。
- P1 起协同层的增量更新日志（ycommits）与 Y.UndoManager 用户级撤销随编辑器一起加入。

## 5. 统一编辑框架

### 5.1 身份：块 id 与锚点

- 可寻址节点（标题 / 段落 / 列表 / 列表项 / 表格 / 图 / 不可编辑块）的 `id` 是模型节点属性：4 位起的 base36 短 id，文档内唯一，导入或插入时由平台分配，之后不变。表格单元格按 (row, col) 寻址。
- 模型看到 / 使用的都是块 id（读视图里的 `{#id}` 前缀），不复述原文定位。
- **评论锚点** = 文本上的 `comment(thread)` mark（Yjs 里是文本格式属性，随编辑移动）；无文字的块（图、不可编辑块）锚在块 id 上。锚点只在被锚定的文字真的消失时丢失，而这正是锚点守卫拦截的情形。

### 5.2 写路径

| 路径 | 执行者 | 流程 |
| --- | --- | --- |
| ① 起草 / 修改 | dsh | `doc_outline` → `doc_read` → `doc_edit(ops)`（一批原子提交）→ 回合结束落版 |
| ② 用户编辑 | 用户 | P0：REST `POST /api/docs/:id/edit`（同一操作层，actor=user，不受守卫阻挡）；P1：Tiptap → CRDT 更新流 |
| ③ 评论驱动 | dsh | 评论触发回合 → `comments_list`（锚点所在块与文字）→ `doc_edit` → `comment_reply`；改过内容的线程留给用户关闭 |

### 5.3 守卫（写前强制，只对 AI）

每批操作在应用前后校验；任一失败 → 整批拒绝（原子性），返回 `{ code, message, op_index, hint, current }`：

| 守卫 | 规则 | 失败码 |
| --- | --- | --- |
| 冲突（用户优先） | 目标块在 `base_rev` 之后被用户改过 | `conflict_user_edited`（附当前内容与新 rev） |
| 引用 | 写入内容出现 DOI、PMID 或手写参考文献条目 | `citation_not_registered` |
| 引用 | `[@c:id]` 未在本文档登记 | `citation_unknown` |
| 锚点 | 本批操作会让 open 评论失去锚点，且线程未列入 `ack_comments` | `anchor_has_open_comments`（附线程与用户要求） |
| 结构 | 找不到块 / 原文 / 单元格，非法嵌套，编辑不可编辑块 | `node_not_found` / `text_not_found` / `ambiguous_match` / `cell_not_found` / `invalid_structure` / `node_not_editable` |
| 参数 | op 形状、markdown、`base_rev` | `invalid_markdown` / `invalid_base_rev` / zod 校验错误 |

- **为什么用 `base_rev` + 节点变更索引，而不是 `expectText`：** `expectText` 要求模型复述原文，「复述原文失配」正是 S 系列要消灭的失败来源；按 id + rev 判定冲突不依赖模型抄写，且冲突时直接返回当前内容，模型一次就能改对。
- **锚点跟随替换**（`replace_text`）：替换文字里原样包含被锚定的文字 → 锚点精确落回；被锚定的文字整体被改写 → 锚点跟到新文字；部分重叠且被改写 → 范围外的剩余文字继续承担锚点。实测把「保留原文再补充」这类常见改法从需要 ack 变成无感。
- **人类编辑不经硬守卫**：Yjs 更新在客户端已生效，服务端拒绝只能断开重连；P1 协同网关对人类编辑做事后检查（手写参考文献等），以提示呈现。

### 5.4 评论闭环

- 评论数据在 SQLite，锚点在模型里（comment mark）；读取时实时定位（`located` / 锚定块 / 当前文字）。
- 触发：前端「让 AI 处理」或「评论并让 AI 处理」→ 服务端组装提示 → 回合。@heurion 自动触发队列（水位去重、防自召唤）在 P1 随编辑器内评论一起接入。
- AI 回复写入线程（role 固定为 ai）；**本回合改过文档时 `comment_resolve` 被拒绝**（`user_confirms_changes`），只有判断无需修改并说明后 AI 才能关闭线程。
- 导出 docx 时 open 线程写为 `comments.xml`（Word 用户可见）。

### 5.5 引用规范

- `pubmed_search` → `insert_citation`（DOI 必须能在 Crossref 查到）→ 正文写返回的 `[@c:<cite_id>]`。
- 引用在模型里是行内原子节点 `citation(cite_id)`：编号按文中首次出现顺序计算，参考文献表由平台在预览 / 导出时生成；模型不能手写编号或参考文献表。
- 守卫在写入前拦截正文里的 DOI / PMID / 手写参考文献；不再需要回合后审计与自修。

## 6. doc 内核

| 件 | 选型 | 说明 |
| --- | --- | --- |
| 模型 | ProseMirror schema（`model/schema.ts`）+ Yjs | 标题 / 段落（样式名、对齐）/ 有序与无序列表（可嵌套）/ 表格（colspan、rowspan、表头）/ 图（资产）/ 不可编辑块 / 引用原子节点；mark：粗、斜、下划线、上下标、代码、链接、评论 |
| 写入 | prosemirror-transform 在内存应用 → `updateYFragment` 最小差异写入 Y.Doc | 未改动的节点在 Yjs 里保持原样（P1 编辑器同步的前提）；Node 中无 DOM 运行已验证 |
| 内容格式 | markdown 方言（`model/markdown.ts`） | CommonMark + GFM 表格 + `[@c:id]` + `![说明](asset:<id> "图注")` + `<sup>/<sub>/<u>/<br>`；读视图带 `{#id}` 前缀，写入时忽略 |
| 导入 | 自写 OOXML 解析（`convert/docx-import.ts`） | 标题（样式名 / outlineLvl / 中文「标题 N」）、列表（numbering.xml，相邻同类列表合并）、表格（gridSpan / vMerge）、格式、超链接、图片（入资产库）、修订（接受插入、丢弃删除）、内容控件、题注并回图；其余落为 opaque。每个顶层块保存**逐字节原文** |
| 导出 | 修补式（`convert/docx-export.ts`） | 以原始文件包为底座（样式、编号、关系、媒体、页面设置）；导入后**未改动的块原样写回**，改过 / 新增的块按模型生成；新建文档用内置模板（宋体 / Times New Roman、标题样式）。引用为上标 [n] + 参考文献表；open 评论写入 comments.xml；图片嵌入 |
| 撤销 | P0：版本回滚；P1：Y.UndoManager（按 origin 撤销整轮 AI 修改） | |

保真口径：**未改动的块逐字节保真**（3 份真实文档「导入 → 不改 → 导出」正文与原文件逐字节一致）；改动 / 新增的块按平台样式生成，花式 Word 特性（SmartArt、域代码、文本框）导入为 opaque 或注记，原样写回、不可编辑。不使用 mammoth（转 HTML 丢失原始 XML，无法修补式导出）与 docx npm 包（整份重新生成）。

## 7. deck 内核

**底座：Univer slides（`@univerjs/slides` + `slides-ui`，Apache-2.0）+ fork Casual Slides 的 pptx 导入层。**

- **内核**：Univer slides 供给画布、形状 / 文本编辑、命令管线（command/mutation + undo）。
- **I/O 层**：fork Casual Slides 的导入器（2493 行，68/87 保真探针）移植到 Node；**导出不用 PptxGenJS 整份重建**，沿用 doc 内核的修补式思路：未改动的形状与页原样写回，改过的形状只重写被改的部分。
- **fork 策略**：fork 分支补 Univer slides 的已知缺口（rev 跟踪、element mutations、table / chart / line 元素类型、facade）；每个补丁 = fork 内提交 + `pnpm patch` 产物 + 上游 PR。
- **过渡**：Collabora / WOPI 已于 2026-10-01 随 S 系列停用；P2 之前平台不支持 pptx。
- **MCP 面**：`slide_read`（页 / 形状树，含形状 id 与 pt 坐标）/ `deck_edit(ops)`（add_slide 按版式填占位符 / set_text / replace_text / set_xfrm / set_table / set_chart_data / set_image / set_notes / 增删排序）/ `layout_check`（溢出、重叠、越界）/ `slide_render`（P2 先用 LibreOffice 渲染，dsh 的 MCP 客户端支持把图片交给多模态模型）；守卫同 §5.3，按形状级判定。

## 8. MCP 接口面

dsh 经 `/mcp`（Streamable HTTP，无状态）访问；MCP server 名 `heurion`，模型看到的工具名为 `mcp__heurion__<tool>`。令牌按 `(用户, 文档集合, 权限, 过期时间, 用途=mcp)` 签发，一个会话可编辑该用户的多份文档；浏览器令牌与 MCP 令牌不通用。

### 8.1 工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `doc_list` | — | 可访问的文档 |
| `doc_create` | `title, markdown?` | `doc_id, rev`（初始内容同样受守卫约束） |
| `doc_outline` | `doc_id` | rev、标题树（块 id、各节块数与字数）、引用与评论数 |
| `doc_read` | `doc_id, section_id? / from_id..to_id? / cursor?` | 带 `{#id}` 前缀的 markdown，分页；末尾列出范围内的 open 评论 |
| `doc_search` | `doc_id, query` | 命中块 id 与片段 |
| `doc_edit` | `doc_id, base_rev, ops[], ack_comments?, mode?` | 新 rev、逐 op 结果（新增 / 受影响 id）；整批原子 |
| `doc_history` / `doc_diff` | `doc_id` / `from_version, to_version?` | 版本列表 / 块级变化 |
| `comments_list` / `comment_reply` / `comment_resolve` | `doc_id, …` | 线程与锚点 / 回复（role=ai）/ 关闭（规则见 §5.4） |
| `pubmed_search` / `doi_lookup` | 检索式 / DOI | 文献元数据 |
| `insert_citation` / `list_citations` | `doc_id, doi` / `doc_id` | `cite_id` 与 `[@c:id]` 标记 / 登记表与文中编号 |
| `asset_upload` | 工作区内相对路径 | `asset_id`（png/jpg/svg/gif/webp ≤ 10MB；路径限制在工作区内） |

### 8.2 doc_edit 操作

| op | 参数 | 说明 |
| --- | --- | --- |
| `insert_after` / `insert_before` | `anchor_id, markdown` | 插入一个或多个块；锚点是列表项时插入列表项 |
| `replace_block` | `id, markdown` | 整块替换，第一个块沿用原 id 与段落样式 |
| `replace_text` | `id, find, replace, occurrence?` | 块内替换，**小改动首选**：继承原格式、锚点跟随；find 容忍 markdown 转义与强调符号 |
| `delete` | `ids` | 删除最后一个块时留空段落 |
| `move` | `ids, after`（null = 文档开头） | |
| `set_block_style` | `id, type?, level?, align?, style?` | 段落 ↔ 标题、级别、对齐、Word 样式名 |
| `table_set_cells` / `table_insert_rows` / `table_delete_rows` | `id, …` | 单元格内容为行内 markdown |

`mode: 'suggest'`（写成待采纳的修订）留到 P1 随编辑器实现，P0 返回 `unsupported_mode`。

### 8.3 安全边界

- 文档只能经 MCP 写入；shell 与工作区只做计算，工作区里没有文档文件。
- profile 关闭 `session-log-deepseek` 与 dsh 联网工具，外部检索只走 MCP；不加载 dsh office 技能。
- shell 仍在，因此仍是 danger-full-access：M2 的每用户容器、出口白名单、非 root 运行是上线前提。

## 9. 前端

- **P0**（`apps/platform/src/web/index.html`，无构建）：文档列表、新建 / 上传 docx；只读预览（文档变更 SSE 推送，AI 改动的块高亮闪烁）；选中文字 → 评论 / 评论并让 AI 处理；对话（工具步骤可见、可停止）；版本（保存、对比、回滚）；引用；导出 md / docx；读视图（看模型看到的内容）。
- **P1**：Tiptap 编辑器 + y-prosemirror + 协同网关；AI 改动逐块实时流入，光标 / 选区标注 AI 色；Y.UndoManager；编辑器内评论与 @heurion 自动触发；`suggest` 模式。
- **P2**：deck 编辑面（Univer 画布 + 评论面板 / 形状锚点）。

## 10. 决策记录

| 决策 | 选择 | 原因 / 代价 |
| --- | --- | --- |
| 真相源 | 结构化模型（Yjs）持有真相；文件 = 导入 / 导出视图 | 编辑器不再能摧毁寻址体系（实测：LO 丢 paraId、重编号 shape id） |
| 代码位置 | 新建 `apps/platform`，S 系列 `apps/server` / `apps/web` 停用 | 新架构与旧的文件真相模型不兼容，不在旧代码上改 |
| AI 编辑方式 | MCP `doc_edit(ops)` + 写前守卫；shell 保留给计算 | 守卫成为硬闸；「复述原文失配」「整文件重生成」被结构消灭；实测模型只在数字数时用 shell |
| 用户优先 | `base_rev` + 节点变更索引 | 不依赖模型复述原文；冲突时返回当前内容 |
| 内容格式 | markdown 方言 + 块 id 前缀 | 对 LLM 友好、token 少；实测 deepseek-flash 一次写对 |
| 引用 | `[@c:id]` 原子节点，编号与参考文献表由平台生成 | 编号永不错乱；手写引用在写前被拦截 |
| doc 导入 / 导出 | 自写 OOXML 解析 + 修补式导出 | 未改动的块逐字节保真；mammoth / docx npm 包做不到 |
| dsh 进程粒度 | 每用户一个 | 文档不在工作区里，一个会话可编辑多份文档 |
| 协同（P1） | Yjs + y-prosemirror + 自制最小 ws 协议 | y-websocket 协议面大于需要 |
| deck 内核（P2） | Univer slides + fork Casual Slides 导入；导出修补式 | 开源 JS 里 pptx 往返保真最高；PptxGenJS 整份重建会丢形状 id |
| 放弃 OnlyOffice（2026-10-01 JZ） | 自建内核 | 引擎在外 = 渲染 / 载体 / 许可三重不可控 |
| Collabora | 2026-10-01 随 S 系列停用 | 平台模式下接入需「导出 → 编辑 → 整份导入」，不再值得维护 |

## 11. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 生成块的样式与原文档不完全一致 | 改过的段落在 Word 里观感略有差异 | 生成时沿用原文件的样式表与编号；评测纳入「导入 → 修改 → 导出」专项 |
| 导入覆盖面（文本框、域代码、脚注、复杂编号） | 部分内容只读 | opaque 原样写回不丢；按评测样本逐项扩展 |
| P1 协同层复杂度（Yjs 持久化、断线重连、服务端事后检查） | 数据安全 | 快照 + op log 双存；单进程持有每文档 Y.Doc |
| Casual Slides 上游年轻 | deck 地基 | fork 进组织；导入层隔离清晰，可整体自维护 |
| 模型对新工具面的适配 | 回合成功率 | e2e 任务集持续回归；错误码附 hint 与 current |
| shell 仍可执行任意代码 | 安全 | M2 每用户容器 + 出口白名单 |
| 正文发往 DeepSeek 官方 API | 合规 | M2 PHI 评审；预留私有部署模型路由 |

## 12. 分期 P0–P3

| 期 | 内容 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| **P0 doc 模型与操作层** | 模型 + Yjs 持久化；操作层与写前守卫；MCP 工具面；dsh 接入；评论锚点；版本；docx 导入 / 修补式导出；P0 单页 | e2e 任务集全绿；未改动块导出逐字节保真 | ✅ 2026-10-01：单测 25 项、e2e 13/13（`pnpm --filter @heurion2/platform e2e`）；3 份真实 docx 不改导出正文逐字节一致 |
| **P1 doc 编辑面** | Tiptap + y-prosemirror + 自制 ws 协议；协同网关事后检查；Y.UndoManager；编辑器内评论与 @heurion 自动触发；`suggest` 模式 | 用户逐字编辑与 AI 修改并行无丢失；断线重连恢复 | 待开始 |
| **P2 deck 内核** | Casual 导入层移植；场景图模型；`deck_edit` / `slide_read` / `layout_check` / `slide_render`；修补式 pptx 导出；Univer 编辑面 | deck e2e 全绿；保真探针 ≥ 68/87 | 待开始 |
| **P3 硬化** | deck 多人协同 / 离线恢复 / 权限细化 / 大文档性能 | M1 同口径评测达标 | — |

**P0 实测（deepseek-flash，2026-10-01）**

| 任务 | 耗时 | 工具调用 | 结果 |
| --- | --- | --- | --- |
| 起草带两篇引用的证据段 | 22s（S 系列同类 43s） | 9 次，0 报错 | 引用经 PubMed / Crossref 登记，正文无 DOI，引言未动 |
| 评论驱动修改 | 12s | 6 次，0 报错 | `replace_text` 一处，锚点保留，线程回复、留给用户关闭 |
| 同会话追问压缩 | 19s | 6 次，0 报错 | 保留两个 HR 与引用；shell 仅用于数字数 |
| 导入 docx 后改一段 | 9s | 5 次，0 报错 | 其余块导出时原样写回 |
