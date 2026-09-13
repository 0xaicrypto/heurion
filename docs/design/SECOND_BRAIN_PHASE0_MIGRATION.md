# #1005 Phase 0 迁移方案 — ReferenceItem / SessionReference

> 日期：2026-09-13 · Epic：[#1004] · Issue：[#1005]
> 目标：把 `DocReference`（绑 `docId`）迁移到「用户级内容池 `ReferenceItem` +
> 会话级挂载 `SessionReference`」两层模型，为 epic 的功能线（#1006/#1007…）
> 与架构线（#1013…）提供数据底座。**本阶段不改读路径的用户可见行为。**

## 一、现状盘点

| 面 | 现状 | 证据 |
|---|---|---|
| 表 | `DocReference` 绑 `docId`，`refType` 混来源与解析方式，`targetId` 双语义，`snapshot` 重复存正文 | `prisma/schema.prisma:173` |
| 写路径 | POST `/api/v1/docs/:docId/references`（幂等登记 + 自动导入 + pptx 后台解析）；`doc-import.ts` URL 导入直建 `refType='pdf'`, `targetId=fileId` | `documents.router.ts:530`、`doc-import.ts:119` |
| 读路径 | `buildDocReferenceBlocks`（按 `refType` 注入正文）；`resolveImportTargets`/`extractRefText`；`doc-context-builder.ts:104` | `chat-context.ts:530`、`doc-import.ts:23` |
| 前端 | `useDocReferences` + Reference 弹层；表单默认 `kind='guideline'`；KbPicker summary→`guideline`、document→`file` | `references.ts:68,130` |
| 测试 | `doc-reference-blocks.test.ts`、`writing-editor.routeguards/writeback`、PHI e2e、`references.test.ts` | — |
| Schema 同步 | 无 `prisma/migrations/`；dev 走 `db push --accept-data-loss`，prod 非破坏 `db push`。**一旦新增 migrations 目录，prod 会切到 `migrate deploy`（全库基线化）** | `main.ts:48-77` |
| 幂等迁移先例 | `kb-rename-migration.ts`（启动时 updateMany 幂等） | `main.ts:114` |

## 二、目标模型（additive-only）

```prisma
model ReferenceItem {           // 用户级内容池，不属于任何会话
  id        String  @id          // ref_<sha1(userId|identityKey)[:16]> 确定性 ID
  userId    String  @map("user_id")
  kind      String               // 'file' | 'kb_summary' | 'pasted_text'
  sourceRef String? @map("source_ref") // file→FileIndex.id; kb_summary→Summary stableId; pasted→null
  label     String  @default("")
  snapshot  String  @default("") // kb/pasted 正文；file 类为文件名（懒解析）
  createdAt String  @map("created_at")
  updatedAt String  @map("updated_at")
  sessionRefs SessionReference[]
  @@index([userId, updatedAt])
  @@index([userId, kind])
  @@map("reference_items")
}

model SessionReference {        // 会话级挂载（正式生效）
  id          String @id         // sr_<sha1(sessionId|referenceId)[:16]>
  sessionId   String @map("session_id") // 'doc-<docId>' 或主 chat sessionId
  userId      String @map("user_id")
  referenceId String @map("reference_id")
  addedAt     String @map("added_at")
  source      String @default("manual") // 'manual' | 'suggestion_accepted'
  reference ReferenceItem @relation(fields: [referenceId], references: [id], onDelete: Cascade)
  @@unique([sessionId, referenceId])
  @@index([userId, sessionId, addedAt])
  @@map("session_references")
}
```

- `SuggestedReference` 留到 #1008，不在本阶段建表。
- 不加 `prisma/migrations/`：沿用「schema 增量 + 启动时幂等回填」（先例 `kb-rename-migration.ts`），避免顺带把生产切到 `migrate deploy`。

## 三、映射规则（DocReference → 新模型）

| 旧 `refType` | 新 `kind` | `sourceRef` | `label` | `snapshot` |
|---|---|---|---|---|
| `file`/`pdf`/`docx` | `file` | `targetId` 若为真实 FileIndex.id；否则按名字查 `FileIndex`（`deletedAt=null`，取最新）；查不到 → `null` | `sourceNodes.label` || `snapshot` | 原 `snapshot`（文件名） |
| `note` | `pasted_text` | `null` | 同上 | 原 `snapshot`（正文） |
| `guideline` | 启发式：`label` 命中该用户当前 Summary 标题 → `kb_summary`（`sourceRef=Summary stableId`）；否则 `pasted_text` | — | 同上 | 原 `snapshot` |

- `SourceNodes.label` 解析失败 → label=`snapshot`。
- `targetId`（患者 hash 或 fileId）：读路径未消费（仅 API 回显），迁移后不保留；迁移日志记录非空条数与样本，供审计。
- 会话映射：`sessionId = 'doc-' + docId`；`SessionReference.source='manual'`（旧数据无来源信息）；`addedAt=createdAt`。
- 同一内容跨文档复用：按 identity key 去重（file→`sourceRef ?? label`；kb→`sourceRef ?? label`；pasted→`sha1(snapshot)`），N 个旧行 → 1 个 `ReferenceItem` + N 个 `SessionReference`。

## 四、实施步骤（PR 拆分）

**PR1（本批）— schema + store + 幂等回填**
1. schema 增量加两表（additive-only）。
2. `lib/reference-store.ts`：kind 归一化、确定性 ID、`resolveOrCreateReferenceItem` / `addSessionReference` / `listSessionReferences` / `removeSessionReference`、旧行映射。放 `lib/` 以避开分层规则（common/tools 不得依赖 modules）；guideline 归类器以 `GuidelineClassifier` 注入（生产实现 `modules/shared/summary-lookup.ts`，main/router 注入）。
3. `common/reference-migration.ts`：启动时幂等回填（`UserSetting` 全局 marker 跳过重复扫描），启发式归类 + 审计日志。
4. 单测：store 幂等、映射规则、迁移可重入、跨文档去重。

**PR2（本批）— 写路径双写**
- POST/DELETE `/docs/:docId/references` 在旧写之后 best-effort 同步新模型；DELETE 只删 `SessionReference`，不删 `ReferenceItem`。
- 读路径与响应形状保持旧表不变（#1006 再切读），前端零改造。

**PR3（#1006）**
- `buildSessionReferenceBlocks` + `/api/v1/sessions/:sessionId/references`，旧端点变薄适配层；主 chat 接入。

**PR4（#1011/清理期）**
- 停写旧表 → 观察期 → 删表；命名清理按 #1011 单独排。

## 五、回填伪代码

```
ensureReferenceMigration():
  if userSetting('__global__','second_brain_reference_migration') == '1': return
  summariesByUser = {}   // 懒加载 + 缓存：stableId/title
  for batch of doc_references order by id (500/批):
    identity = normalizeLegacyRef(row, summariesByUser)
    item = resolveOrCreateReferenceItem(identity)         // upsert by ref_<sha1>
    addSessionReference(sessionId=`doc-${row.docId}`, item, source='manual') // upsert by sr_<sha1>
  log 审计：总数 / 各 kind 数 / guideline 归类分布 / targetId 非空数
  set marker=1
```

- 迁移失败单行跳过 + warn；整批失败不阻塞启动（best-effort，与 kb-rename 同纪律）。
- 幂等：确定性 ID + `upsert`；marker 避免每次启动全表扫描。

## 六、验收对照（#1005 checklist）

- [ ] 两表建表；旧数据迁移无损：同一文件跨文档 → 1 item + N session refs；旧 API 响应形状与注入行为不变（本轮读旧表）
- [ ] `kind` 仅 `'file'|'kb_summary'|'pasted_text'`；新写入不再产生 `guideline`
- [ ] 既有回归零回退：`doc-reference-blocks`、PHI 扫描、导入草稿、#930 幂等登记、路由守卫

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| `guideline` 双关（指南粘贴 vs KB 摘要）无法 100% 还原 | 启发式 + 迁移日志记录分布；残留错误可在 #1011/后续人工纠正 |
| `targetId` 患者 hash 语义丢失 | 已核实读路径零消费；迁移日志记录非空条数；回归覆盖患者范围隔离 |
| 同名文件多 FileIndex 记录 | 取最新非删除；仍歧义时 `sourceRef=null`，`snapshot` 文件名继续可解析（现有行为） |
| 双写失败导致新表不全 | best-effort + 启动回填可重跑（marker 删除即重扫） |
| prod `db push` | 仅新增表/索引，非破坏；prod 无 `--accept-data-loss` 也会成功 |

## 八、开放问题

1. `kb_summary.sourceRef` 用 Summary `stableId`（已按 `knowledge.router.ts` 的 `:id` 语义确定）。
2. `SuggestedReference` 留到 #1008（本方案不建表）。
3. 旧端点在 #1006 之后何时停写/删表——建议观察一个发布周期。
