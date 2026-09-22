# Brain 2.0 记忆生命周期设计 — MemoryGraph 门面 + 人工审核闭环 + 长会话压缩

> **状态**：已交付（G.1–G.7 审核闭环上线；K1–K6 全部落地；§13 简化模型 S1–S3
> 与 §14 写作模块整合均已交付）。本文档 2026-09-22 逐条对照代码重写为
> as-built（参照 `CITATION_SYSTEM.md` 补记式写法）：**§3/§4 的
> `MemoryGraphGateway.readContext` API 已不存在**——门面现在的实际方法见 §3，
> 会话上下文组装走 `selectProjectionInputs` + Memory Projection + 段装配管线
> （`modules/chat/context-assembler.ts`），设计文档里"`readContext` 成为其
> 数据源"的方案被取代；**"article" 概念已全仓库改名 "summary"**（#1011，
> `common/kb-rename-migration.ts`，文档旧文的 `article`/`addArticle` 一律按
> `summary`/`addSummary` 理解）；**K4 合成的"近 7 天确认 ≥3"硬性时间门禁已被
> 移除**（#816 覆盖率驱动调度取代，时间窗降级为可观测信号）。
> **范围**：`packages/server-ts`（memory / chat / approvals / retrieval）+ `packages/web`
> **关联**：`docs/design/SECOND_BRAIN_DESIGN.md`（引用材料统一，as-built 已重写）
> **本文档整合并取代**：`CHAT_CONTEXT_COMPACTION.md`（会话压缩设计，已并入 §5–§6）、
> `MEMORY_KNOWLEDGE_EVOLUTION_REFACTOR.md`（记忆重构设计，重构已完成，生命周期见本文档）
> **本文档整合并修订**：记忆提取时机（K1–K6）、长会话压缩（R2）、审批闭环、患者隔离

---

## 1. 背景与目标

### 1.1 设计时的现状问题（2026-08-02 基线，问题均已处置）

| # | 问题 | 影响 | 现状 |
|---|---|---|---|
| P0 | 记忆写入无人工审核：facts 直接落库，提取错误不可撤销 | 临床事实可靠性风险 | ✅ 全部走 pending 审核（唯一例外：用户显式命令 fastTrack，见 §7.2） |
| P0 | 层3 facts 注入不分患者 | 患者 A 问诊可能注入患者 B 的事实 | ✅ `isolateFactsByScope`（`modules/shared/chat-context.ts`） |
| P1 | 记忆分散：facts/articles/episodes 双写无统一读取接口 | 上下文组装逻辑散落 | 部分 ✅——graph 为单一事实源（#840 读路径分批切换），legacy 投影保留为兼容回落（#840 epic 尚未关闭） |
| P1 | 提取时机固定"每 5 轮" | 知识沉淀不完整 | ✅ K1 游标 + 压缩/关闭两触发点（§5.1；Tier 1 实时提取已按 §13 S1 移除） |
| P1 | 压缩是硬裁剪；压缩丢的旧信息无人工兜底 | 长会话早期关键信息信任度低 | ✅ R2 锚定压缩 + 压缩提取进 pending（§6.3） |
| P2 | gaps 无自动检测；persona 每轮全量重建 | 上下文浪费 | ✅ K6 + K5（persona LRU 版本缓存，`modules/shared/user-context.ts buildCachedPersona`） |

### 1.2 目标（全部达成）

1. **单一事实源**：记忆读写收敛（graph 门面 + 审核闭环；读路径的完全收敛见 §11 的 #840 尾巴）。
2. **人工审核闭环**：待审核队列 → 人工确认 → 版本化落库。
3. **会话/记忆分离**：session 是对话窗口；记忆按患者/全局/study 聚合，跨会话持久。
4. **患者隔离**：任何 scope 的上下文组装只注入本 scope 的记忆（+ 受控的跨 scope 补充）。
5. **有界且可追溯**：长会话压缩产出锚定摘要（Session Memory）+ 待审核记忆，无静默丢失。

---

## 2. 总体架构（as-built 接线）

> 原设计的 `MemoryGraph.readContext(scope)` / `extract` 方法不存在——门面
> 提案与压缩职责分离，上下文组装走注入管线。下图为实际接线：

```
┌────────────────────────── 会话运行时 ──────────────────────────┐
│                                                               │
│  会话开始/每轮                                                 │
│    └─► selectProjectionInputs（modules/shared/chat-context.ts）│
│          按 router intent 选层 → MemoryProjection（retrieval/）│
│          → systemPrompt 稳定段（persona/patient/层2/层3）       │
│          → context-assembler.ts 逐段装配 + 预算/段级回退        │
│                                                               │
│  压缩 / 会话关闭                                               │
│    └─► memory/compaction/runner.ts（R2 + S3）                  │
│          ├─ episodeUpdate → 更新 Session Memory（episodes，草稿）│
│          └─ facts → gateway.propose() → pending 待审核队列      │
│                                                               │
│  审核（Brain inbox / approvals）                                │
│    └─► approval.service.applyTargetUpdate(MemoryProposal)      │
│          └─► defaultProposalApplier（memory/registry.ts）       │
│              → graph 新版本（可回滚）                           │
│              → embedding.indexApproved → EmbeddingIndex.upsert │
│              → 下轮 selectProjectionInputs 读到新内容            │
└───────────────────────────────────────────────────────────────┘
```

**核心原则修订**：`propose`（提）、`summarize`（总）、`applyApproved`（写）、
`retrieve`（语义检索）四个能力收敛在 `MemoryGraphGateway`（§3）上；会话只持有
事件日志，不直接写记忆；**读取不经过门面**——上下文组装是 chat 模块的
projection 管线（#637 装配器），数据源已切 graph（#840）。

---

## 3. MemoryGraph 门面接口（as-built）

```ts
// packages/server-ts/src/memory/memory-gateway.ts
export type MemoryScope = { patientHash?: string; studyId?: string; global?: boolean }
// 提案 kind：'fact' | 'summary' | 'episode_summary' | 'compaction_summary' | 'skill'
//   （memory/contracts.ts ProposalKind；'episode_summary'/旧 'article' 行为差异见 §5.3/§5.4）

export class MemoryGraphGateway {
  // ── 提案生命周期（propose → pending → applyApproved/rejectProposal）──
  propose(input: ProposalInput): Promise<MemoryProposalRow>   // 唯一写入入口
  listPending(scope?: MemoryScope)
  applyApproved(proposal)                                     // 版本化写 graph + 建向量
  rejectProposal(proposalId, reason, actorId): Promise<boolean>
  markApproved(proposalId, actorId)                           // 只改状态不落图

  // ── 检索 ──
  embedOrNull(text)                                           // 测试可注入
  retrieve(query, scope, { topK?, minScore?, includeCrossPatient? })   // 余弦 top-k
  embeddingIndex()                                            // 测试注入向量用

  // ── 会话摘要（Session Memory，草稿层）──
  summarize({ conversation, sessionId, patientHash?, sinceIdx? }): Promise<{ summary, proposals }>
}
```

与原设计的差异：

- **`readContext` 已删除**（上下文组装不在门面上，见 §4）。
- **`extract` 独立成 `memory/compaction/runner.ts` 的 `extractSegment`**（S3）。
- `rejectProposal` 签名带 `actorId`（审计）。
- `summarize` 产出**只更新 Session Memory（episodes），不再产生待审摘要提案**
  （`memory/summary/session-summarizer.ts`："the episode_summary proposal
  was a no-op"）。

### 3.1 现有基础设施映射（as-built）

| 能力 | 现状 |
|---|---|
| 版本化节点 | `MemoryGraph`（version/status/snapshot/restore，`memory/memory.graph.ts`） |
| 封装层 | `MemoryService.addFact/addSummary/editSummary/supersedeFact`（`memory/memory.service.ts`）——注意是 `addSummary` 不是 `addArticle`（#1011 更名） |
| 提取 | `memory/compaction/runner.ts`：压缩时（Tier 2）+ 会话关闭 flush（Tier 3），全部走 `propose` |
| 审批 | `approval_requests`，`targetType='MemoryProposal'`（`modules/approvals/approval.service.ts`），确认走 `applyTargetUpdate` → registry `defaultProposalApplier` |
| 上下文组装 | `selectProjectionInputs`（`modules/shared/chat-context.ts`）+ `retrieval/memory-projection.ts` + `modules/chat/context-assembler.ts`（#637 段装配管线） |
| 待审核 UI | Brain inbox（#48）+ 审批流（MemoryProposal 分组按会话聚合） |

---

## 4. 会话上下文组装（readContext 已被取代 — as-built 方案）

> 原 §4 的设计是"`readContext` 成为其数据源"。实现走的是另一条路（R1 typed
> Context Source + 段装配器），数据源切 graph（#840）。本节按现状描述；
> 设计原则（层选择/患者隔离）保留且已实现，只是宿主不在门面上。

### 4.1 层选择（`selectProjectionInputs`，chat-context.ts）

按 router intent（`retrieval/query-router.ts`）选层：

| intent | 注入 |
|---|---|
| `sql` / `file` | 不注入积累记忆（SQL/附件承载） |
| `vector` | facts（患者隔离 + graph 优先） |
| `mixed`（默认） | facts + 当前 session 的 episodes + 技能（经 conversation-turn 激活匹配，#841） |

数据源：graph 存在时走 `GraphFactProvider`（`memory/fact-provider.ts`，#840
单一事实源），否则回落 legacy store。#814 层3 降级：仅 `importance ≥ 4`
或近 14 天的 facts 进碎片投影（`CONTEXT_CONFIG.projection.layer3ImportanceMin`
/ `layer3RecentDays`），其余交给 summary/JIT 合成覆盖（#815）。

### 4.2 患者隔离（P0 修复 ✅）

```
isolateFactsByScope(allFacts, patientHash)     // chat-context.ts
  本患者 facts → 预算内全量
  跨患者 facts → 仅 importance ≥ 4 且带 [patient: hash] 标记，
                上限 CONTEXT_CONFIG.retrieval.crossPatientMax
```

- 渲染 `[patient: 名称]` 标记、`[lab ★★★]` 格式见 `common/fact-render.ts`
  （#627 统一事实渲染）。
- doc- 写作会话（无患者上下文）额外治理（#894）：不注入患者范围 facts
  （`projectionFacts` 的 `excludePatientScope`）+ facts 封顶
  `CONTEXT_CONFIG.retrieval.docFactsCap=10`（P0 hotfix 2026-09）+ 患者名单/
  study_context 按需注入（`shouldInjectPatientRoster`/`isResearchIntent`）。

### 4.3 R1 — typed Context Source（#98 ✅ 已实现）

实现文件 `memory/context-sources.ts`（非门面方法）：system prompt 拆成带
内容 hash 的稳定段，per-user 快照（`<TWIN_BASE_DIR>/<user>/context-snapshot.json`）
对比出 changed/removed；首轮全量，后续轮仅变更源以增量 system 消息追加。
字节稳定 → provider prompt-cache 命中；persona 段独立更新（13.5H）。

### 4.4 会话管理（多会话 + 开启/关闭）

> 与原设计一致，两处细节修正：①提取游标不在 Session 行上——独立
> `kbExtractCursor` 表（per-session 键，`memory/extraction-cursor.ts`，#181；
> 交错会话不得互相跳过事件）；②Session 行上的游标是 `compactedUptoIdx`
> （压缩防重，S2）。

```
Session 实体（prisma Session → nexus_sessions）:
  id / userId / scope ('global' | 'patient') / patientHash?
  title / status ('open' | 'closed') / compactedUptoIdx?
  createdAt / closedAt / lastMessageAt

scope 规则:
  global: 多会话，显式开启/关闭/切换
  patient: 每患者一个固定会话（patient-{hash} 语义保留）
  study:  暂不开放

生命周期:
  开启: "新建会话" → POST /api/v1/sessions
  关闭: status=closed（不可再写）→ 会话关闭 flush（Tier 3 提取）→ 记忆沉淀到 scope
```

**关键点**：压缩（长会话中途）与关闭（会话终点）都走
`memory/compaction/runner.ts` 同一条路径；压缩产物 = Session Memory 更新 +
fact 提案进 pending（§6.3）。

### 4.5 写入时 embedding + 读取时语义检索（as-built，存储形态修正）

embedding 不是平行系统——审核生效时建向量（`proposal.service.ts` 的
`applyApproved` → `EmbeddingService.indexApproved`），检索只覆盖可信记忆
（§3 `retrieve`，propose 不建向量）。与原设计差异：**存储是 per-user JSONL
索引（`memory/embedding-index.ts`，逐用户 brute-force 余弦扫描），不是
vector_index 表/sqlite-vec**——per-user 规模下（#23）暴力扫描足够，无需
向量库。模型 bge-m3（`EMBEDDING_MODEL` 可配，`embedding/`，
本地 ONNX 服务 embedding-server :8003）。

```
写入（审核通过后）:
  applyApproved → defaultProposalApplier → memory.addFact/addSummary
              → embedding.indexApproved() — 只给 facts/summaries 建向量；
                document 走文件引用（chunk 正文内嵌 record，#749）；
                引用材料走 reference-embedding（type='reference'，#1009）

读取（按需语义检索）:
  retrieve(scope, query) → embed(query) → cosine top-k
  - search_node 工具已升级为语义/混合检索（#25 graph 遍历扩展 + RRF #748）
  - 患者隔离: 检索默认只搜本 scope（includeCrossPatient 显式放行）

维护:
  删除/取代 → graph 事件驱动（curation.engine 失效传播），索引随 stableId 失效
  语义去重（写入前）: propose 时 embed(content) 与 scope 内已有记忆
    相似度 ≥ 0.95 → 自动拒绝（rejected, resolvedBy=system），不进审核队列
```

关键约束不变：**没审核过的内容不进语义检索**；R1（hash 增量）与 R2
（Session Memory）不依赖 embedding。

---

## 5. 记忆提取管道（K1–K6 修订版 — as-built）

### 5.1 增量游标 + 事件驱动（K1+K2，#109）✅（两处修订）

- **游标是 per-session 的**（`kbExtractCursor` 表，`memory/extraction-cursor.ts`，
  #181）：交错会话不能让一个会话的 flush 跳过另一个会话的事件；scope 级
  legacy key 保留兼容。原设计的"每个 scope 一个游标"已被取代。
- **Tier 1 实时提取已移除**（§13 S1，同文件头注释 "S1: real-time extraction
  is removed"）：信号正则 + 2s 去抖 + shouldExtractIncrement 触发链路删除；
  显式指令由 `kb_remember` 命令直写承接（fastTrack，§7.2）；所有事实性提取
  统一走批量路径（压缩时/会话关闭时）。

### 5.2 全部人工审核（修订 #109）✅

```
提取结果（extractClinicalEntities / deepseek 提取）:
  → gateway.propose() → pending 队列（人工审核）
审核通过 → applyApproved → graph 版本化更新（+ embedding 索引）
唯一例外：用户显式命令（kb_remember 等）带 fastTrack —— 走与人审相同的
applier 落库，提案行保留作审计记录（#839 收口）
```

### 5.3 Session Memory（K3 修订版，取代原"摘要进 pending"）

会话摘要是**草稿层，不进审核**：

- 每轮压缩时：LLM 一次调用同时产出 episodeUpdate（更新 Session Memory）与
  未沉淀事实提案——`memory/summary/session-summarizer.ts` 明确
  "Summaries are Session Memory (draft layer, un-reviewed)…the
  episode_summary proposal was a no-op"。
- 注入只查当前 session 的 episodes（会话隔离在 `selectProjectionInputs`
  实现：`episodes.all().filter(e => e.sessionId === sessionId)`）。
- 新会话绝不继承其它会话的未审摘要（模块注释显式锁定该约束）。
- 旧版 `episode_summary` 提案的审批仍兼容（确认只记 verdict，不落图，
  `approval.service.ts`）。

### 5.4 Summary 合成（K4 修订版 — 覆盖率驱动，#816）

原设计的"同类别新增 facts ≥ 3（以 sourceFactStableIds 为增量键）+ §13.3C
的**近 7 天确认 ≥3 硬性时间门禁**"已被取代：

- 触发改为**覆盖率驱动**（`memory/knowledge-synthesis.ts` + `memory/coverage.ts`）：
  按类目聚合"未被任何 current summary 覆盖（且未被 pending 提案占用）"的
  facts，最大簇 ≥3（`MemoryGranularityController.shouldConsolidate` 的
  `SUMMARY_MIN_CLUSTER`）即合成；长尾陈旧 facts 从此有覆盖路径。
- **7 天硬门禁已移除**：时间窗降级为可观测信号（新鲜度画像入日志，
  `recentConfirmations`，不阻塞调度）；原门槛防的噪声（同批 facts 反复触发）
  由"pending 占用即算覆盖"根治。
- 合成结果**一律进 pending**（answer-ready 契约：结论/依据/caveat +
  factId 白名单过滤，`summary-contract.ts` #813——编造 ID 的合成物直接
  丢弃本轮，宁缺毋滥）；源 facts 以 `relatedFacts` 字段回指（增量为键）。

### 5.5 Persona 缓存（K5，#111）✅

facts/knowledge store 版本变化才重建；无变化复用（`buildCachedPersona`，
有界 LRU + scene 维度 #510；#840 起 graph 渲染源 `memory/persona-source.ts`）。

### 5.6 Gap 自动检测（K6，#111）✅

- 问题形态消息未被 facts 覆盖 → 自动创建 gap（7 天去重窗口仍有效，
  `modules/knowledge/knowledge-gap.service.ts`）；纯逻辑在
  `modules/knowledge/gap-detect.ts`，触发判定经
  `MemoryGranularityController.shouldPromote`（#1013 收口）。

### 5.7 矛盾检测与取代（fact 非孤立原则 + 同 scope 规则）✅（未漂移）

**Fact 携带 scope 标识，一切"相关/冲突/取代"判定只在同一 scope 内进行。**

- 提取时注入的"已有 facts"上下文仅含同 scope facts（`compaction/budget.ts`
  `buildContextBlock`；跨患者 facts 一律排除——"永不构成矛盾"）。
- propose 时：`conflictsWith` 必须通过 same-scope 校验
  （`proposal.service.ts` `filterSameScopeConflicts`），跨 scope 标记丢弃。
- 审批时（`applyApproved` → `defaultProposalApplier`）：批准带 `conflictsWith`
  的提案 → 对同 scope 冲突旧 fact 执行 supersede（版本机制保留历史）；
  **批准即人工裁决**。
- 语义去重（≥0.95）只挡重复，不挡矛盾；矛盾检测由 LLM + 审批闭环完成。

---

## 6. 长会话压缩（R2 修订版 — as-built）

### 6.1 触发（公式已修订）

原设计的 `estimate(...) > MODEL_CONTEXT_WINDOW − max(output, buffer)`
已被集中配置取代（`common/context-config.ts`）：

```
主触发: 真实消息轮数超窗（history ≥ historyTurns×2，默认 20 轮×2）或
       有被裁剪的 omittedTurns —— 且非 doc- 会话（doc- 走独立历史预算，
       docHistoryTurns=6/docHistoryTokens=1500，P0 hotfix 2026-09）
次触发: 知识库注入后历史被裁剪超总预算 → 异步压缩（triggerCompactionAfterTrim）
预算:  maxTotalTokens=128000 / maxHistoryTokens=32000（env 可配, #637 集中）
```

### 6.2 锚定摘要 → Session Memory（S2 合并后形态）

- **一次 LLM 调用同时产出** anchoredSummary（摘要）与 episodeUpdate（增量
  摘要）与未沉淀事实——三者中 episodeUpdate 直接并入 Session Memory，
  anchoredSummary 不再另存独立结构（§13 S2）。
- 保留最近窗口原文逐字（`buildHistoryMessages`，`retrieval/context-compressor.ts`），
  更早部分进摘要；中间消息可拆分。
- 压缩对用户可见（#display：`compaction_started`/`completed`/`summary` SSE
  + event log 通知文本，失败不再静默——`buildCompactionNotice`）。

### 6.3 压缩产物（修订核心，as-built）

```
压缩 = Session Memory 更新（episodeUpdate 并入 episodes，草稿层，仅当前会话注入）
     + facts[] → gateway.propose() → pending 人工审核（被裁剪段中未沉淀的事实）
     + 游标推进（compactedUptoIdx + kbExtractCursor，防重复压缩/重复提取）
```

- `kbCompaction` 表**保留写入但只承担游标 + 展示**（摘要列落本次
  episodeUpdate 供 #display 兜底）；注入不再走 kbCompaction
  （`history-budget.ts` 仅作向后兼容的游标读取），即"不再有独立的
  anchored-summary 存储"。
- 工具结果序列化截断等预算卫生见 `compaction/budget.ts`（MAX_EVENT_CHARS=500）。

### 6.4 失败兜底（as-built）

- 摘要 LLM 失败/解析失败 → **游标不推进**（下轮重试同段），结果如实上抛
  并向用户展示失败通知（原"静默跳过"已按 #display 修订）。
- pending 写入失败 → 仅日志降级，不影响会话。

---

## 7. 待审核队列与审批（as-built）

### 7.1 数据模型（实际列）

```prisma
model MemoryProposal {        // prisma/schema.prisma:660
  id / userId
  scopeType ('patient'|'global'|'study') / patientHash / studyId
  kind      // fact | summary | episode_summary | compaction_summary | skill（旧 'article' 行启动时迁移）
  content / importance / confidence / reason
  sourceRange    // "session:<id>" / "file:<id>#w" 溯源（#46c910c1/#836）
  conflictsWith  // JSON [{"stableId","content"}] — §5.7
  status ('pending'|'approved'|'rejected') / rejectedReason
  resolvedAt / resolvedBy
  archivedAt     // 13.4D 超期归档
  category       // 13.4F 提取类别（质量反馈统计维度）
  relatedFacts   // JSON stableId[]（合成占用/回指）
  payload        // #844 skill 提案候选（其他 kind 为 null）
}
```

### 7.2 审批状态机（as-built）

- 复用 `approval_requests` 状态机；**审批 target 是 `MemoryProposal`**
  （原设计的 "Fact/Article target 分支" 未采用——skill/persona 等审批同走
  此单表）；`applyTargetUpdate` 分派：
  - fact/summary → `defaultProposalApplier`（`memory/registry.ts`）版本化落图
    + 语义 supersede（§5.7）+ embedding 索引（§4.5）
  - episode_summary/compaction_summary → 只记 verdict，不落图（草稿层语义）
  - skill → 机构 scope 需 admin 确认（#845）
- 审计：`writeAuditLog`（action `approval.confirmed` / `approval.rejected`）
- 权限：审批写入永远 owner-scoped（#794——收件箱绝不跨租户；跨用户可见性
  是显式 admin opt-in `?scope=all`）；拒绝原因可选（#149）
- pending 超期治理（13.4D）：低重要性 facts（≤2）与非 fact 摘要超 7 天自动
  归档（`archiveStaleProposals`，惰性执行，可手动恢复）；高重要性（≥4）
  保持 pending 置顶。
- 提取质量反馈（13.4F）：7 天按 category 统计接受率注入提取 prompt
  （`memory/extraction-quality.ts`）。

### 7.3 UI ✅

- Brain inbox 扩展"记忆待审核"（kind 徽标 + 会话聚合 + 置信度 + 来源轮次，
  #46c910c1 溯源）。
- 审批后 memory-graph 页可见新版本。

---

## 8. 与既有 issues 的映射（全部关闭）

| Issue | 内容 | 状态 |
|---|---|---|
| #112 门面 + 隔离 | ✅ 已完成（readContext 后被 §4 方案取代） |
| #113 审批闭环 | ✅ 已完成（target 收敛为 MemoryProposal） |
| #114 压缩/关闭 → summarize → pending | ✅ 已完成（摘要侧修订为 Session Memory 直更） |
| #115 多会话管理 | ✅ 已完成（Session.scope/status） |
| #98 R1 typed Context Source | ✅ 已完成（`memory/context-sources.ts`） |
| #104–#108（U2/T2/S1/T4/U4U5O3） | ✅ 全部已完成 |

---

## 9. 实施计划（G.1–G.7）✅ 全部完成

G.1 门面骨架 / G.2 审批 target / G.3 患者隔离接入 / G.4 提取全进 pending /
G.5 压缩闭环 / G.6 Brain inbox UI / G.7 多会话管理 —— 全部交付（细节见
各节 as-built 注记；G.2 的 target 语义收敛见 §7.2）。

---

## 10. 测试计划（as-built 对账）

| 层 | 用例 | 状态 |
|---|---|---|
| 单测 | 门面接口；提取全进 pending（无直写）；患者隔离过滤；proposal 幂等；per-session 游标；S1 无实时提取路径；S2 压缩只更新 episodes；§13.3B 排序；S3 两触发点 | ✅（`tests/unit/` memory 系列） |
| 集成 | 压缩触发 → Session Memory 更新 + proposals 进 pending；审批 → graph 新版本 + 下轮注入可见 | ✅ |
| 隔离测试 | 患者 A 注入 facts 与患者 B 无交集（跨患者仅限 importance≥4 带标记） | ✅ |
| 会话管理 | 多会话并行；关闭后不可写；关闭触发 flush；默认会话兼容 | ✅ |
| 回归 | `/api/v1/agent/chat` SSE 兼容 | ✅ |

---

## 11. 风险与缓解（回顾）

| 风险 | 缓解 | 实际 |
|---|---|---|
| 审核负担过重 | Brain inbox 批量确认 + importance 排序 + 13.4D 超期归档 | ✅ |
| 压缩摘要长期不审 | 摘要改为草稿层（不阻塞长期记忆），仅 facts 待审 | 语义变更（§5.3） |
| 门面改造破坏现有注入 | G.3 数据源替换行为差异用测试锁定；#840 起读路径分批切 graph，legacy 投影回落保留 | #840 收敛中 |
| 患者隔离误伤"对比患者"场景 | importance≥4 + 上限 + 患者标记渲染（isolateFactsByScope） | ✅ |
| 双写过渡期不一致 | graph 为真相源 + LegacyProjection reconcile（`memory/legacy-projection.ts`） | #840 收敛中 |

---

## 12. 与 KB v2.2 设计的关系

- KB 管道（takeaway/facts/summaries——原 "articles" 已随 #1011 更名 summary）
  对应：takeaway = 即时 UI；facts = §5 提取管道；summaries = §5.4 覆盖率驱动
  合成（进 pending）。
- 本设计补齐了 KB v2.2 缺失的**审核环节**——知识从"自动沉淀"升级为
  "自动建议 + 人工确认"。

---

## 13. 记忆系统优化设计（Phase 3 — v3.0 简化模型）✅ S1–S3 已交付

> 在 G.1–G.7 基础上收敛的简化模型（两形态 + 一路径 + 一闸门）。**2026-09-22
> 核对**：S1/S3 按设计落地；S2 落地形态与原表述有一处偏差（见 13.2）。

```
对话 → EventLog（真相源）
   ├─► Session Memory（草稿层：per-session 渐进摘要，episodes）
   │     不审核 · 仅当前会话注入 · 压缩时更新同一份
   ├─► 批量提取"未覆盖段"（唯一提取路径，两个触发点：压缩时 / 会话关闭时）
   ▼
pending（唯一审核闸门）── confirm → Facts（档案层）
                        └ reject → 丢弃+审计
Facts：结构化 · 版本化 · 可 supersede · 跨会话注入（患者隔离）
```

### 13.1 现状缺陷（原表 — F1/F2 已修，F3 已被 #816 重新定义）

| # | 缺陷 | 处置 |
|---|------|------|
| F1 | 全局 persona 混入患者 facts | ✅ 修复（`common/persona.ts` buildPersona 只取无 patientHash/studyId 的 facts；constraint 类目 #814 补进 persona） |
| F2 | topFacts 按 count 排序 | ✅ 修复（importance × recency 衰减，`user-context.ts` §13.3B 注释） |
| F3 | Article 触发粗糙 | ✅ 由 #816 重新定义：覆盖率驱动（coverage.ts）替代时间窗口；"pending 占用"根治重复触发 |
| F4 | 审计缺口（超期治理/质量指标） | ✅ 13.4D/F 落地（archivedAt 惰性归档 + extraction-quality + memorization.router 健康面板） |
| F5 | persona 整体缓存 | ✅ 并入 R1——context-sources.ts 稳定段 + persona 段独立 hash 更新 |

### 13.2 简化实施（S1–S3）✅（S2 有一处与原方案的偏差）

- **S1 · 砍 Tier 1 实时提取** ✅——`memory/extraction-cursor.ts`：游标只在
  压缩时与会话关闭时推进；`kb_remember` 等显式命令直写承接（fastTrack）。
- **S2 · Session Memory 合并** ✅（落地形态差异）——anchoredSummary 确实不再
  另存（runner.ts 注释 "S2: no anchored-summary store"），注入只查
  episodes；**但 `kbCompaction` 表仍在压缩时写入一行**，只承担两件事：
  压缩防重游标（`coveredUptoIdx`，`history-budget.ts` 向后兼容读取）与
  #display 的摘要通知兜底——"停止写入"的原方案改为"降级为游标/展示记录"，
  注入面（草稿层语义）按原方案收敛。
- **S3 · 归一提取路径** ✅——`extractSegment(userId, scope, sessionId,
  fromIdx, toIdx, ctx)` 统一入口（`compaction/runner.ts`），压缩溢出段与
  会话关闭 flush 两触发点；边界判定走
  `MemoryGranularityController.shouldConsolidate`（#1013）。

### 13.3 正确性修复

- **A. Persona 患者隔离** ✅（见 13.1 F1）。
- **B. topFacts 排序** ✅——score = importance × e^(−0.3×daysAgo)
  （`user-context.ts` 注释即决策记录）。
- **C. Summary 触发时间窗口** —— **已被取代**：#816 覆盖率驱动调度上线，
  "≥3 条为最近 7 天确认"的硬性 AND 条件移除（时间窗降级为日志观测信号）。
  原本 7 天窗口防的噪声由 pending 占用根治。此为本重写的关键修正之一。

### 13.4 审核体验（✅ D 超期归档 / E 批量确认；F 质量反馈）

- **D. Pending 超期治理** ✅ `archiveStaleProposals`（pending 列表惰性执行，
  非 fact 一律归档、fact 仅 importance≤2）。
- **E. Brain inbox 分组与批量确认** ✅（按会话聚合 + confirmIds 批量）。
- **F. 提取质量反馈** ✅ `memory/extraction-quality.ts`（7 天接受率 → 动态
  提取 prompt 规则段；数据源 = MemoryProposal 的 `category` 字段）。

### 13.5 审计治理

- **G. 记忆健康仪表盘** ✅（`modules/memorization/memorization.router.ts`：
  接受率/矛盾率/pending 超期/归档数/规模 + `13.5G` UI）。
- **H. Persona 分段缓存** ✅（R1 typed Context Source 的 persona 段独立 hash，
  `memory/context-sources.ts`）。

### 13.6 数据模型变更 ✅

`archivedAt` / `category` / `relatedFacts` / `payload` / `conflictsWith` 列
均已建表（见 §7.1）；episodes 升级为唯一 Session Memory（S2）。

---

## 14. 写作模块整合升级设计（对话驱动写作）✅ 已交付

> 目标：从"人工直接编辑 markdown"变为"通过跟 AI 对话完成写作"。已全部落地。

- **W1 写作页 chat 孤岛** ✅ 解除——`/docs/:id/chat` 410 废弃端点已删除
  （`documents.router.ts`），写作聊天统一走 `/agent/chat`
  （sessionId `doc-<docId>`，§13 的统一管道）。
- **W2 编辑器** ✅ TipTap（ProseMirror）WYSIWYG 画布（`components/DocEditor.tsx`
  + @tiptap 全家桶）；**W3 记忆整合** ✅ doc- 会话上下文治理
  （#894）+ facts 封顶；**W4 结构化写回** ✅ `edit_document` 工具
  （`tools/edit-document-tool.ts`，#171——原设计 §15.4 组件拆解）+
  失败结构化诊断（#1022）。
- 后续演进见 `WRITING_MODULE_REDESIGN.md` / `CITATION_SYSTEM.md`
  （DocCitation 结构化引用为写作模块的第二个 as-built 子系统）。

---

## 15. 修订历史

| 版本 | 内容 |
|---|---|
| v2.0 | 初始设计（G.1–G.7） |
| v2.1 | 矛盾检测与取代（§5.7）；Tier 1 信号收缩；压缩 delayed-sync；episodes 会话隔离 |
| v2.2 | §13 记忆系统优化设计（Phase 3 治理）；修订 §7.3 拒绝原因可选、§8/§9 完成状态 |
| v3.0 | §13 重写为简化模型：两形态 + 一路径 + 一闸门 |
| v3.1 | §14 写作模块整合升级（对话驱动写作 + TipTap 画布 + 统一聊天管道） |
| v3.2 | **2026-09-22 as-built 重写（#1105）**：`MemoryGraphGateway.readContext` 已不存在，门面 API 按实际方法重录（§2/§3/§4）；"article"→"summary" 全仓更名落地（#1011）；K4 "近 7 天确认 ≥3" 硬性门禁已移除（#816 覆盖率驱动）；§13 S1–S3 交付状态核定（S2 的 kbCompaction 降级为游标/展示记录）；提取游标 per-session 化；§14/§15 编号乱序修正 |
