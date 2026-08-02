# 记忆 / 知识库 / 进化系统总体重构设计

**状态：** 设计提案（v1.0）  
**日期：** 2026-07-27  
**负责人：** JZ  
**相关文档：**
- `docs/design/knowledge-base-design.md`（v2.2 产品设计）
- `packages/server-ts/src/evolution/stores.ts`（当前 Facts/Knowledge/Episodes/Skills Store）
- `packages/server-ts/src/core/event-log.ts`（当前 JSONL EventLog）

---

## 1. 背景与问题

当前 `packages/server-ts` 中的记忆/知识/进化系统已经跑通了完整链路：

- `FactsStore` / `KnowledgeStore` / `EpisodesStore` / `SkillsStore` 分别用 `VersionedStore` 存 JSON
- `ChatOrchestrator` 在 post-turn 中完成 fact 提取、article 合成、gap 检测
- `MemoryProjection` 在聊天前按 recency + importance 拼接上下文
- `QueryRouter` 负责意图分类并选择检索路径

但随着功能叠加，以下结构性问题越来越明显：

| 问题 | 表现 |
|---|---|
| 运行时与进化逻辑耦合 | `ChatOrchestrator` 既管聊天，又管 facts/articles/gaps 提取合成 |
| 存储模型割裂 | Facts / Articles / Gaps / Skills / Episodes 各存各的，没有统一关系 |
| 用户编辑无传播 | KB 里修改/删除 fact 后，依赖它的 article 不会自动 stale |
| 缺少版本血缘 | fact 改了，旧版本消失；article 无法显示“基于哪个版本的 fact 生成” |
| 进化策略硬编码 | 每 5 轮提取、每 3 个 facts 合成，无法按用户/主题配置 |
| 检索仍是关键词 | `MemoryProjection` 没有语义召回，facts 多的时候只能硬截断 |
| 无可导出归档 | 用户无法把记忆和知识库整体导出/迁移/备份 |

本次重构的目标：把记忆系统变成**一个统一、可版本化、事件驱动、可导出导入的进化平台**。

---

## 2. 设计目标

### 2.1 Must Have

1. **统一图模型**：Facts / Articles / Gaps / Skills / Entities / Documents 都是同一张记忆图上的节点。
2. **事件驱动**：所有写操作（系统提取、用户编辑、删除、导入）都先写 `EventLog`，再异步投影到图。
3. **版本化**：fact/article 编辑产生新版本，旧版本保留，article 记录生成时依赖的 fact 版本。
4. **用户编辑传播**：用户修改/删除 fact 或 document 后，自动标记依赖的 article 为 stale；删除 article 不影响 facts。
5. **异步进化引擎**：把提取、合成、级联传播从 chat 路径解耦，可失败重试、可观测。
6. **语义检索**：支持 embedding 召回 + 图遍历 + 规则过滤的混合检索。
7. **可导出导入**：定义 `.hma`（Heurion Memory Archive）格式，支持压缩包导出与导入。

### 2.2 Should Have

- 可配置的进化策略（提取间隔、合成阈值、gap 检测条件）
- `MemoryProjection` 按意图选择检索深度
- KB UI 显示版本历史、stale 原因、影响范围
- 导入时支持合并（merge）与覆盖（replace）两种模式

### 2.3 Won't Do（本次）

- 完全替换为 M3 的 `ClinicalGraph` Python 实现（保持 TS 栈，未来可对接）
- 实时多模态图像检索（作为后续迭代）
- 跨用户/跨租户共享知识（保持 per-user 隔离）

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  Runtime Layer（运行时）                                              │
│  - Query Router                                                       │
│  - Memory Projection / Semantic Retrieval                             │
│  - Chat / Sidecar / Research handlers                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Memory Service（读写门面）                                            │
│  - 所有对记忆图的写都通过这里                                          │
│  - 写 EventLog → 更新投影                                             │
├─────────────────────────────────────────────────────────────────────┤
│  Memory Graph（统一存储）                                              │
│  - Nodes: fact / article / gap / skill / entity / document           │
│  - Relations: derives_from / answers / depends_on / supersedes       │
│  - Projection tables: 可由 EventLog 重建                              │
├─────────────────────────────────────────────────────────────────────┤
│  Evolution Engine（异步 worker）                                       │
│  - Extract → Link → Synthesize → Curate                              │
│  - 消费 EventLog，触发 fact/article/gap 的生成与更新                   │
├─────────────────────────────────────────────────────────────────────┤
│  Event Log（唯一真相源）                                               │
│  - 所有记忆相关事件: memory_*                                          │
│  - append-only, migration-immutable                                   │
└─────────────────────────────────────────────────────────────────────┘
```

核心原则：

- **EventLog 是唯一真相源**；Memory Graph 是它的一个投影。
- **运行时只读不写进化产物**；chat 只触发信号、读取投影。
- **用户管理动作也是事件**，必须被进化引擎消费。

---

## 4. 统一数据模型：Memory Graph

### 4.1 节点类型

所有节点共享一个基类：

```ts
interface MemoryNode {
  id: string                // 稳定全局 ID
  type: MemoryNodeType
  ownerId: string           // userId（严格隔离）
  status: 'current' | 'stale' | 'superseded' | 'pending_review'
  content: string           // 文本化核心内容
  contentHash: string       // sha256(content)，用于快速去重
  importance?: number       // 1-5，facts/articles/gaps 可用
  version: number           // 从 1 开始，编辑递增
  previousVersionId?: string
  createdAt: number
  updatedAt: number
  createdBy: 'system' | 'user' | 'sidecar' | 'import'
  provenance: Provenance
  embeddingRef?: string     // 指向 vector_index 的向量记录
  meta: Record<string, unknown>
}

type MemoryNodeType =
  | 'fact'
  | 'article'
  | 'gap'
  | 'skill'
  | 'entity'
  | 'document'
```

### 4.2 关系

```ts
interface MemoryRelation {
  id: string
  sourceId: string
  targetId: string
  relation:
    | 'derives_from'       // fact → document/chat
    | 'depends_on'         // article → fact
    | 'answers'            // fact → gap
    | 'mentions'           // any → entity
    | 'supersedes'         // new version → old version
    | 'related_to'         // 通用相关
  weight?: number
  createdAt: number
}
```

### 4.3 各类型节点字段

#### Fact（事实）

```ts
interface FactNode extends MemoryNode {
  type: 'fact'
  category: 'preference' | 'fact' | 'constraint' | 'goal' | 'context'
  patientHash?: string
  studyId?: string
  sourceType: 'patient' | 'doctor' | 'research' | 'general' | 'sidecar' | 'document'
  count: number            // 被观察到/ reinforced 的次数
  confidence: number      // 0-1
}
```

#### Article（知识文章）

```ts
interface ArticleNode extends MemoryNode {
  type: 'article'
  title: string
  sourceFacts: Array<{ factId: string; version: number; snapshot: string }>
  sourceDocuments?: string[]
  staleBecause?: string[]   // 哪些 factId 变化导致 stale
}
```

`sourceFacts` 记录文章生成时依赖的 fact **版本快照**。这是实现 stale 检测的关键。

#### Gap（知识缺口）

```ts
interface GapNode extends MemoryNode {
  type: 'gap'
  query: string
  context?: string
  source: 'chat' | 'user' | 'sidecar' | 'system'
  sourceId?: string
  answerNodeId?: string     // 回答它的 fact/article id
}
```

#### Skill（学会的技能/策略）

```ts
interface SkillNode extends MemoryNode {
  type: 'skill'
  taskKind: string
  bestStrategy: string
  taskCount: number
  successCount: number
  failureCount: number
}
```

#### Entity（实体）

```ts
interface EntityNode extends MemoryNode {
  type: 'entity'
  entityType: 'patient' | 'medication' | 'biomarker' | 'study' | 'anatomy' | 'concept'
  canonicalName: string
  aliases: string[]
}
```

#### Document（文件）

```ts
interface DocumentNode extends MemoryNode {
  type: 'document'
  fileId: string
  sha256: string
  name: string
  mimeType: string
  patientHash?: string
  extractedFacts?: string[]
}
```

---

## 5. 事件模型

所有记忆相关事件统一前缀 `memory_`，写入 `EventLog`：

```ts
type MemoryEvent =
  // Fact 生命周期
  | { type: 'memory_fact_extracted'; factId: string; sourceEventIds: string[]; payload: FactNode }
  | { type: 'memory_fact_added'; factId: string; payload: FactNode }              // 用户/Sidecar/导入直接添加
  | { type: 'memory_fact_edited'; factId: string; previousVersionId: string; newVersionId: string; payload: FactNode }
  | { type: 'memory_fact_deleted'; factId: string; reason: 'user' | 'system' | 'import' }
  | { type: 'memory_fact_reinforced'; factId: string; countDelta: number }

  // Article 生命周期
  | { type: 'memory_article_synthesized'; articleId: string; sourceFactIds: string[]; payload: ArticleNode }
  | { type: 'memory_article_added'; articleId: string; payload: ArticleNode }
  | { type: 'memory_article_edited'; articleId: string; previousVersionId: string; newVersionId: string; payload: ArticleNode }
  | { type: 'memory_article_deleted'; articleId: string; reason: 'user' | 'system' | 'import' }
  | { type: 'memory_article_regenerated'; articleId: string; sourceFactIds: string[] }

  // Gap 生命周期
  | { type: 'memory_gap_detected'; gapId: string; payload: GapNode }
  | { type: 'memory_gap_answered'; gapId: string; answerNodeId: string; answerType: 'fact' | 'article' }
  | { type: 'memory_gap_ignored'; gapId: string }
  | { type: 'memory_gap_reopened'; gapId: string; reason: string }

  // Skill 生命周期
  | { type: 'memory_skill_extracted'; skillId: string; payload: SkillNode }
  | { type: 'memory_skill_reinforced'; skillId: string; success: boolean; strategy: string }

  // Document 生命周期
  | { type: 'memory_document_uploaded'; documentId: string; payload: DocumentNode }
  | { type: 'memory_document_deleted'; documentId: string; reason: 'user' | 'system' | 'import' }
  | { type: 'memory_document_extracted'; documentId: string; extractedFactIds: string[] }

  // 版本/传播
  | { type: 'memory_node_superseded'; nodeId: string; supersededById: string }
  | { type: 'memory_article_marked_stale'; articleId: string; changedFactIds: string[] }
```

写入协议：

1. 任何写操作必须先 `EventLog.append({ type: 'memory_*', ... })`。
2. 在同一事务/原子步骤中调用对应 `apply_fn` 更新 Memory Graph。
3. `MemoryService` 是唯一的写入口；禁止 KB UI / Chat 直接调用 `FactsStore.updateWhere`。

---

## 6. 用户管理动作的级联传播（Curation）

这是本次重构的重点。用户在 KB 里的所有操作，都必须触发下游传播。

### 6.1 用户编辑 Fact

流程：

```
PUT /api/v1/facts/:id
  ↓
MemoryService.editFact(factId, patch)
  ├─ 创建新版本 Fact v2（旧版 v1 保留，status='superseded'）
  ├─ 写 Event: memory_fact_edited
  └─ CurationEngine.propagateFactChange(factId)
       ├─ 找到所有 depends_on 该 fact 的 Article
       │    → status='stale'
       │    → staleBecause.push(factId)
       │    → 写 Event: memory_article_marked_stale
       ├─ 找到所有 answers 该 fact 的 Gap
       │    → 如果回答失效，status='open'，写 memory_gap_reopened
       └─ 更新相关 cached_views / projection
```

### 6.2 用户删除 Fact

- 不物理删除，而是 `status='superseded'`（软删）。
- 触发与编辑相同的 article stale 传播。
- 如果某 article 删除后依赖的 facts 数量低于阈值（默认 2），article 状态变为 `superseded` 或保留 stale（可配置）。
- 写 Event: `memory_fact_deleted`。

### 6.3 用户删除 Article

- Article 标记 `status='superseded'`。
- 不影响 source facts。
- 如果该 article 曾 answer 某个 gap，则该 gap 重新打开。
- 写 Event: `memory_article_deleted`。

### 6.4 用户删除 Document

- 找到所有 `derives_from` 该 document 的 facts。
- 这些 facts 标记 `superseded`（保留 7 天，用户可撤销）。
- 依赖这些 facts 的 articles 标记 stale。
- 7 天后若用户未撤销，由后台清理任务物理删除这些 facts（及其关系），但保留 article 作为 stale 记录。
- 写 Event: `memory_document_deleted`。

### 6.5 用户手动新增 Fact / Article

- 视为 `memory_fact_added` / `memory_article_added`。
- 触发：
  - 与现有 facts 去重/合并
  - 尝试回答 open gaps
  - 判断是否满足 article 合成条件

### 6.6 配置策略

```ts
interface CurationPolicy {
  factDelete: 'soft' | 'hard'            // 默认 soft
  articleOnFactDelete: 'stale' | 'supersede' // 默认 stale
  staleGracePeriodMs: number             // 默认 7 天
  minFactsForArticle: number             // 默认 2
  documentDeleteAutoCleanup: boolean     // 默认 true
}
```

---

## 7. Evolution Engine（进化引擎）

把 `ChatOrchestrator.postTurn` 中的进化逻辑完全抽出。

### 7.1 职责划分

| 组件 | 负责 | 不负责 |
|---|---|---|
| `ChatOrchestrator` | 组装请求、路由、投影上下文、返回响应 | 不直接提取 facts / 合成 articles |
| `MemoryService` | 提供记忆图的读写接口 | 不做 LLM 调用 |
| `EvolutionEngine` | 消费事件、做 LLM 提取/合成、更新图 | 不直接处理 HTTP/SSE |
| `CurationEngine` | 用户编辑传播、版本管理、stale 检测 | 不做 LLM 调用 |

### 7.2 进化管线

```
EventLog 新事件
  ↓
EventDispatcher
  ├─ memory_fact_extracted / memory_fact_added
  │    → ExtractStage.deduplicateAndLink(fact)
  │    → 尝试 AutoResolveGaps
  │    → 触发 SynthesizeStage.checkArticleThreshold
  │
  ├─ memory_fact_edited / memory_fact_deleted
  │    → CurationEngine.propagateFactChange
  │
  ├─ memory_document_uploaded
  │    → DocumentExtractor（可异步）
  │    → 生成 facts
  │
  ├─ memory_gap_detected
  │    → 评估是否立即检索 or 进入夜间队列
  │
  └─ memory_skill_extracted / memory_skill_reinforced
       → 更新 skill 统计
```

### 7.3 触发策略（可配置）

```ts
interface EvolutionPolicy {
  factExtraction: {
    minTurnsSinceLast: number   // 默认 5
    maxTurns: number            // 默认 20，强制提取上限
    minContentLength: number    // 默认 50
  }
  articleSynthesis: {
    minRelatedFacts: number     // 默认 3
    maxFactsPerArticle: number  // 默认 10
    clusterSimilarityThreshold: number // 默认 0.75
  }
  gapDetection: {
    minQueryLength: number      // 默认 10
    maxOpenGapsPerUser: number  // 默认 100
  }
  documentExtraction: {
    autoExtractOnUpload: boolean // 默认 true
    maxPagesForAutoExtract: number // 默认 50
  }
}
```

### 7.4 异步执行

使用 **BullMQ + Redis** 队列：

- 每个进化任务作为一个 job 入队。
- 支持重试（默认 3 次）、死信队列、延迟任务。
- 任务状态持久化，便于观测和调试。
- worker 可独立扩展，后续可部署为单独进程。

同时保留一个同进程 fallback，用于测试和本地无 Redis 环境。

---

## 8. Memory Projection（运行时检索）

### 8.1 检索分层

```
Query Router
  ↓
├─ 结构化意图（factual_query）
│    → SQL / Entity lookup
├─ 语义意图（semantic_search）
│    → Embedding recall → Graph expand → Rerank
├─ 关系意图（relational_query）
│    → Graph traversal
├─ 显式知识库命令
│    → KnowledgeCommandHandler
└─ 混合意图
     → 多路召回 + RRF 融合
```

### 8.2 Embedding 召回

- 对 Fact / Article / Gap / Document text 生成 embedding。
- 使用成本较低的 embedding 模型（如 local/text-embedding-small）。
- 召回后按 `importance × recency` 重排。
- 最终只把 Top-K（默认 20）注入 prompt。

### 8.3 Graph 扩展

召回 seed nodes 后，沿关系扩展 1–2 跳：

- `fact → depends_on → article`
- `article → depends_on → fact`
- `fact → answers → gap`
- `fact → mentions → entity`

扩展后的节点按相关度重排，避免无关信息淹没上下文。

### 8.4 压缩

沿用 `context-compressor.ts` 的三级压缩：

1. 结构化排序（importance × recency）
2. 紧凑化表示（三元组 → 句子）
3. 去重合并（时间序列合并）

### 8.5 Embedding Provider 选择

**决策：使用 DeepSeek embedding。**

理由：

- **成本极低**：embedding 定价通常比生成模型低 1–2 个数量级，且记忆库更新频率远低于聊天调用，实际月度成本很小。
- **账单统一**：与现有 DeepSeek 生成模型共用一套 API key、账单和限流，运维简单。
- **质量足够**：医学事实/文章以短文本为主，DeepSeek embedding 在语义召回上能满足需求。

成本估算（假设）：

| 场景 | 数量 | 单次 tokens | 月总量 | 估算费用 |
|---|---|---|---|---|
| Fact/Article 索引 | 500 条 | 200 | 100k | ~$0.01 |
| 每日 chat 查询 embedding | 100 次 | 50 | 150k | ~$0.01 |
| 文件全文索引 | 50 个 | 5k | 250k | ~$0.02 |

> 实际费用取决于 DeepSeek 当时的 embedding 定价；即便比上表高一个数量级，也远低于生成模型开销。

优化措施：

1. **按 `contentHash` 缓存 embedding**：内容未变不再重算。
2. **批量调用**：一次请求最多 100 条文本，降低 HTTP 开销。
3. **只 embed current 节点**：superseded/stale 节点跳过。
4. **Provider 抽象**：`EmbeddingProvider` 接口，便于未来切到本地模型（如 `Xenova/all-MiniLM-L6-v2`）或混合策略。

隐私提醒：DeepSeek embedding 会把文本发送到云端。对于高度敏感的 PHI，可在后续迭代中加入“本地 embedding 模式”切换。

---

## 9. Heurion Memory Archive（.hma）导出/导入格式

### 9.1 设计原则

- **自包含**：一个 `.hma` 文件包含所有记忆数据 + 原始文件 + 元数据。
- **可人工阅读**：包含 `README.md` 解释格式。
- **可版本化**：`manifest.json` 携带 schema 版本，支持向前兼容。
- **不依赖 Nexus 运行**：解压后可用普通文本工具查看。
- **可导入**：支持合并（merge）和覆盖（replace）两种模式。

### 9.2 文件结构

```
my-memory-2026-07-27.hma   (ZIP / TAR.gz)
├── manifest.json
├── README.md
├── event_log.jsonl            # 完整事件日志
├── memory_graph.jsonl         # 节点 + 关系（可选，可由 event_log 重建）
├── projections/
│   ├── facts.json
│   ├── articles.json
│   ├── gaps.json
│   ├── skills.json
│   └── entities.json
├── files/
│   └── <sha256>.bin           # 原始文件内容寻址
├── prompts/
│   └── <prompt_id>@<version>.md
└── signature.json             # 校验和 + 导出时间
```

### 9.3 manifest.json

```json
{
  "format": "heurion-memory-archive",
  "version": "1.0.0",
  "schemaVersion": 1,
  "exportedAt": "2026-07-27T10:00:00Z",
  "exportedBy": "user_abc123",
  "ownerId": "user_abc123",
  "content": {
    "eventCount": 15234,
    "nodeCounts": {
      "fact": 320,
      "article": 45,
      "gap": 12,
      "skill": 8,
      "entity": 67,
      "document": 28
    },
    "fileCount": 28,
    "promptCount": 5
  },
  "encryption": null,
  "compression": "zip"
}
```

### 9.4 memory_graph.jsonl

每行是一个节点或关系：

```jsonl
{"kind":"node","data":{"id":"fact_001","type":"fact","ownerId":"user_abc123",...}}
{"kind":"relation","data":{"id":"rel_001","sourceId":"article_001","targetId":"fact_001","relation":"depends_on"}}
```

### 9.5 event_log.jsonl

与现有 `EventLog` 格式一致，但只包含 `memory_*` 事件和必要的 chat/workflow 上下文事件（用于溯源）。

### 9.6 导出 API

```http
POST /api/v1/memory/export
Content-Type: application/json

{
  "scope": "all",
  "includeFiles": true,
  "includePrompts": true,
  "encryption": null | "age"
}

→ 202 Accepted
→ { "jobId": "...", "downloadUrl": "..." }
```

### 9.7 导入 API

```http
POST /api/v1/memory/import
Content-Type: multipart/form-data

file: my-memory.hma
mode: "merge" | "replace"

→ 202 Accepted
→ { "jobId": "...", "reportUrl": "..." }
```

### 9.8 导入策略

#### Merge 模式

- EventLog：追加新事件，重新编号。
- 节点：按 `contentHash + type + ownerId` 去重；已存在则 reinforcement（count++）。
- 文件：按 SHA-256 去重，已有则不覆盖。
- 关系：按 `(sourceId, targetId, relation)` 去重。

#### Replace 模式

- 清空当前用户的记忆图、EventLog、相关 files。
- 完全替换为归档内容。
- 需要用户二次确认。

### 9.9 安全与隐私

- 导出文件**默认不加密**，但 UI 必须提示“该文件包含您的 PHI/隐私数据”。
- 支持 `age` 加密，密钥由用户自行保管（或存于系统 keychain）。
- 导入时校验 `ownerId`：禁止把 A 用户的归档导入到 B 用户（除非显式迁移流程）。
- 导出任务在 worker 中异步执行，避免阻塞主线程。

---

## 10. API 改动

### 10.1 新增 API

| 端点 | 作用 |
|---|---|
| `POST /api/v1/memory/export` | 发起导出任务 |
| `GET /api/v1/memory/export/:jobId` | 查询导出进度/下载链接 |
| `POST /api/v1/memory/import` | 发起导入任务 |
| `GET /api/v1/memory/import/:jobId` | 查询导入报告 |
| `GET /api/v1/memory/nodes/:id/versions` | 查看节点版本历史 |
| `GET /api/v1/memory/articles/:id/impact` | 查看 article 依赖的 facts |
| `POST /api/v1/memory/articles/:id/regenerate` | 重新生成 stale article |
| `POST /api/v1/memory/curation/replay` | 手动重放 EventLog（管理员） |

### 10.2 现有端点改造

| 端点 | 现在 | 改后 |
|---|---|---|
| `PUT /api/v1/facts/:id` | 直接覆盖 | 创建新版本 + 传播 |
| `DELETE /api/v1/facts/:id` | 物理删除 | 软删 + 传播 |
| `DELETE /api/v1/knowledge/facts` | 批量物理删除 | 批量软删 + 传播 |
| `DELETE /api/v1/knowledge/articles/:id` | 物理删除 | 软删 + 传播 |
| `DELETE /api/v1/files/:fileId` | 删文件 | 级联处理 facts |
| `POST /api/v1/knowledge/gaps/:id/resolve` | 更新 gap | 生成 answer fact + relation |

### 10.3 SDK 扩展

`packages/sdk-client` 增加：

```ts
client.memory.export(options: ExportOptions): Promise<JobRef>
client.memory.import(file: File, mode: 'merge' | 'replace'): Promise<JobRef>
client.memory.getNodeVersions(nodeId: string): Promise<MemoryNode[]>
client.memory.regenerateArticle(articleId: string): Promise<ArticleNode>
```

---

## 11. UI 改动

### 11.1 Knowledge 页面

- 文章卡片显示 `current` / `stale` / `superseded` 状态徽章。
- stale 文章显示原因：“依赖的 Fact #45 已更新”。
- 提供 `[重新生成]` / `[手动编辑]` / `[忽略]` 操作。
- 新增 **Version History** 弹窗，展示 fact/article 的版本链。
- 新增 **Impact** 弹窗，展示“修改/删除此 fact 会影响 N 篇文章”。

### 11.2 Fact 编辑弹窗

```
编辑 Fact #45
─────────────────────────────
内容：RUL nodule 19mm (CT 7/15)
重要性：4

⚠️ 此修改将影响以下 2 篇文章：
  • NSCLC EGFR 管理（将标记为 stale）
  • RUL 结节随访策略（将标记为 stale）

[保存并标记相关文章 stale] [取消]
```

### 11.3 Document 删除确认

```
删除文件 CT_7-15.pdf
─────────────────────────────
该文件是 3 个 facts 的来源。删除后：
  • 这 3 个 facts 将被标记为 superseded
  • 依赖它们的 1 篇文章将被标记为 stale

[确认删除] [保留 facts]
```

### 11.4 Settings → Data

新增卡片：

- **导出我的记忆**：生成 `.hma` 归档
- **导入记忆**：上传 `.hma`，选择 merge/replace
- **备份历史**：查看最近导出任务

---

## 12. 模块布局

```
packages/server-ts/src/
├── core/
│   ├── event-log.ts              # 已有，扩展 memory_* 事件支持
│   └── versioned-store.ts        # 已有，作为底层投影存储
│
├── memory/                       # 新增：统一记忆层
│   ├── memory.service.ts         # 写入口 / 事务门面
│   ├── memory.graph.ts           # MemoryGraph 存储与查询
│   ├── memory.projection.ts      # 投影维护（facts/articles/gaps/skills）
│   ├── memory.types.ts           # 所有类型定义
│   ├── memory.archive.ts         # .hma 导出/导入实现
│   ├── memory.router.ts          # REST API
│   │
│   ├── evolution/
│   │   ├── evolution.engine.ts   # 进化引擎主控
│   │   ├── extract.stage.ts      # fact/skill 提取
│   │   ├── synthesize.stage.ts   # article 合成
│   │   ├── gap.stage.ts          # gap 检测/回答
│   │   ├── document.stage.ts     # 文件提取
│   │   └── policy.ts             # 进化策略配置
│   │
│   └── curation/
│       ├── curation.engine.ts    # 用户编辑传播
│       └── propagation.rules.ts  # 传播规则
│
├── retrieval/
│   ├── query-router.ts           # 已有，扩展 memory 路由
│   ├── memory-projection.ts      # 改为读取 MemoryGraph
│   ├── semantic-search.ts        # 已有，扩展 embedding 召回
│   └── context-compressor.ts     # 已有
│
└── modules/chat/
    └── chat.orchestrator.ts      # 移除进化逻辑，改调 MemoryService
```

---

## 13. 实施路线图

### Phase 1：统一写入门面 + 版本化（2 周）

- 创建 `MemoryService` 和 `MemoryGraph`
- 迁移 `FactsStore` / `KnowledgeStore` / `Gaps` / `Skills` 到统一图模型
- 保持现有 API 兼容，内部通过 `MemoryService` 写事件
- 为 Fact / Article 添加版本字段与关系

### Phase 2：级联传播（1 周）

- 实现 `CurationEngine`
- 用户编辑/删除 fact → 依赖 article stale
- 用户删除 document → facts superseded
- KB UI 显示 stale 状态和影响范围

### Phase 3：Evolution Engine 解耦（1.5 周）

- 把 `ChatOrchestrator.postTurn` 中的提取/合成/检测逻辑迁到 `EvolutionEngine`
- Chat 只触发事件，不直接进化
- 使用 BullMQ/Redis 队列执行进化任务，支持重试、死信和状态观测
- 保留同进程 fallback 用于测试环境

### Phase 4：语义检索（1.5 周）

- 接入 embedding 召回
- `MemoryProjection` 改为 vector + graph 混合
- 加入 RRF 重排

### Phase 5：导出/导入（1 周）

- 实现 `.hma` 格式与异步导出 worker
- 实现导入的 merge / replace
- Settings UI 导出/导入卡片

### Phase 6：收尾与测试（1 周）

- 全链路集成测试
- 回归 chat / knowledge / sidecar
- 性能基准与成本观测

**总计：约 8 周。**

---

## 14. 测试策略

### 14.1 单元测试

- `MemoryService`：写入必须产生正确事件 + 投影
- `CurationEngine`：fact 编辑后 article 正确 stale
- `EvolutionEngine`：触发阈值、合成条件、失败重试
- `MemoryArchive`：导出/导入 round-trip 一致

### 14.2 集成测试

- 用户编辑 fact → article stale → regenerate → current
- 用户删除 document → facts superseded → article stale
- 导入 merge 模式去重
- 导入 replace 模式完整替换

### 14.3 回归测试

- Chat 历史、上下文注入、Knowledge 命令
- Sidecar 输出写知识库
- 现有 facts/articles/gaps API

### 14.4 黄金回放

- 导出生产 EventLog → 清空调试库 → 导入 → 投影必须与原始一致
- 每次修改 store layer 必须跑通

---

## 15. 关键指标

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 用户编辑 fact → article stale 延迟 | < 500ms | API 响应时间 |
| Evolution 任务失败率 | < 1% | worker 日志 |
| MemoryProjection token 消耗 | 比当前降低 40% | LLM 调用日志 |
| 语义检索 Top-5 相关性 | > 80% | 人工采样 |
| 导出归档完整性 | 100% round-trip | 黄金回放测试 |
| 导入去重准确率 | > 99% | 测试用例 |
| stale article 用户处理率 | > 60% | UI 事件 |

---

## 16. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 统一图模型迁移导致数据丢失 | 高 | 先并行写旧 store + 新 graph，验证一致后再切读 |
| 级联传播误伤大量 articles | 中 | 默认 soft delete + stale，不自动物理删；UI 提示 |
| Evolution Engine 异步失败沉默 | 中 | 每个任务必须持久化状态 + 失败告警 + 死信队列 |
| Embedding 召回质量差 | 中 | 保留关键词过滤兜底；A/B 测试后上线 |
| 导出文件 PHI 泄露 | 高 | UI 强制提示；默认建议 age 加密；导出审计日志 |
| 导入旧版本归档不兼容 | 中 | `manifest.schemaVersion` + 迁移适配器 |
| 重构周期过长阻塞其他需求 | 高 | 分 Phase 交付，每 Phase 可独立上线 |

---

## 17. 关键决策（已确定）

| # | 问题 | 决策 | 说明 |
|---|---|---|---|
| 1 | Embedding 模型 | **DeepSeek embedding** | 成本低、与现有 DeepSeek 生成模型共用一套账单/限流；实现时封装 provider 接口，保留后续切换本地模型的空间。 |
| 2 | Document 删除策略 | **自动清理** | Fact/Document 删除后 soft supersede，7 天后无用户撤销则自动物理清理；article 仍保留，仅标记 stale。 |
| 3 | 实施起点 | **Phase 1 + Phase 2** | 先实现 `MemoryService + MemoryGraph + 版本化`，再做用户编辑级联传播。 |
| 4 | 部分导出 | **不允许** | 首次版本只支持全量导出/导入；单个 patient/study 的 scope 保留在 API 字段但不实现。 |
| 5 | Evolution Engine 执行方式 | **使用队列** | 初始实现即基于 BullMQ/Redis 的异步 worker，支持重试、死信和观测。 |

## 18. 未决问题

1. **Article 删除后是否保留 source facts 的快照？** 建议保留 `sourceFacts` 字段，但关系删除。

---

## 18. 下一步建议

1. **Review 本设计文档**：确认数据模型、事件模型、.hma 格式是否符合产品方向。
2. **决定 Phase 1 切入点**：建议先做 `MemoryService + MemoryGraph + Fact/Article 版本化`。
3. **输出任务拆分**：我可以继续把 Phase 1 拆成具体 PR（先写类型/API，再迁移 stores，最后补测试）。

如果你同意这个方向，我建议从 **Phase 1 + Phase 2（统一写入 + 级联传播）** 开始实现，因为这是当前最痛的“用户编辑不同步”问题，也能为后续进化引擎解耦打好基础。
