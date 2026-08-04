# Brain 2.0 记忆生命周期设计 — MemoryGraph 门面 + 人工审核闭环 + 长会话压缩

> **状态**：设计稿 v1（2026-08-02）
> **范围**：`packages/server-ts`（memory / chat / approvals / retrieval）+ `packages/web`
> **关联**：`docs/design/brain.md`（Brain 2.0 总体设计）、
> `PRODUCT_DESIGN_REVIEW_OPENCODE.md`（对照 opencode 的评审）、`knowledge-base-design.md`（KB v2.2）
> **本文档整合并取代**：`CHAT_CONTEXT_COMPACTION.md`（会话压缩设计，已并入 §5–§6）、
> `MEMORY_KNOWLEDGE_EVOLUTION_REFACTOR.md`（记忆重构设计，重构已完成，生命周期见本文档）
> **本文档整合并修订**：记忆提取时机（K1–K6）、长会话压缩（R2）、审批闭环、患者隔离

---

## 1. 背景与目标

### 1.1 现状问题

| # | 问题 | 影响 |
|---|---|---|
| P0 | 记忆写入无人工审核：facts 每 5 轮直接落库（`chat.orchestrator.postTurn`），提取错误不可撤销 | 临床事实可靠性风险 |
| P0 | 层3 facts 注入不分患者（`selectProjectionInputs` 传 `ctx.facts.all()`） | 患者 A 问诊可能注入患者 B 的事实，模型可能混淆归属 |
| P1 | 记忆分散：facts/articles/episodes 三个 VersionedStore + MemoryGraph 双写，无统一读取接口 | 上下文组装逻辑散落（projection / buildPersona / orchestrator 各读各的） |
| P1 | 提取时机固定"每 5 轮"（短会话永不提取，长会话重复提取） | 知识沉淀不完整 |
| P1 | 压缩是硬裁剪（#96），设计稿 R2（anchored compaction）未实现；压缩丢的旧信息无人工兜底 | 长会话早期关键信息信任度低 |
| P2 | gaps 无自动检测；persona 每轮全量重建 | 上下文浪费 |

### 1.2 目标

1. **单一事实源**：所有记忆通过 MemoryGraph 门面读写（会话上下文、提取、审核、注入同一接口）。
2. **人工审核闭环**：高影响记忆写入走"待审核队列 → 人工确认 → 版本化落库"，压缩/会话结束是主要触发点。
3. **会话/记忆分离**：session 是对话窗口；记忆按患者/全局/study 聚合，跨会话持久。
4. **患者隔离**：任何 scope 的上下文组装只注入本 scope 的记忆（+ 受控的跨 scope 补充）。
5. **有界且可追溯**：长会话压缩产出锚定摘要 + 待审核记忆，无静默丢失。

---

## 2. 总体架构

```
┌────────────────────────── 会话运行时 ──────────────────────────┐
│                                                               │
│  会话开始                                                      │
│    └─► MemoryGraph.readContext(scope) ──► systemPrompt       │
│          （层0 persona / 层0b 患者 / 层2 摘要 / 层3 facts）      │
│                                                               │
│  会话进行                                                      │
│    └─► 事件落库 → 增量提取（K1 游标 + K2 事件驱动）              │
│          └─ 全部提取结果 → pending 待审核队列（人工审核）        │
│                                                               │
│  压缩 / 会话结束                                               │
│    └─► MemoryGraph.summarize(sinceIdx)                        │
│          ├─ 锚定摘要（更新旧摘要，R2）→ 注入后续轮次             │
│          └─ MemoryProposal[] → pending 待审核队列              │
│                                                               │
│  审核（Today / Brain inbox，复用 #48/#49 UI）                   │
│    └─► applyApproved(id) → graph 新版本（可回滚）               │
│          └─► 下次 readContext 读到新内容                        │
└───────────────────────────────────────────────────────────────┘
```

**核心原则**：`readContext`（读）、`extract`（提）、`summarize`（总）、`applyApproved`（写）四个能力收敛在 MemoryGraph 门面上；会话只持有事件日志，不直接写记忆。

---

## 3. MemoryGraph 门面接口

```ts
// packages/server-ts/src/memory/memory-gateway.ts
export type MemoryScope = { patientHash?: string; studyId?: string; global?: boolean }

export interface ContextBundle {
  persona: string                 // 层0：偏好/目标/文章标题（K5 缓存）
  patient?: PatientContext        // 层0b：本患者图谱 findings
  episodes: EpisodeSummary[]      // 层2：本 scope 的摘要（K3 增量摘要）
  facts: FactView[]               // 层3：本 scope 的 facts（注意力排序）
  skills: SkillView[]             // 层4：技能指引
}

export interface MemoryProposal {
  id: string
  scope: MemoryScope
  kind: 'fact' | 'article' | 'episode_summary' | 'compaction_summary'
  content: string
  importance: number              // 1-5
  sourceEventRange?: { fromIdx: number; toIdx: number }
  confidence: 'high' | 'medium' | 'low'
  reason: string                  // 提取依据/摘要依据
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

export interface MemoryGraphGateway {
  // 会话开始：按 scope 组装上下文（数据源=graph，替代/增强现有 projection）
  readContext(scope: MemoryScope, opts?: { routes?: Intent }): Promise<ContextBundle>

  // 压缩或会话结束：总结增量事件 → 锚定摘要 + 待审核记忆
  summarize(scope: MemoryScope, sinceIdx: number): Promise<{
    summary: EpisodeSummary
    proposals: MemoryProposal[]
  }>

  // 待审核队列
  listPending(scope?: MemoryScope): Promise<MemoryProposal[]>

  // 审核通过：版本化更新 graph（走 approval 状态机）
  applyApproved(proposalId: string, actorId: string): Promise<MemoryNode>

  // 审核拒绝：记录原因，不落库
  rejectProposal(proposalId: string, reason: string): Promise<void>

}
// 注：所有记忆写入（fact/article/episode_summary/compaction_summary）
// 一律经 propose → pending → applyApproved，不设直写路径。
```

### 3.1 现有基础设施映射

| 能力 | 现有 | 变更 |
|---|---|---|
| 版本化节点 | `MemoryGraph`（version/status/snapshot/restore） | 直接复用，`applyApproved` 写新版本 |
| 封装层 | `MemoryService.addFact/addArticle` | 保留为内部实现，门面统一暴露 |
| 提取 | `ChatIngester.ingestEncounter`（只写事件） | 改为写 pending（分流见 §5） |
| 审批 | `approval_requests`（targetType 声明支持 'Fact'，`applyTargetUpdate` 未实现） | 实现 Fact/Article target（§7） |
| 上下文组装 | `MemoryProjection.project()` + `buildPersona` | `readContext` 成为其数据源（§4） |
| 待审核 UI | Today widget（#49）+ Brain inbox（#48） | 复用，展示 MemoryProposal |

---

## 4. 会话上下文组装（readContext）

### 4.1 三种 scope

| scope | 触发 | 注入内容 |
|---|---|---|
| `{ patientHash }` | 患者问诊 chat | 本患者 facts（**预算内全给本患者**）+ 图谱 findings + 本患者 episodes + persona |
| `{ global }` | 全局 chat | 全用户 facts（按患者分组标注）+ 全局 episodes + persona + roster |
| `{ studyId }` | 科研 chat（未来） | 本 study facts（`fact.studyId` 匹配）+ 协议上下文 |

### 4.2 患者隔离（P0 修复）

层3 facts 注入规则：

```
scope.patientHash 存在时:
  1. 本患者 facts（patientHash 匹配）→ 优先，预算内全量
  2. 跨患者 facts → 仅 importance ≥ 4 且预算剩余 > 30% 时少量补充
     （支持"医生对比患者"场景），渲染带 [patient: 名称] 标记
scope.global 时:
  全部 facts 按 patientHash 分组渲染: [patient: ZQ] ... / [general] ...
scope.studyId 时:
  仅 studyId 匹配 + 关联患者 facts（经入组关系）
```

**渲染格式**（`formatFact` 升级）：

```
[lab ★★★] [patient: ZQ] WBC 11.2 偏高 (3d ago)
[fact ★★] [general] 患者偏好避免阿片类 (10d ago)
```

### 4.3 与 R1（#98 增量更新）的关系

`readContext` 的每个组成部分（persona/patient/episodes/facts）即 R1 的 typed Context Source：
- 首轮：`readContext` 全量 baseline（快照落库）
- 后续轮：hash 对比 → 变更源以增量 system 消息追加（无变更完全复用）
- **提取管道（§5）是变更生产者**：facts 落库 → source 版本号变化 → 下一轮增量更新


### 4.4 会话管理（多会话 + 开启/关闭）

会话是对话窗口，记忆按 scope 聚合跨会话持久。**多会话仅用于跨患者全局 chat
（scope='global'）；患者问诊 chat 保持单会话（每个患者一个固定会话）。**

```
Session 实体（扩展现有 nexus_sessions 表）:
  id / userId / scope ('global' | 'patient')
  patientHash?                    // scope 为 patient 时（固定一个/患者）
  title                           // 全局会话可命名（如"肺癌研究讨论"）
  status ('open' | 'closed')
  extractedUptoIdx                // 提取游标（§5.1），随会话推进
  createdAt / closedAt / lastMessageAt

scope 规则:
  global: 一个用户可有多个会话，显式开启/关闭/切换
  patient: 每患者一个固定会话（现有 patient-{hash} 语义保留），
           关闭患者会话 = 结束问诊（仍触发 summarize，但不可新建多会话）
  study:  暂不开放（科研 chat 落地后再评估）

生命周期（global 会话）:
  开启: "新建会话" → POST /api/v1/sessions（title, scope=global, status=open）
  进行: 消息写入该 session 的事件日志；提取游标按 session 推进
  关闭: "关闭会话" → status=closed（不可再写）
        → 触发 summarize(sinceIdx) → proposals 进 pending（§6 闭环）
        → 记忆沉淀到 scope（不依赖会话存在）

兼容: 未选择会话时回退默认全局会话（global-{userId}），行为与现状一致
```

**关键点**：关闭会话是"会话结束"的明确信号——它触发 summarize → pending 审核，
取代现在"压缩时才总结"的隐式时机。压缩（长会话中途）与关闭（会话终点）走同一条
summarize 路径。患者会话的"关闭"仅作为问诊结束的总结时机，不引入多会话管理。

### 4.5 写入时 embedding + 读取时语义检索（与 gateway 的关系）

embedding **不是平行系统，而是 MemoryGraphGateway 的内部实现细节**——对上层透明。

```
写入（审核通过后）:
  applyApproved(proposal)
    → MemoryService.addFact()            → graph 节点 v1（版本化）
    → EmbeddingIndex.upsert(nodeId, embed(content))   ← 写入时 embedding
  - 模型: bge-m3（本地服务，1024 维）
  - 存储: vector_index 表（sqlite-vec，per-user 分区）
  - 版本联动: fact 编辑 → contentHash 变化 → embedding 重算（旧版本保留审计）
  - 只给 facts/articles 建向量；documents 走文件引用

读取（按需语义检索，Tier 2）:
  retrieve(scope, query)
    → embed(query)                        ← 查询实时 embed（同模型）
    → 与 scope 内向量余弦相似度 top-k（患者隔离: 默认只搜本 scope）
  - search_node 工具升级: substring → 余弦相似度
  - 基线 readContext（Tier 1）不经过 embedding

维护:
  删除 → embedding 标记 superseded
  语义去重（写入前）: propose 时 embed(content) 与 scope 内已有
    事实相似度 > 0.95 → 标记重复，跳过审核队列
```

**embedding 解决什么**：语义等价召回（"药物过敏史"↔"对磺胺过敏"、同义表达）、
相关度排序（top-k 截断）、无分词依赖。**不替代**：attention 基线（重要性/新近度）、
患者 scope 过滤、压缩摘要——互补不冲突。

**与统一接口的关系**：

```
MemoryGraphGateway（唯一接口）
├── readContext(scope)        → 基线，无 embedding
├── retrieve(scope, query)    → 内部: embed(query) + cosine top-k   ← 新增（或升级 search_node）
├── propose() → pending → 审核
├── applyApproved(proposal)   → 内部: 写 graph 节点 + upsert embedding（同一次操作）
├── listPending / rejectProposal
```

关键约束：**没审核过的事实不会进入语义检索**（propose 不建向量，applyApproved 才建）——
保证 RAG 只检索可信记忆。R1（hash 增量）与 R2（压缩摘要）不依赖 embedding。

---

## 5. 记忆提取管道（K1–K6 修订版）

### 5.1 增量游标 + 事件驱动（K1+K2，#109 保持不变）

- 每个 scope 持久化 `extractedUptoIdx`；每次只提取新增事件段
- 触发：增量内容 ≥ 300 字符，或含关键信号（记住/诊断/方案）；2s 去抖合并

### 5.2 全部人工审核（修订 #109）

```
提取结果（extractClinicalEntities / deepseek 提取），无论置信度高低:
  → MemoryProposal → pending 队列（人工审核）
审核通过 → applyApproved → graph 版本化更新
```

**理由**：记忆是长期临床事实，任何自动写入（即使高置信度）都存在不可逆风险；
审核成本通过批量确认 UI（Brain inbox）控制。

### 5.3 Episodes 增量摘要（K3，#110）

- 会话进行中：每轮以增量段 + 旧摘要 → flash 模型更新 scope 级摘要（替换 `slice(0,150)` 占位）
- 会话级摘要（`episode_summary`）与压缩摘要（`compaction_summary`）**均进 pending**；
  不确认的摘要仅用于本轮上下文，不写入长期记忆

### 5.4 Article 合成（K4，#110）

- 同类别新增 facts ≥ 3（以 `sourceFactStableIds` 为增量键）
- 合成结果 **一律进 pending**（文章是陈述性知识，误合成影响大）

### 5.5 Persona 缓存（K5，#111）

- facts/articles commit 版本变化才重建；无变化复用

### 5.6 Gap 自动检测（K6，#111）

- 问题形态消息未被 facts 覆盖 → 自动创建 gap（7 天去重）

### 5.7 矛盾检测与取代（fact 非孤立原则 + 同 scope 规则）

**Fact 不是孤立的：每条 fact 必须携带 scope 标识（patientHash / studyId /
global），一切"相关/冲突/取代"判定都只在同一 scope 内进行。**

- 跨患者永不构成矛盾：患者 A「青霉素过敏」与患者 B「青霉素可用」是两条独立
  事实；提取注入、冲突检测、审批取代均以 scope 为边界
- 提取时（Tier 1/2/3 共用）：注入的"已有 facts"上下文仅含同 scope facts
  （跨患者 facts 一律排除）；LLM 输出每 fact 可带 `conflictsWith`（指向
  context 中同 scope 的已确认 fact）
- propose 时：`conflictsWith` 必须通过 scope 校验，跨 scope 标记丢弃
- 审批时（applyApproved）：批准带 `conflictsWith` 的 proposal → 对同 scope
  冲突旧 fact 执行 supersede（版本机制保留历史，`supersedes` 关系 + 审计）；
  **批准即人工裁决**——只有用户批准，新 fact 才取代旧 fact
- 语义去重（≥0.95）只挡重复，不挡矛盾；矛盾检测由 LLM + 审批闭环完成

---

## 6. 长会话压缩（R2 修订版 — 对接审核闭环）

### 6.1 触发

```
estimate(system + messages + tools) > MODEL_CONTEXT_WINDOW - max(output, buffer)
  buffer 默认 20k；MODEL_CONTEXT_WINDOW 默认 32768（env 可配）
```

### 6.2 锚定摘要（保留 opencode 模式）

- 摘要消息带 `summary + recent` 两字段；下次压缩**更新旧摘要**而非重建
- 保留最近 `HISTORY_KEEP_TOKENS`（默认 8k）原文逐字，更早部分进摘要；中间消息可拆分（prefix 进摘要 / suffix 保留）
- 模板（临床版）：

```
## Objective
## 患者重要信息        （标识、诊断、关键数值）
## 决策与理由
## 已完成
## 进行中
## 阻塞
## 下一步
## 相关文件与检查
```

### 6.3 压缩产物（修订核心）

```
压缩 = 锚定摘要（注入后续轮次）
     + MemoryProposal[]（进 pending，人工审核）
```

- 压缩时从被裁剪的旧轮次中提取**未沉淀过的事实**（以 extractedUptoIdx 为基准，取已提取之外的部分）→ 生成 proposals
- 摘要本身作为 `compaction_summary` proposal 进入 pending（医生可确认"此摘要可信"；不确认则仅用于本轮上下文，不污染长期记忆）
- 工具结果序列化截断 2000 字符（T1 同款）

### 6.4 失败兜底

- 摘要 LLM 失败 → 静默跳过，保留硬裁剪（#96 现有行为）
- pending 写入失败 → 仅记录，不影响会话

---

## 7. 待审核队列与审批

### 7.1 数据模型

```prisma
model MemoryProposal {
  id            String   @id
  userId        String
  scopeType     String   // 'patient' | 'global' | 'study'
  patientHash   String?
  studyId       String?
  kind          String   // fact | article | episode_summary | compaction_summary
  content       String
  importance    Int      @default(3)
  confidence    String   // high | medium | low
  reason        String?
  sourceRange   String?  // "fromIdx..toIdx"
  status        String   @default("pending") // pending | approved | rejected
  rejectedReason String?
  createdAt     String
  resolvedAt    String?
  resolvedBy    String?
}
```

### 7.2 审批状态机

- 复用 `approval_requests` 的语义（pending → approved/rejected + audit log），
  `applyTargetUpdate` 增加 `Fact` / `Article` 分支：
  - Fact：`memoryGraph.updateNode`（新版本，`sourceProposalId` 溯源）
  - Article：`addArticle`（sources 记录）
- 审计：`writeAuditLog`（action `memory.approved` / `memory.rejected`）
- 权限：复用 #105（T2 规则集）的能力——默认"本人可审自己 scope 的记忆"，admin 可审全部

### 7.3 UI

- Today widget（#49）与 Brain inbox（#48）扩展一个 tab/筛选："记忆待审核"（kind 徽标 + 置信度 + 来源轮次）
- 拒绝原因**可选**（#149 后放开：空原因允许拒绝，审计留痕为 null）
- 审批后 memory-graph 页（`memory-graph.tsx`）可见新版本（现有版本化展示直接受益）

---

## 8. 与既有 issues 的映射

### 8.1 需修订的 issue

| Issue | 修订内容 |
|---|---|
| #99（R2 锚定压缩） | 压缩产物增加 MemoryProposal 审核出口（§6.3）；摘要模板改临床版 |
| #109（K1+K2） | 提取结果一律进 pending（§5.2 全部人工审核），无直写路径 |
| #110（K3+K4） | Article 合成结果进 pending（§5.4）；摘要改为 scope 级（§5.3） |
| #98（R1） | 数据源明确为 `readContext`（§4.3）；patient/context source 支持按提及动态加载（全局会话） |

### 8.2 新建 issue

| Issue | 内容 | 优先级 |
|---|---|---|
| #112 | MemoryGraph 门面：`readContext/summarize/listPending/applyApproved/rejectProposal` + 层3 患者隔离（§3+§4） | ✅ 已完成 |
| #113 | 审批系统补 Fact/Article target + MemoryProposal 表 + 审计（§7） | ✅ 已完成 |
| #114 | 压缩/会话结束 → summarize → pending 闭环（§6，与 #99/#109 联动） | ✅ 已完成 |
| #115 | 多会话管理：Session scope/status 扩展 + 前端会话列表/切换/新建/关闭（§4.4） | ✅ 已完成 |

### 8.3 会话运行时/UI 项（正交）

#100–#108（U1/U2/U3/T1/T2/T4/S1/U4U5O3）为纯会话运行时/UI 项，与本设计正交。
已完成：#99 R2 锚定压缩、#100 U1 流式渲染、#101 T1 工具输出限量、#102 R3 工具持久化、
#103 U3 上下文用量 UI、#109–#111 K1–K6。剩余：#98 R1、#104 U2、#105 T2、#106 S1、#107 T4、#108 U4U5O3。

---

## 9. 实施计划

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| G.1 | MemoryProposal 表 + 门面接口骨架（readContext 先接现有 stores） | — | ✅ |
| G.2 | 审批系统 Fact/Article target（`applyTargetUpdate` + 审计） | G.1 | ✅ |
| G.3 | 层3 患者隔离 + readContext 接入 chat（替换 selectProjectionInputs 数据源） | G.1 | ✅ |
| G.4 | 提取管道改造：全部提取结果进 pending（#109 修订） | G.1–G.2 | ✅ |
| G.5 | 压缩闭环：summarize → pending（#99/#114） | G.2, #99 | ✅ |
| G.6 | UI：Brain inbox 记忆 tab + Today 入口（复用 #48/#49） | G.2–G.5 | ✅ |
| G.7 | 多会话管理：后端 scope/status + 前端列表/切换/关闭（#115） | G.5 | ✅ |

总计约 13 个工作日。G.1–G.3 为 P0（门面 + 隔离 + 审批），可先于压缩落地。

---

## 10. 测试计划

| 层 | 用例 |
|---|---|
| 单测 | 门面接口各方法；提取结果全部进 pending（无直写）；患者隔离过滤（本患者全量/跨患者限量/标记）；审批 Fact target 状态流转 + 审计；proposal 幂等（同范围不重复） |
| 集成 | 模拟 60 轮会话 → 压缩触发 → 断言：锚定摘要注入 + proposals 进 pending + graph 未直接变更；审核通过 → graph 新版本 + 下次 readContext 可见 |
| 隔离测试 | 患者 A 会话中注入的 facts 集合与患者 B 无交集（跨患者仅限 importance≥4 且带标记） |
| 会话管理 | 同 scope 多会话并行；关闭后不可写；关闭触发 summarize→pending；默认会话兼容 |
| 回归 | 现有 364+ 用例；`/api/v1/agent/chat` SSE 兼容性 |

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 审核负担过重 | 全部记忆进审核是设计决策（临床合规优先）；通过 Brain inbox 批量确认 + 优先级排序（importance 降序）控制负担 |
| 压缩摘要进入 pending 但医生长期不审 | 摘要不审仅影响长期记忆，不影响本轮上下文；Brain inbox 提供批量确认 |
| 门面改造破坏现有注入 | G.3 先做"数据源替换"（readContext 内部仍调现有 stores），行为差异用测试锁定 |
| 患者隔离误伤"对比患者"场景 | 显式放行：importance≥4 + 预算余量 + 患者标记渲染 |
| 双写（graph + stores）过渡期不一致 | readContext 为唯一读路径后，stores 降级为 graph 的兼容视图（#21 迁移时收敛） |

---

## 12. 与 KB v2.2 设计的关系

- KB 的 T+0s/T+1s/T+30s 管道（takeaway/facts/articles）在本设计中对应：
  takeaway = 即时 UI（不变）；facts = §5 提取管道；articles = §5.4（进 pending）
- KB 的"分层加载 expand()"（§4.3）与 S1 合并为按需加载工具族（#106 已修订）
- 本设计补齐了 KB v2.2 缺失的**审核环节**——知识从"自动沉淀"升级为"自动建议 + 人工确认"

---

## 13. 记忆系统优化设计（Phase 3 — 治理与正确性）

> 在 G.1–G.7（审核闭环已上线）基础上，针对运行中暴露的三个正确性缺陷与
> 审计缺口，分三层治理。**核心原则：未审核信息永不跨会话/跨范围泄漏；
> 已确认信息的选择逻辑可控、可量化、可反馈。**

### 13.1 现状缺陷（核对代码确认）

| # | 缺陷 | 位置 | 影响 |
|---|------|------|------|
| F1 | **全局 persona 混入患者 facts**：`buildPersona` 用 `facts.all()` 无 scope 过滤 | `user-context.ts buildPersona` | 患者 A 的偏好进入全局 persona，影响所有会话（正确性 + 隐私） |
| F2 | **topFacts 按 `count`（旧注意力计数）排序**，非 importance × recency | 同上 | 关键事实可能被挤出 persona，陈旧事实滞留 |
| F3 | **Article 触发粗糙**：同类目 ≥3 未使用即合成，无时间窗口/聚类 | `knowledge-synthesis.ts maybeSynthesizeArticle` | 频繁合成低质量文章，pending 噪声 |
| F4 | **审计缺口**：pending 无超期治理；无接受率/引用率/矛盾率指标反馈 | 审批系统 | 无法量化记忆质量，无法驱动提取优化 |
| F5 | **persona 整体缓存**：任一 fact 变化全量重建 | `buildCachedPersona` | 与 R1（#98 增量更新）目标冲突的中间态 |

### 13.2 第一层：正确性修复（低成本，优先）

**A. Persona 患者隔离（修 F1）**

```
全局 persona 只取无 patientHash 的 facts：
  prefs/goals/topFacts ⊆ facts.all().filter(f => !f.patientHash && !f.studyId)

患者相关 facts 仅经 isolateFactsByScope（§4.2）在患者会话注入，
全局会话不注入任何患者 facts（含"对比患者"场景的显式放行规则不变）。
```

- 患者级偏好（如"患者 A 拒绝某方案"）不进全局 persona；医生级偏好（"该医生先看 CT"）正常保留
- 变更点：`buildPersona` 增加 scope 过滤 + 单测锁定

**B. topFacts 排序改 importance × recency（修 F2）**

```
score(f) = importance(f) × e^(-0.3 × daysAgo(f))
取 top 5；依赖 facts 的 lastSeenAt/createdAt（已存在）
```

- 复用 `context-compressor.ts` 的 `attentionScore` 语义，抽为共享函数
- 效果：近期高重要性事实优先，陈旧低价值事实自然退出

**C. Article 触发加时间窗口与聚类（修 F3）**

```
触发条件（AND）：
  1. 同 scope 同类目未使用 facts ≥ 3
  2. 其中 ≥3 条为最近 7 天确认（createdAt ≥ now-7d）
  3. 可选：embedding 相似度 ≥ 0.7 聚类（同主题才合成，避免拼盘文章）

触发后：合成 → pending（§5.4 不变）
```

- 变更点：`maybeSynthesizeArticle` 增加时间窗口过滤；聚类为可选增强（Phase 3 后期）

### 13.3 第二层：审核体验（中成本）

**D. Pending 超期治理**

```
生命周期：
  pending 超 7 天：
    importance ≥ 4 → 保持 pending，Brain inbox 置顶 + 高亮"待关注"
    importance ≤ 2 → 自动归档为 'stale'（不删除，可手动恢复）
    （摘要是 'episode_summary'/'compaction_summary' 的 → 7 天未审自动归档）
```

- 变更点：MemoryProposal 增加 `archivedAt` 字段（或复用 status），
  每日定时任务（复用 evolution worker）执行归档

**E. Brain inbox 分组与批量确认**

```
pending 按 scope 分组展示：
  患者视图：同一患者的所有 pending（facts + 摘要）归组
  全局视图：医生偏好/知识类归组
组内批量确认（复用现有 confirmIds 批量能力）
```

**F. 提取质量反馈（闭环）**

```
按 category × sourceType 统计 7 天接受率：
  接受率 < 30% 的类别 → 提取 prompt 注入"近期该类别误报较多，请更严格"提示
  接受率 > 90% 且数量多 → 提示"可适当增加该类别输出"
```

- 变更点：`extractAndProposeFacts` 的 prompt 增加动态规则段；
  统计数据来自 auditLog（已存在，需增加 category 维度）

### 13.4 第三层：审计治理（中高成本，与 R1 联动）

**G. 记忆健康仪表盘**

```
指标（全部来自现有 telemetry + auditLog）：
  接受率     approved / (approved + rejected)    （按类别/来源）
  引用率     graph facts 在 chat 上下文注入中的命中次数 / 事实总数
  矛盾率     7 天内 conflictsWith 标记数
  超期数     当前 stale/超期 pending 数
展示：Admin 或 Brain 页新增"记忆健康" tab
```

**H. Persona 分段缓存（修 F5，R1 的前置）**

```
persona 拆为独立段，每段独立版本指纹：
  prefs / goals / topFacts / knowledge
任一版本变化 → 仅重建对应段（§4.3 R1 的增量注入的雏形）
```

### 13.5 数据模型变更

```prisma
// MemoryProposal 增加：
archivedAt     String?   // 超期归档时间（第二层 D）
category       String?   // 提取类别（质量反馈 F 的统计维度，propose 时已带 reason 可解析）

// auditLog 已含 targetType/targetId/actor，无需扩展
```

### 13.6 测试计划

| 层 | 用例 |
|---|---|
| 单测 | persona 隔离：患者 fact 不进全局 persona；医生偏好保留；topFacts 按 importance×recency 排序；article 触发：7 天窗口过滤、聚类过滤 |
| 集成 | 超期归档：mock createdAt 8 天前 → 低重要性自动归档、高重要性置顶；质量反馈：mock 拒绝率 → prompt 动态段出现 |
| 回归 | 现有 434+ 用例；persona 缓存指纹（版本变化才重建）不破坏 |

### 13.7 实施计划

| 项 | 内容 | 优先级 | 预估 |
|---|---|---|---|
| 13.2A | Persona 患者隔离 | P0 | 0.5d |
| 13.2B | topFacts 排序优化 | P0 | 0.5d |
| 13.2C | Article 时间窗口 | P1 | 1d |
| 13.3D | Pending 超期治理 | P1 | 1.5d |
| 13.3E | Inbox 分组批量 | P2 | 1d |
| 13.3F | 提取质量反馈 | P2 | 1.5d |
| 13.4G | 记忆健康仪表盘 | P3 | 2d |
| 13.4H | Persona 分段缓存（并入 R1 #98） | P2 | 与 R1 合并 |

---

## 14. 修订历史

| 版本 | 内容 |
|---|---|
| v2.0 | 初始设计（G.1–G.7） |
| v2.1 | 矛盾检测与取代（§5.7）；Tier 1 信号收缩；压缩 delayed-sync；episodes 会话隔离 |
| v2.2 | §13 记忆系统优化设计（Phase 3 治理）；修订 §7.3 拒绝原因可选、§8/§9 完成状态 |
