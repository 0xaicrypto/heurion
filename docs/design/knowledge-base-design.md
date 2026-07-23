# Heurion 产品设计 v2.1 — 个人知识库 + 持续学习 Agent

**Status:** Design proposal (revised)  
**更新:** 2026-07-20  

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
  │   └─ 以上都不匹配
  │       ↓
  └─ 分类器（LLM 轻量层: 单次调用，<200ms）
       ├─ 意图: factual_query → SQL
       ├─ 意图: semantic_search → 向量检索
       ├─ 意图: relational_query → 图遍历
       └─ 意图: mixed → SQL + 向量 + 图 → RRF 融合
```

**性能指标**：
- 简单查询延迟: <10ms (规则命中)
- 复杂查询延迟: <250ms (LLM 分类 + 检索)
- 并行检索减少: ~70% 的查询单路即可满足

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

---

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

---

## 10. 关键指标

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 文件去重率 | > 30% | 相同SHA-256 / 总上传 |
| Facts 提取准确率 | > 80% | 确认/拒绝比例 |
| Router 命中率 | > 70% 单路命中 | 规则层命中比例 |
| 上下文 token 节省 | > 40% | 压缩前/后对比 |
| NLP 抽取覆盖率 | > 75% | 轨1处理 / 总文本 |
| Knowledge stale 检测时间 | < 10min | 扫描间隔 |
