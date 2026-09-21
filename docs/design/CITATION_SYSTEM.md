# 参考文献结构化系统 — 架构说明

> **状态**：已交付（epic #1084，2026-09-21）。本文档为补记的 as-built 架构说明，
> 不是提案文档——写作模块此前没有任何设计层文档描述这一子系统，只有 inline 代码注释
> 和已关闭的 GitHub issue（#1076-#1083、#1099），本文档补上这个空白。
> **范围**：`packages/contracts`、`packages/server-ts`（citations / documents 模块 +
> `tools/insert-citation-tool.ts`、`tools/citation-guard.ts`）、`packages/web`
> （`lib/citation-view.ts`、`routes/writing-editor/citation-health.tsx`）、
> `packages/worker`（导出边界解析）。

---

## 1. 背景与目标

在此之前，写作模块的"参考文献"完全靠 AI 把检索结果格式化后直接写进 `doc.body` 的
markdown 纯文本——没有引用对象模型、没有稳定 ID、没有编号字段，也没有自动重排序/
重生成/校验逻辑。两条硬性要求驱动了这次重构：

1. 用户上传的参考材料（PDF/URL/粘贴文本，即 `ReferenceItem` 参考材料池）不能作为
   正式参考文献出现在 References 列表里——只能作为写作背景素材。
2. 正式参考文献必须是真实文献，且必须带 DOI——不能是 AI 编造，也不能是用户上传但
   未经文献检索验证的内容。

## 2. 数据模型

`packages/contracts/src/citations.ts` 是编号算法与 DOI 校验的单一事实源
（web 渲染 / References 列表 / worker 导出三处共用，禁止各自实现）：

```ts
docCitationSchema = { id, docId, doi (必填, /^10\.\d{4,9}\/\S+$/), pmid?, title,
                       authors (JSON 序列化数组), journal?, year?, url?,
                       source: 'pubmed' | 'crossref' }

CITE_SHORTCODE_PATTERN = /\[cite:([A-Za-z0-9_-]+)\]/g   // 正文内标记
assignCitationNumbers(body)                              // 按首次出现顺序编号，单一实现
resolveCitationShortcodes(body, knownIds)                 // [cite:id] → [n]，悬挂 → [?]
```

`DocCitation` 表（`prisma/schema.prisma`）持久化正式引用，`doi` 必填 + 幂等读回
（`docCitationId(docId, doi)` 确定性 ID，同一文档重复插入同一 DOI 不产生重复记录）。

与参考材料池（`DocReference`/`ReferenceItem`）**架构隔离**——`insert_citation`
工具的检索管道与材料池导入完全不共享代码路径（有专门的隔离测试锁定）。

## 3. 写入路径

- **`insert_citation` 工具**（`tools/insert-citation-tool.ts`）：PubMed 优先 /
  Crossref 兜底（复用 #835 的外部文献源管道），过滤掉全部无 DOI 的候选（`no_doi_found`
  错误，禁止编造），`(docId, doi)` 幂等复用已有记录。
- **引用纪律收口**（`tools/citation-guard.ts`）：`looksLikeHandwrittenReferences` +
  `HANDWRITTEN_REFERENCES_GUIDANCE`，拒绝 AI 手写编号引用列表，强制走
  `insert_citation`。接入 `edit-document-tool.ts`（覆盖 range/section/full 三种编辑
  模式）和 `edit-deck-tool.ts`（deck 文本编辑同门控）。

## 4. 渲染路径

- **正文**：`packages/web/src/lib/citation-view.ts` 是 TipTap 装饰层——`[cite:id]`
  在编辑器里保持纯文本 round-trip 安全，渲染层叠加动态 `[n]` 徽标（悬挂引用显示
  `[?]` 警示态），点击可预览元数据/DOI 链接。接入 `DocEditor.tsx`。
- **deck**（`deck-view.tsx`）：每张幻灯片卡片下方渲染引用徽标行
  （`citation-badges.tsx` 的 `CitationBadges`）——扫描该页全文本（标题 + 要点
  段落 + 备注），按页内首现顺序渲染 `[n]` 徽标（编号与 doc 侧同一 contracts
  实现），悬挂引用为 `[?]` 警示态，点击打开元数据/DOI 链接预览。卡片内
  可编辑 input/textarea 中的原始 shortcode 保持不动（编辑面），徽标是
  可视化 affordance 层。注意这是 deck 卡片流的徽标方案而非 tiptap 装饰层
  （deck 不是富文本编辑器）；正文 `[n]` 的编辑器内联徽标见上条。
- **References 列表**：`packages/web/src/routes/writing-editor/references-list.tsx`
  是只读派生视图——正文里的标记消失，列表里对应条目自动消失，无法手写偏离。

## 5. 悬挂引用（dangling citation）

"悬挂"定义：正文或 deck 内容里存在 `[cite:id]` 标记，但 `DocCitation` 表里没有对应记录
（例如引用被删除、迁移未覆盖、或手动清库）。

- `citation-store.ts` 的 `findDanglingCitations(docId, body, deckJson)` 是唯一权威实现，
  同时扫描 body 和 deck 两个内容源。
- `GET /api/v1/docs/:docId/citations/dangling` 复用这个权威实现，驱动
  `CitationHealthBanner`（`citation-health.tsx`）。
- 清除路径：`POST /citations/dangling/:citationId/remove`（body/deck 对称处理，
  接入了未保存修改的基线保护 `base_body`/`base_deck` 与乐观锁 `baseBody`/`baseDeck`——
  这条链路在 2026-09-21 经过 5 轮复审才收敛到当前状态，历史教训见 §7）。

  与之区分：`DELETE /citations/:citationId` 是删除一条**真实存在**的 `DocCitation`
  记录（非悬挂场景），只删数据库记录，不清除正文/deck 里的标记——留空标记会让该
  引用在下次体检时变成悬挂态，再走上面的清除路径处理。

## 6. 导出边界

`packages/worker` 的导出管线（docx/pptx/pdf）在导出时把 `[cite:id]` 解析为 `[n]`
编号文本，并追加自动生成的 References 节（`buildReferencesSection`，与 web 渲染/
References 列表共用同一编号算法）。悬挂引用导出为 `[?]` 占位 + warn 日志，不静默丢弃、
不原样保留内部 ID。

## 7. 已知历史教训（供后续同类改动参考）

引用重构的收尾阶段（清除悬挂引用 API）经历了 5 轮复审才收敛，反复出现的根因是
**body 和 deck 两条内容路径没有共用同一套一致性保证**（乐观锁、冲突检测、未保存
内容保护）——每一轮只对齐了其中一边，下一轮又在另一边冒出镜像 bug。最终修复是把
两者的 apply 逻辑合并成同一段代码，而不是继续维护两套平行实现。这个教训的一般化结论仍然成立：任何"文档内容"相关的新功能，落地前都
应该显式核对 deck 侧是否需要同步处理，而不是事后补丁（deck 渲染缺口正是在第 2 轮
复审中被发现并补齐的）。

## 关联文档

- [`WRITING_MODULE_REDESIGN.md`](./WRITING_MODULE_REDESIGN.md) — 写作模块北极星方案
  （ProposalCard 统一提议组件、节级信任标签），与本系统共享 `writeDocVersion` 单点
  写入闸门。
