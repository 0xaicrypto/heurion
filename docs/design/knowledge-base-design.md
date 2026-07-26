# Heurion 产品设计 v2.2 — 个人知识库 + 持续学习 Agent + 自主进化

**Status:** Design proposal (v2.2 — extended)  
**更新:** 2026-07-23  

---

## 1. 产品愿景

每个 Heurion 用户拥有一个**持续进化的个人知识库**。用户在平台上进行的每一次对话、上传的每一份文件、确认的每一个临床发现，都在让这个知识库变得更强。这个知识库不仅是"记忆"，更是**可检索、可溯源、可演进的第二大脑**。

---

## 2. 核心架构：四层知识积累

```
┌─────────────────────────────────────────────────┐
│              Agent Persona                       │  ← 动态合成
│  每次聊天前从下层数据自动生成身份与偏好描述          │
└────────────────────┬────────────────────────────┘
                     ↑
┌────────────────────┴────────────────────────────┐
│              Knowledge 层                        │  ← 深层知识
│  跨会话提炼的长篇文章，由 ≥3 条 Facts 触发合成      │
│  版本化，可手动编辑，可溯源到源文件和对话             │
│  当依赖的 Fact 更新 → 标记 stale → 触发重新合成     │
└────────────────────┬────────────────────────────┘
                     ↑ 证据充足后自动提炼
┌────────────────────┴────────────────────────────┐
│              Facts 层                            │  ← 结构化片段
│  类型: preference / fact / constraint / goal     │
│  来源: chat提取 / 文件解析 / Takeaway确认          │
│  重要性 1-5, TTL, 可回滚                          │
│  去重策略: 同content合并 count++, importance++     │
│  衰减: importance × e^(-0.1 × days)               │
└────────────────────┬────────────────────────────┘
                     ↑ 提取层
┌────────────────────┴────────────────────────────┐
│              原始输入层                           │
│  ┌──────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ 对话      │  │  文件       │  │ Takeaway    │  │
│  │ EventLog │  │ SHA-256去重 │  │ 每轮即时提炼 │  │
│  │ 完整审计   │  │ 全文索引    │  │ 可确认/拒绝  │  │
│  └──────────┘  └────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────┘
```

### 2.1 每层定义

| 层 | 存储 | 触发时机 | 用户可见 |
|---|---|---|---|
| **原始输入** | EventLog (JSONL), Prisma (files/dicom) | 每次对话/每次上传 | 对话历史, 文件列表 |
| **Facts** | 文件系统 `v{N}.json` (VersionedStore) | 每轮chat, 文件提取, Takeaway确认 | Facts 列表 |
| **Knowledge** | 文件系统 `v{N}.json` (KnowledgeStore) | ≥3 同主题 Facts → LLM 合成 | Knowledge 文章列表 |
| **Persona** | 不存储，每次对话动态合成 | 每次 chat 前 | 不可见（注入到 system prompt）|
| **Takeaway** | Prisma ChatTakeaway 表 | 每轮 chat | Chat 面板 + Home 推送 |

### 2.2 提取管道

```
Chat/Upload 触发
  ↓
┌─ T+0s: Takeaway → UI 即时展示（"📌 患者ZL胸痛3周，建议CT"）
├─ T+1s: Facts → LLM提取 → 去重 → 存入 FactsStore
├─ T+30s: Knowledge → 检测同category Facts≥3 → LLM合成
└─ T+∞:  衰减 → 30天未访问的Facts自动降低权重
```

---

## 3. 查询路由（Router First — P3 提前至核心链路）

### 3.1 为什么 Router 要提前

传统"并行检索"（每次查询同时触发向量+图+SQL）有两个致命问题：
- **计算浪费**：80% 的查询只需要单路检索，并行三路白白消耗算力
- **上下文噪声**：过量无关信息干扰 LLM，造成"刺猬肚子里塞满了无关草料"

正确做法：**先路由，再检索**。一个轻量 Router 在 50ms 内决定走哪条路。

### 3.2 路由决策树

```
用户提问
  ↓
  ┌─ 分类器（规则层: keyword + pattern，<5ms）
  │   ├─ "ZL 的年龄/姓名/性别？"
  │   │   → 结构化查询 (SQL)
  │   ├─ "#文件 CT报告"
  │   │   → 文件索引查询 (FileIndex)
  │   ├─ "XX指南怎么说？"
  │   │   → 向量检索 (Knowledge/Facts)
  │   ├─ "搜索知识库/记住/这个很重要"
  │   │   → 显式知识库命令 (Explicit KB Command)
  │   └─ 以上都不匹配
  │       ↓
  └─ 分类器（LLM 轻量层: 单次调用，<200ms）
       ├─ 意图: factual_query → SQL
       ├─ 意图: semantic_search → 向量检索
       ├─ 意图: relational_query → 图遍历
       ├─ 意图: knowledge_command → 显式知识库命令
       └─ 意图: mixed → SQL + 向量 + 图 → RRF 融合
```

**性能指标**：
- 简单查询延迟: <10ms (规则命中)
- 复杂查询延迟: <250ms (LLM 分类 + 检索)
- 并行检索减少: ~70% 的查询单路即可满足

### 3.3 成本控制的实现策略

为控制运行成本，Router 采用 **规则优先、LLM 兜底** 的两层架构：

1. **规则层命中 80% 以上查询，零 LLM 成本**
   - 关键词映射（年龄、姓名、CT、化验、指南、总结、搜索）
   - 正则模式匹配（患者 ID、文件引用、时间范围）
   - 当前会话缓存：同一 session 内相似问题直接复用路由结果

2. **LLM 层仅处理模糊或混合意图**
   - 使用便宜模型（如 DeepSeek-chat / gpt-4o-mini）做分类
   - 输入仅包含用户问题 + 当前 session 类型，输出 JSON：`{ intent, sources[], confidence }`
   - confidence < 0.7 时降级为 "mixed"，走安全兜底检索

3. **Source-level 白名单**
   - 每个意图只打开必要的 source，避免全量注入
   - 例：factual_query 只注入 patient SQL 结果，不检索 Facts/Knowledge

4. **成本对比估算**

| 方案 | 每轮平均 LLM 调用 | 平均注入 Token | 说明 |
|---|---|---|---|
| 现状（全量注入）| 1 | ~3,500 | 所有 source 都注入 |
| Router（规则优先）| 1 + 0.2 次分类 | ~1,800 | 80% 查询规则命中 |
| Router + 上下文压缩 | 1 + 0.2 次分类 | ~900 | 进一步压缩注入 |

> 结论：Router 在提升质量的同时，**反而能降低上下文 token 成本**。

### 3.4 显式知识库命令（Explicit KB Commands）

除了 Router 的自动决策，系统支持用户主动触发知识库操作。这些命令**按需触发，不增加日常对话基线成本**。

#### 支持的命令

| 用户表达示例 | 命令类型 | 系统行为 | 成本 |
|---|---|---|---|
| "搜索我的知识库关于 NSCLC" | `kb_search` | 向量检索 Knowledge + Facts，返回摘要 | 1 embedding + 1 次总结 LLM |
| "记住：ZQ 对 osimertinib 不耐受" | `kb_remember` | 立即提取 Fact，写入 `FactsStore` | 1 次小 LLM 提取 |
| "根据我的知识库总结 EGFR 治疗经验" | `kb_summarize` | 检索相关知识 → 生成综述 | 1 检索 + 1 生成 LLM |
| "这个很重要，存到知识库" | `kb_remember` | 提取当前上下文/文件为 Fact | 1 次小 LLM 提取 |
| "查看我的未解问题" | `kb_gaps` | 返回 Knowledge Gap 列表 | 仅数据库查询 |
| "解答这个 gap" | `kb_resolve_gap` | 用户补充答案，更新 Gap 状态 | 1 次数据库更新 |

#### 实现位置

```
chat.orchestrator.ts
  ↓
Router 识别到 knowledge_command
  ↓
调用 KnowledgeCommandHandler
  ├─ kb_search → memory-projection.ts + embedding search
  ├─ kb_remember → factExtractor.ts (immediate mode)
  ├─ kb_summarize → retrieve facts → LLM summarize
  ├─ kb_gaps → KnowledgeGapService.list()
  └─ kb_resolve_gap → KnowledgeGapService.resolve(gapId, answer)
```

#### 与被动 Facts 提取的关系

- **被动提取**：每 5 轮深度提取，适合自然对话中的潜在事实
- **主动命令**：用户明确要保存/查询时触发，补充被动提取的延迟和不足
- 两者写入同一个 `FactsStore`，共享置信度/人工确认流程

### 3.5 Knowledge Gap 用户可见化

Knowledge Gap 是系统自动识别的"未解问题"，是产品"自我进化"叙事的核心。该功能**实现成本低，运行成本几乎为零**。

#### 数据来源

- `detectGap` 在 chat orchestrator 中自动识别（已存在）
- 用户主动标记："我不知道这个"、"这个问题还没答案"
- Sidecar 输出反馈：生成报告时发现缺少关键数据

#### 数据模型

```prisma
model KnowledgeGap {
  id          String   @id @default(cuid())
  workspaceId String
  content     String   // 问题文本
  source      String   // chat / user / sidecar
  sourceId    String?  // 关联 chat_id / file_id
  status      String   // open / answered / ignored
  answerId    String?  // 关联 Fact/Knowledge id
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

#### API

```
GET  /api/v1/knowledge/gaps            # 列出 gaps
POST /api/v1/knowledge/gaps/:id/answer # 用户回答，转为 Fact
POST /api/v1/knowledge/gaps/:id/ignore # 忽略
```

#### UI 入口

- **Today Dashboard**: "未解问题" 卡片
- **Knowledge 页面**: 单独 "Gaps" tab
- **Chat**: 当系统识别到新 gap 时，显示 "记录为未解问题" 提示

### 3.6 Sidecar 输出回写知识库（选择性）

MedSci-Sidecar 生成的报告、文献分析、病例总结等输出，可能包含高价值医学事实。默认**不自动写入知识库**，避免无差别提取带来的成本。

#### 触发条件

| 场景 | 是否自动提取 | 说明 |
|---|---|---|
| 用户说 "把这份报告存到知识库" | 是（用户触发） | 成本低，价值明确 |
| 生成病例总结后，用户勾选 "保存发现" | 是（UI 触发） | 用户授权后提取 |
| 运行流行病学分析 | 否 | 数据量太大，需用户确认 |
| 默认 Sidecar 输出 | 否 | 避免每轮 Sidecar 都多一次 LLM 调用 |

#### 提取流程

```
Sidecar 输出（report / summary / analysis）
  ↓
用户触发 "保存到知识库" 或 UI 勾选
  ↓
factExtractor.ts（轻量 prompt）
  ↓
提取核心医学事实 → FactsStore
  ↓
置信度 < 0.85 → 进入人工确认队列
```

#### 成本分析

- 自动全提取：每次 Sidecar 调用后 +1 次 LLM（成本明显增加）
- 用户触发：按需付费，成本完全可控
- 推荐：**默认关闭，UI 显式开启**

---

## 4. 上下文工程：防止检索-生成鸿沟

### 4.1 问题

研究（AWS, 2025）指出，即使检索到完美上下文，LLM 也会因为位置衰减而忽略：
- 前 10% 位置: 85.5% 实体提取率
- 30%-40% 位置: 暴跌至 26.3%
- 无限堆砌 Facts/Knowledge 导致 Context Window Overflow

### 4.2 对策：三级压缩管道

```
原始检索结果（可能 5000 tokens）
  ↓
【第一级: 结构化排序】
  按重要性 × 新近度排序，取 top-20
  ↓                                        (~2000 tokens)
【第二级: 紧凑化表示】
  三元组 → 紧凑句子
  原始: "Patient ZL, hasFinding, RUL nodule 18mm, measuredIn, CT scan 2026-07-15"
  紧凑: "ZL: RUL nodule 18mm (CT 7/15, stable vs 4/10)"
  CEA 3.2 (normal, 7/15 Lab) "
  ↓                                        (~800 tokens)
【第三级: 去重合并】
  同实体多次出现 → 合并时间序列
  "RUL nodule: 18mm baseline 4/10 → 18mm stable 7/15"
  ↓                                        (~500 tokens)
注入 LLM context（前置位置，最高注意力区）
```

**效果**：节省 53% token 消耗（5000 → 500），同时保持语义完整性。关键信息放在 context 前 10% 位置。

### 4.3 分层加载策略

```
初始: 注入紧凑摘要（500 tokens）
  ↓
LLM: "需要查看 CT 报告全文？"
  → expand("CT scan 2026-07-15") → 注入原文（+800 tokens）
  ↓
LLM: "需要看到历史趋势？"
  → expand("RUL nodule timeline") → 注入时间序列（+300 tokens）
```

LLM 主动按需加载，而非一次性喂入所有数据。

---

## 5. 文件管理子系统

### 5.1 上传流程

```
用户选择文件
  ↓
前端计算 SHA-256 (Web Crypto API)
  ↓
后端: 查重 → 已有相同? →返回已有 file_id + "文件已存在"
  ↓ 无重复
后端: 存储磁盘 + 写 Prisma FileIndex
  ↓ (异步)
├→ 文本提取 (PDF/Word → fulltext → 存入 FileIndex.textContent)
├→ 结构化提取 (Lab → 数值, DICOM → quickScan findings)
└→ 关联 patient_hash → 自动注入该患者后续 Chats 上下文
```

### 5.2 文件索引字段

```prisma
model FileIndex {
  id          String  @id
  userId      String
  sha256      String         // 去重键
  name        String         // 原始文件名
  mime        String
  sizeBytes   Int
  patientHash String?        // 关联患者
  textContent String?        // 提取的全文（向量检索索引用）
  findings    String?        // 结构化发现 (JSON)
  createdAt   String
  deletedAt   String?
  
  @@index([userId, createdAt])
  @@index([sha256])
  @@index([patientHash])
}
```

---

## 6. 知识图谱构建（双轨抽取）

### 6.1 成本问题

纯 LLM 抽取（GPT-4o 级别）成本：
- 1000 份文档 × $0.01/次 = $10/次，月成本可达 $200+
- SAP 实证：轻量 NLP（依赖解析）可替代 94% 的抽取任务

### 6.2 双轨架构

```
文档/对话
  ↓
┌─ 轨1: 轻量NLP (depend-parse)
│  处理: 明确的主谓宾结构，标准医学术语
│  成本: 免费 (CPU)
│  覆盖: ~80% 的临床文本
│  输出: (实体, 关系, 实体, 置信度)
│
├─ 轨2: LLM 抽取
│  处理: 轨1 置信度 <0.7 的复杂句
│        多跳推理、隐含关系、缩写消歧
│  成本: $0.01/次
│  覆盖: ~15% 的文本
│
└─ 轨3: 人工校验
    处理: 轨2 置信度 <0.7 的边缘案例
    覆盖: ~5% 的文本
```

### 6.3 本体 Schema

```
实体
  Patient      (patient_hash, initials, age, sex)
  Finding      (node_id, type: diagnosis|lab|imaging|symptom, content, confidence)
  Medication   (drug_name, dosage, start_date)
  Procedure    (type, date, findings)
  Study        (study_id, title, protocol)

关系
  Patient → hasFinding → Finding
  Finding → measuredIn → Study
  Finding → comparedTo → Finding (时间维度, delta)
  Patient → takesMedication → Medication
  Patient → enrolledIn → Study
  Finding → supports → Finding (相关证据)
```

---

## 7. Knowledge 合成级联管理

### 7.1 问题

传统扁平存储：Fact 更新 → 依赖的 Knowledge 失效，但无感知。

### 7.2 依赖追踪

```
Knowledge#17: "NSCLC RUL nodule management"
  sources:
    - Fact#45: RUL nodule 18mm (CT 7/15)     ← 已更新为 19mm
    - Fact#46: CEA 3.2 (normal)
    - Fact#47: EGFR exon19 del

当 Fact#45 更新 (18mm → 19mm):
  1. 标记 Knowledge#17 状态: stale
  2. 标记相关 Facts: Fact#45 changed, Fact#46 unchanged, Fact#47 unchanged
  3. UI 显示: "⚠️ 此文章依赖的 Fact#45 已更新，内容可能过时"
  4. 用户可选: [重新生成] 或 [手动编辑]
```

### 7.3 数据结构

```typescript
interface KnowledgeArticle {
  id: string
  title: string
  body: string
  version: number
  status: 'current' | 'stale'
  sources: KnowledgeSource[]
  createdAt: number
  updatedAt: number
}

interface KnowledgeSource {
  type: 'fact' | 'file' | 'chat'
  id: string          // Fact ID / File SHA-256 / Chat event ID
  version?: number    // 依赖的 Fact 版本号
  content: string     // 快照：合成时的原始内容
}
```

检测 stale：
```
每 10 分钟扫描一次:
  FOR EACH KnowledgeArticle:
    FOR EACH source WHERE type='fact':
      当前 Fact.version !== source.version → stale = true
```

---

## 8. 实施路线图（修订版）

| Phase | 内容 | 前端 | 后端 | 状态 |
|---|---|---|---|---|
| **P0** | 基础链路: Facts去重 + 文件去重+索引 | Facts页 + 文件页 | SHA-256 + FileIndex | 🔴 |
| **P1** | Knowledge激活 + Takeaway写 | Knowledge页 + Takeaway UI | KnowledgeStore + 合成 | 🔴 |
| **P2** | Chat上下文增强: 文件注入 + Persona | Context Rail | 文件摘要 + Persona合成 | 🔴 |
| **P3** | Query Router ← 提前 | — | 规则分类 + LLM路由 | 🔴 |
| **P4** | 上下文压缩: 三级管道 | — | 排序+紧凑化+去重 | 🔴 |
| **P5** | 图谱: 双轨抽取 + 本体Schema | — | NLP解析 + LLM抽取 | 🔴 |
| **P6** | 向量检索: sqlite-vec 集成 | — | 语义搜索 Facts/Knowledge | 🔴 |
| **P7** | GraphRAG: 混合检索 + RRF融合 | — | 多路融合 + 重排 | 🔴 |
| **P8** | Knowledge 级联更新 | 文章 stale 状态 UI | 依赖追踪 + 自动标记 | 🔴 |
| **P9** | **外部化学习 (Nightly Agent)** | Review Inbox (待审核 Facts) | Gaps 队列 + 夜间搜索 + 双轨抽取 | ⭐ |
| **P10** | **动态工具引擎 (Auto-Tool)** | 自适应格式提示 + ToolStore | Coding Agent + 沙盒 + 工具注册 | ⭐ |

---

## 9. P9 — 外部化学习（Nightly Learning Agent）

### 9.1 问题

当前系统只从用户主动交互中学习（对话、上传）。如果用户的知识库在某个领域有盲区，系统无法自主填补。

### 9.2 架构：盲区探测 → 异步检索 → 人机确认

```
用户查询
  ↓
P3 Router 检索
  ├─ 命中 → 正常返回
  └─ 未命中（无相关实体/知识）→ 标记为 KnowledgeGap
       ↓
   KnowledgeGap Queue (Prisma model)
       ↓ (夜间或闲时)
   Nightly Agent 消费队列
       ├─ 搜索: PubMed / NCCN / 用户配置的指南源
       ├─ 下载文献 → P5 双轨抽取 → 候选 Facts
       └─ 存入 PendingFactsStore (status='pending')
            ↓
   用户次日登录 → Today Dashboard Inbox
    "昨晚发现 3 个知识盲区，为您提取了 5 条候选 Facts"
    [确认全部] [逐条审核] [忽略]
        ↓ 确认
    迁移到 FactsStore (status='active') → 触发 Knowledge 合成
```

### 9.3 安全约束

| 约束 | 说明 |
|---|---|
| **搜索源白名单** | 仅限配置的学术/临床源（PubMed, NCCN, UpToDate），不调用通用搜索 |
| **Pending 隔离** | PendingFact 独立存储，不与 Active Facts 混合 |
| **来源追溯** | 每条候选 Fact 标注 `source_url` + `source_excerpt` + `extraction_confidence` |
| **分级审核** | 高置信度+低风险 → 一键确认；低置信度+高风险 → 强制校验原文 |
| **不自动生效** | 用户未确认的 Pending Facts 永远不会进入知识库 |

### 9.4 数据结构

```typescript
interface KnowledgeGap {
  id: string
  userId: string
  query: string          // 原始查询
  context?: string       // 上下文（哪个患者、哪篇文章）
  detectedAt: string
  resolvedAt?: string    // 夜間 Agent 处理后
  candidateCount?: number
  status: 'pending' | 'resolved' | 'dismissed'
}

interface PendingFact {
  id: string
  userId: string
  gapId: string
  category: 'preference' | 'fact' | 'constraint' | 'goal' | 'context'
  content: string
  importance: number      // 1-5
  confidence: number      // 0-1, 抽取置信度
  risk: 'low' | 'medium' | 'high'
  sourceUrl: string
  sourceExcerpt: string
  status: 'pending' | 'confirmed' | 'rejected'
  createdAt: string
}
```

### 9.5 UI：Review Inbox

```
┌──────────────────────────────────────────┐
│  📨 Review Inbox (3 pending)      [全部]  │
├──────────────────────────────────────────┤
│  🟢 Low Risk                             │
│  "NSCLC NCCN 指南已更新至 v5.2026"        │
│  来源: nccn.org/guidelines/nsclc         │
│  置信度: 0.95  风险: low                 │
│  [✓ 确认]  [✗ 拒绝]                      │
│                                          │
│  🟡 Medium Risk                          │
│  "Osimertinib 推荐剂量 80mg daily"       │
│  来源: pubmed.ncbi.nlm.nih.gov/38901234   │
│  置信度: 0.82  风险: medium              │
│  [查看原文] [✓ 确认] [✗ 拒绝]             │
│                                          │
│  🔴 High Risk                            │
│  "PD-L1 ≥ 50% 单药免疫优于联合化疗"       │
│  来源: pubmed.ncbi.nlm.nih.gov/38912345   │
│  置信度: 0.71  风险: high                │
│  ⚠️  请校验原文后手动确认                  │
│  [查看原文] [手动确认] [✗ 拒绝]            │
└──────────────────────────────────────────┘
```

---

## 10. P10 — 动态工具引擎（Auto-Tool Creation）

### 10.1 问题

当前系统处理文件格式是硬编码的（PDF/Word/DICOM）。遇到未知格式直接报错，无法自适应。

### 10.2 架构：异常触发 → Coding Agent → 沙盒测试 → 工具注册

```
文件上传
  ↓
P0 文件处理管道
  ├─ 已知格式 → 正常提取
  └─ UnsupportedFormatException → 触发 Auto-Tool Pipeline
       ↓
   Coding Agent (LLM + 文件样本)
       1. 分析文件头特征、magic bytes
       2. 推断格式 → 编写 Python 解析脚本
       3. 沙盒试运行 (P10 sandbox, 30s timeout)
          ├─ 失败 → 读 stderr → Self-Correction (最多 3 轮)
          └─ 成功 → 提取出结构化数据
       ↓
   工具封装
       1. 生成 Tool Description（MCP 兼容）
       2. 存入 ToolStore (Prisma)
       3. Router 热更新可用工具列表
       ↓
   下次同类文件 → Router 自动路由到新工具
```

### 10.3 安全约束

| 约束 | 说明 |
|---|---|
| **沙盒隔离** | 复用 `POST /api/v1/sandbox/execute` — 30s timeout, 64KB output, 独立 tempdir |
| **多重样本验证** | 脚本必须在 ≥3 个不同样本上通过才能注册为工具 |
| **无网络权限** | Coding Agent 生成的脚本在沙盒中无网络访问 |
| **人工审核开关** | 生成的工具默认 `disabled`，需用户在 Plugins 页手动启用 |

### 10.4 数据结构

```typescript
interface ToolRecord {
  id: string
  userId: string
  name: string              // "dicom_private_tag_parser"
  description: string        // "Parses private DICOM tags from Siemens CT scanners"
  language: 'python' | 'bash'
  script: string             // The actual code
  inputFormat: string        // e.g., ".dcm" or magic bytes signature
  createdFrom: string        // Source file that triggered creation
  testedOn: string[]         // File IDs of test samples
  testResults: Array<{ fileId: string; passed: boolean; output?: string }>
  successRate: number        // 0-1
  enabled: boolean           // Default false until reviewed
  createdAt: string
}
```

### 10.5 P3 Router 扩展

```
P3 Router
  ↓ Load tools from ToolStore WHERE enabled=true
  ↓ Add to available routes:
  │
  ├─ SQL route (patients, studies, etc.)
  ├─ Vector route (Facts, Knowledge)
  ├─ Graph route (clinical_graph)
  └─ Tool route (dynamic, per-user)
       ↓ Match: input file signature → tool
       ↓ Return: extracted structured data
```

---

## 11. 实施路线图（v2.2 全量）

| Phase | 内容 | 前/后端 | 状态 |
|---|---|---|---|
| **P0** | Facts去重 + 文件去重 | ✅ 已部署 | ✅ |
| **P1** | KnowledgeStore + Takeaway | ✅ 已部署 | ✅ |
| **P2** | Persona动态合成 + 文件注入Chat | ✅ 已部署 | ✅ |
| **P3** | Query Router（规则优先 + LLM 兜底）| ⬜ | 🔴 优先级最高，控制成本 |
| **P3.1** | 显式知识库命令（搜索/记住/总结/Gap）| ⬜ | 🔴 优先级最高，零基线成本 |
| **P3.2** | Knowledge Gap 用户可见面板 | ⬜ | 🔴 优先级最高，纯 UI |
| **P4** | 上下文压缩 | ⬜ | 🔴 |
| **P5** | 双轨图谱抽取 (NLP+LLM) | ⬜ | 🔴 |
| **P6** | 向量检索 (sqlite-vec) | ⬜ | 🔴 |
| **P7** | GraphRAG 融合 (RRF) | ⬜ | 🔴 |
| **P8** | Knowledge 级联更新 | ⬜ | 🔴 |
| **P8.1** | Sidecar 输出选择性回写知识库 | ⬜ | 🟡 用户触发时启用 |
| **P9** | 外部化学习 (Nightly Agent) | ⭐ | 🔴 |
| **P10** | 动态工具引擎 (Auto-Tool) | ⭐ | 🔴 |

## 9. UI/UX 设计

### 9.1 整体信息架构

```
侧边栏导航
├── 📊 Today (Dashboard)
├── 💬 Chat (通用对话)
├── 👥 Patients (患者列表 + 详情 + 问诊)
├── 📚 Knowledge (知识库文章)
├── 🏷️ Facts (事实/偏好管理)
├── 📁 Files (文件管理)
├── 🔬 Research (研究)
├── ✍️ Writing (写作)
├── ⚡ Skills (技能)
├── 🧩 Plugins (插件)
└── ⚙️ Settings
```

### 9.2 Today Dashboard

```
┌──────────────────────────────────────────────────┐
│  Heurion Logo                    HZ (Admin)      │
├──────────────────────────────────────────────────┤
│  早安，HZ                                         │
│                                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │
│  │ 3       │ │ 12      │ │ 47      │ │ 2      │ │
│  │ Patients│ │ Files   │ │ Facts   │ │ Studies│ │
│  └─────────┘ └─────────┘ └─────────┘ └────────┘ │
│                                                  │
│  📌 Takeaways 待确认                       [全部] │
│  ┌──────────────────────────────────────────┐   │
│  │ ☑ "ZL 胸痛已持续3周，建议胸部CT"           │   │
│  │   来自: 问诊 7/20  ·  confidence: 0.9     │   │
│  │   [确认 ✓] [驳回 ✗]                       │   │
│  ├──────────────────────────────────────────┤   │
│  │ ☐ "NSCLC免疫治疗对比分析"                  │   │
│  │   来自: Writing 7/19                     │   │
│  │   [确认 ✓] [驳回 ✗]                       │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  🧠 Knowledge Status                            │
│  ┌──────────────────────────────────────────┐   │
│  │ ⚠️ "NSCLC EGFR管理" → stale (Fact更新)    │   │
│  │ ✅ "免疫治疗综述" v3 → current             │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ❓ Knowledge Gaps (3)                          │
│  ┌──────────────────────────────────────────┐   │
│  │ • ZQ 对 osimertinib 的实际耐受性？        │   │
│  │ • 本院 EGFR 突变患者的中位 PFS？          │   │
│  │ • 免疫治疗相关肺炎的处理流程？             │   │
│  │   [查看全部] [回答] [忽略]                 │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  📁 Recent Files                                │
│  CT_7-15.pdf 18KB · Lab_7-15.txt 2KB · 2h ago  │
└──────────────────────────────────────────────────┘
```

### 9.3 Chat Panel（带上下文压缩注入）

```
┌──────────────────────────────────────┬────────────┐
│  Chat with ZL                        │ Context    │
│  [Router: SQL→Patient]               │ Rail       │
├──────────────────────────────────────┤            │
│  [ZL, 65F, 咳嗽3周]                  │ 📁 Files   │
│                                      │ CT 7/15    │
│  👤: ZL的CT结果怎么样？               │ Lab 7/15   │
│       [Router: mixed → SQL+图]       │            │
│  🤖: RUL nodule 18mm, stable vs 4/10 │ 🧠 Facts   │
│      CEA 3.2 normal.                 │ RUL 18mm   │
│      [expand CT report] [timeline]   │ stable     │
│                                      │ CEA 3.2    │
│  📌 Takeaway: nodule稳定，继续观察    │            │
│  [确认] [驳回]                        │ 📊 Timeline│
├──────────────────────────────────────┤ 4/10→7/15  │
│  [📎] [⚡Skills] [Type...] [Send]    │ stable     │
└──────────────────────────────────────┴────────────┘
```

### 9.4 Knowledge 库

```
┌──────────────────────────────────────────────┐
│  Knowledge (12)                     [+ New]   │
├──────────────────────────────────────────────┤
│  Filter: [All] [Current] [⚠️ Stale]          │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ NSCLC 免疫治疗综述              v3 ✅   │  │
│  │ 基于 8 Facts + 3 文件合成              │  │
│  │ Updated: 7/20                          │  │
│  │ 📎 Sources: Fact#45, File#12, Chat#89 │  │
│  │ [Edit] [Regenerate] [Delete]          │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ ⚠️ EGFR 突变管理                v1     │  │
│  │ Fact#45 已更新 (RUL 18→19mm)           │  │
│  │ 内容可能过时                             │  │
│  │ [Regenerate] [手动编辑] [忽略]          │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 9.5 文件管理

```
┌──────────────────────────────────────────────┐
│  Files (12)                 🔍 [搜索...]     │
├──────────────────────────────────────────────┤
│  📄 CT报告_7-15.pdf    18KB · 2h ago        │
│     SHA256: abc123...  |  Patient: ZL       │
│     Text: ✓ extracted (234 words)            │
│                                    [🗑]      │
│  📄 Lab_7-15.txt        2KB · 2h ago        │
│     SHA256: def456...  |  Patient: ZL       │
│                                    [🗑]      │
│  🖼 chest-ct.dcm       12MB · 1d ago        │
│     Modality: CT  |  Patient: ZQ            │
│     Quick Scan: RUL nodule 18mm             │
│                                    [🗑]      │
└──────────────────────────────────────────────┘
```

### 9.6 Knowledge Gap 页面

```
┌──────────────────────────────────────────────┐
│  Knowledge Gaps (5 open / 12 total)   [+ New] │
├──────────────────────────────────────────────┤
│  Filter: [Open] [Answered] [Ignored] [All]   │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ ❓ ZQ 对 osimertinib 的实际耐受性？     │  │
│  │    来源: Chat #128 · 2 天前            │  │
│  │    [回答...] [忽略] [查看上下文]        │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ ✅ 本院 EGFR 突变患者的中位 PFS？       │  │
│  │    已转为 Fact #89 · 1 天前            │  │
│  │    答案: "47例患者中位 PFS 14.2 月"     │  │
│  │    [编辑] [查看 Fact]                   │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 9.7 Chat 中的显式命令示例

```
👤: 搜索我的知识库关于 NSCLC 免疫治疗
🤖: [Router: knowledge_command → kb_search]
    找到 3 条相关知识：
    1. "PD-L1 ≥50% 一线免疫单药" (Knowledge #12)
    2. "免疫相关肺炎处理" (Fact #56)
    3. "本院 23 例免疫治疗经验" (Facts #78-89)

👤: 记住：ZL 对青霉素过敏
🤖: [Router: knowledge_command → kb_remember]
    ✅ 已记录为 Fact #91，置信度 0.92

👤: Sidecar 报告里 EGFR 突变比例很高，存到知识库
🤖: [Router: knowledge_command → kb_remember]
    ✅ 已提取 2 条事实，待你确认：
    • "47例 NSCLC 中 EGFR 突变占 38.3%"
    • "EGFR 突变患者一线治疗以 osimertinib 为主"
```

---

## 10. 测试设计

TDD 测试用例详见 [`KB_EVOLUTION_TESTS.md`](./KB_EVOLUTION_TESTS.md)，覆盖：

- Query Router 单元测试与回归测试
- 显式知识库命令 Handler 单元测试
- Knowledge Gap Service/API 测试
- Chat Orchestrator 集成回归测试
- 成本可观测性测试

## 10. 关键指标

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 文件去重率 | > 30% | 相同SHA-256 / 总上传 |
| Facts 提取准确率 | > 80% | 确认/拒绝比例 |
| Router 规则命中率 | > 80% | 规则层命中 / 总查询 |
| Router 单路满足率 | > 70% | 单路检索满足 / 总查询 |
| 上下文 token 节省 | > 40% | 压缩前/后对比 |
| 显式命令使用率 | > 15% | 用户触发 KB 命令 / 总会话 |
| Knowledge Gap 转化率 | > 30% | 被回答的 Gap / 总 Gap |
| NLP 抽取覆盖率 | > 75% | 轨1处理 / 总文本 |
| Knowledge stale 检测时间 | < 10min | 扫描间隔 |
