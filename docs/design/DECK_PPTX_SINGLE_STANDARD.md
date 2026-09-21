# deck 富编辑 — pptx 字节单一标准 设计文档

> **状态**：已定案（epic #1101，2026-09-21）。基于 spike #1102 实测（GO 结论）。
> **范围**：`packages/web`（deck-view 编辑面）、`packages/server-ts`（存储契约 / edit_deck 工具 / 导出）、
> `packages/worker`（生成管线保持）、`packages/contracts`（工具 schema）。
> 关联：[`CITATION_SYSTEM.md`](./CITATION_SYSTEM.md)（引用纪律，本设计须保持其语义）。

---

## 1. 决策摘要（三轮演进的终态）

| 轮次 | 方案 | 结论 |
|---|---|---|
| 1 | SlideWise 嵌入式库 | 否决（编辑深度不足 / React>=19 peer / 项目年轻） |
| 2 | ONLYOFFICE Document Server iframe | 降级为重量级备选（4GB 栈 / AGPL / JWT-callback 管线 / 20 并发限） |
| 3（终态）| **pptx 字节单一标准** | **pptx 字节 = 持久真相源；DeckWire = 纯派生投影** |

**终态架构**：人类（pptx-react-viewer 嵌入组件）与 AI（pptx-viewer-core 正式 API）都原生操作**同一份 pptx 工件**；
DeckWire（`Doc.deck`）降级为**纯派生投影**（`pptx-extractor` 按需重建，仅供 AI 上下文注入 / deck_slide 评论锚点 / 卡片缩略图），**不再是编辑目标，也不再持久真相源**。

## 2. spike 实测依据（GO 的依据，#1102）

- 真实 worker 产物解析完好（3 页中文 deck：文本/notes/布局）。
- 元素级编辑走 `findText`（稳定 elementId `ppt/slides/slideN.xml-shape-M` + segmentIndex）→ `replaceText(slides, search, replacement)` — patch 语义，未触碰内容保留。
- React 18.3.1 直接挂载 `PowerPointViewer canEdit`（peer `^18.2 || ^19` 双版本 CI 覆盖），无需 React 19 升级。
- **关键教训**：`element.text` 直接赋值不被 save 管道识别（`text`/`textSegments` 双字段）— **所有编辑必须走正式函数 API**。这决定了 AI 工具 schema 的形态（§4）。

## 3. 存储契约（前置决策①）

### 3.1 真相源形状

```
Doc.deckArtifactId  →  FileIndex 工件（真实 pptx 字节）      ← 唯一持久真相源
Doc.deck            →  DeckWire 投影缓存（extractor 重建，可随时清空重建）
```

- pptx 字节作为**文件工件**复用既有 `FileIndex` + tokenized download 存储（不新增 DB 大字段列；Doc.deck TEXT 列不适合存 MB 级 base64）。
- `Doc.deck` 列保留但语义变更为"投影缓存"：每次 pptx 工件更新后由 `pptx-extractor`（`pptxSlidesToDeck`，已存在）重建。读侧约定：**投影过期（工件 mtime/version 新于投影）按未投影处理，绝不信任过期投影**（对齐 blockProjection 的先例语义）。
- DeckWire 从此**只读**：卡片流编辑功能降级（§6），AI `edit_deck` 旧路径退役。

### 3.2 存量迁移（一次性）

1. 对每个 `Doc.deck` 非空文档：走现有 worker `generatePptx` 导出管线生成 pptx 字节 → 建 FileIndex 工件 → 写 `deckArtifactId`（幂等：已有 artifact 跳过）。
2. 迁移脚本 `scripts/migrate-deck-bytes.ts --doc-id <id> [--dry-run]`，沿用 #1080 迁移脚本的形态（dry-run / 幂等 / 逐篇执行）。
3. 迁移完成后 `Doc.deck` 原值保留至下一版本再清（保守两步走：先加工件、后改语义）。

### 3.3 序号/一致性

- 写回单点 `writeDocVersion` 的 deck 侧乐观锁（`baseDeck`，本轮已加）继续生效 — 语义升级：base 比较对象从 DeckWire 字符串改为 pptx 工件的 fileId+版本戳。

## 4. AI 工具 schema（edit_deck 字节路径）

### 4.1 新工具面（替代 index-based edit_deck）

结构化动作 schema（与 edit_deck 的 old_text/new_text 语义同构，全部映射到 pptx-viewer-core **正式函数 API**）：

```ts
edit_deck_bytes({ docId, actions: [
  { op: 'set_text', find: '87 例 EGFR 敏感突变…治疗', replace: '120 例…' },   // → findText + replaceText
  { op: 'set_chart_data', elementId, categories, series },                     // → Presentation chart API
  { op: 'set_table_data', elementId, rows },                                   // → table API
  { op: 'add_slide', afterIndex, title?, bullets? },                           // → Presentation.addSlide
  { op: 'remove_slide', slideIndex }, { op: 'move_slide', from, to },
  { op: 'set_notes', slideIndex, text },
] })
```

- **禁止裸改 PptxData 字段**（spike 教训：`element.text` 赋值被 save 忽略）— AI 只产结构化 actions，服务端经 zod schema 校验后逐一映射为 pptx-viewer-core 正式 API 调用。
- `find` 语义 = edit_deck 的 old_text 同源（模型从投影上下文逐字复制）。
- 执行：加载工件字节 → `PptxHandler.load` → 依序执行动作 → `save` → 新工件落 FileIndex → `pptx-extractor` 重建 `Doc.deck` 投影 → `writeDocVersion`（snapshotLabel 'AI deck edit (bytes)'）。

### 4.2 引用纪律移植

- `citation-guard`（`looksLikeHandwrittenReferences` + `HANDWRITTEN_REFERENCES_GUIDANCE`）挂在**动作 schema 校验边界**：对每个 `set_text` 的 `replace` 文本先过 guard（与 edit_document/edit_deck 现有门控同口径）。
- AI 想引用 → 仍走 `insert_citation` 产 `[cite:id]` 标记；deck 文本里的 shortcode 由既有导出边界解析（#1099）与卡片徽标渲染（CitationBadges）承接，语义不变。

### 4.3 与注释里产品的两条硬语义保持

- 「AI 永不自动关闭评论」「AI 编排（organize/edit_deck）走 chat 工具循环」不变；AI 编辑产物仍经 writeDocVersion 单点（快照/撤销语义保留）。
- `Doc.deck` 投影只读后，卡片流的**编辑**入口退役；`CitationBadges`、评论徽标在投影上继续工作。

## 5. 评论锚点策略（deck_slide）

- spike 实测 `findText` 返回的 elementId（`ppt/slides/slideN.xml-shape-M`）**跨 round-trip 稳定**（part path + OOXML shape id 均为文件原生稳定标识）。
- 方案：`DocComment` 的 deck_slide 锚点增加 `anchorShapeId`（迁移：对存量 open 评论做一次 findText 重建）。锚点判定从「slideIndex+blockIndex+anchorText 模糊」升级为「shapeId 精确 + anchorText 兜底（AI 重排后 shapeId 失配时回退）」— 消除画布级重排导致的 blockIndex 大面积漂移风险（#1101 评审轮 1 的 P1 风险 3 就此闭环）。
- 富编辑会话期间评论照常可读可写（react-viewer 内编辑不锁定评论；锚点基于投影定位）。

## 6. 人类/AI 序列化写排队（单写队列）

- 同一 deck 工件的写者：人类 react-viewer `onContentChange`（保存触发）与 AI `edit_deck_bytes`（工具回合内执行）。
- 协议：per-docId 写队列（与 `#980` 保存单点对齐）— **人类保存落库后 AI 才能基于新字节执行**，反之 AI 执行期间人类保存进入队列等待。不存在 OnlyOffice 方案的"会话互斥"问题（两编辑器共享同一表示、patch 语义可交错）。
- 并发写冲突残余：react-viewer 与 AI 同时持有旧字节各自修改 → 后写者覆盖先写者。防线：保存时校验工件 fileId 未变（乐观锁，#904 同款），变了则 409 提示重载。

## 7. 编辑入口（deck 视图整合）

- deck 视图保留双模式：**卡片流（只读投影 + 评论 + CitationBadges）为默认**；「富编辑」按钮进入 react-viewer 编辑态（全宽接管，返回卡片流时触发保存落库）。
- react-viewer 主题化：`--slidewise-*`…（注意：react-viewer 的主题 token 为 `--pptx-*` CSS vars，spike 已核实支持暗色默认）对齐 DESIGN_SYSTEM_v2；`labels` 接 zh-CN/en。
- 移动端：react-viewer 窄屏体验收尾核查（明示桌面限定或缩放交互）。

## 8. 边界与不做

- 不做 pptx-viewer-core 的 AI/chat 面板集成（tree-shake 掉 ai-sdk 依赖面 — spike 已证可 stub @napi-rs/canvas）。
- 动画/切换由 react-viewer 承载（39 预设/57 切换）；worker pptxgenjs 生成侧不追求动画（既有 scope）。
- 预览管线沿用 soffice（react-viewer 自带渲染预览后可评估替换，非本期）。

## 关联文档

- [`CITATION_SYSTEM.md`](./CITATION_SYSTEM.md) — 引用纪律与悬挂引用链路（§4 渲染 / §5 清除路径的 body/deck 对称协议）。
- [`WRITING_MODULE_REDESIGN.md`](./WRITING_MODULE_REDESIGN.md) — writeDocVersion 单点写入闸门（本设计的 3.3/6 节沿用其乐观锁语义）。
