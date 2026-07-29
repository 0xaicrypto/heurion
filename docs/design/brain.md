# Brain 2.0 — 临床/科研记忆中枢设计

**状态：** 设计提案 v2.1  
**日期：** 2026-07-29  
**范围：** `packages/web`、`packages/server-ts`  
**相关文档：**
- `docs/design/web-ui-redesign.md`（浏览器优先的 UI 架构）
- `docs/design/MEMORY_KNOWLEDGE_EVOLUTION_REFACTOR.md`（记忆/知识/进化系统重构）
- `docs/design/knowledge-base-design.md`（知识库产品设计）

---

## 0. 一句话目标

让 Heurion 成为医生的**长期临床与科研搭档**：自动整理患者病历、跟踪科研进展、沉淀可复用的诊疗经验，并在每次问诊和研究时把最相关的上下文推到医生面前。

---

## 1. 我们从 Hermes 学到了什么

我们分析了 `NousResearch/hermes-agent`。它最值得我们借鉴的不是技术栈，而是三个产品设计直觉：

1. **记忆是 agent 自己写的笔记**：`MEMORY.md` / `USER.md` 直接出现在 system prompt 里，agent 知道自己在写什么、为什么写、写满了怎么办。
2. **技能就是操作手册**：`SKILL.md` 是 markdown 文档，agent 按需加载，`/learn` 能把刚完成的任务自动转成 skill。
3. **写记忆/技能前要有审批**：`write_approval` gate 防止 agent 污染自己的长期记忆。

Hermes 是为单用户个人 agent 设计的（数据在 `~/.hermes/`，一个 profile 一个环境）。我们不会照搬它的进程模型，但会把这三个思想吸收进我们的多租户、事件驱动、版本化的架构里。

---

## 2. 用户故事 vs 当前系统：缺口映射

下面把最近收集到的用户故事和当前系统/Brain 2.0 设计做对照，找出真正需要补的模块。

### 诊疗

| # | 用户故事 | 当前支持 | 缺口 |
|---|---|---|---|
| 1 | 上传化验报告，AI 自动分析并更新病历 | Labs 可上传；Chat 可分析附件；**上传后不会自动触发分析** | 缺少 Ingestion Pipeline |
| 2 | 上传影像资料，AI 自动分析并更新病历 | DICOM quick-scan 更新 `chiefComplaint`，但非结构化 | 缺少结构化 findings / 检查记录 |
| 3 | 在病历中查看患者做过哪些检查 | 只有文件列表，无检查时间线 | 需要 Examination Timeline |
| 4 | 导出病例并共享给其他科室 | 无专用病例导出 | 需要 Case Report Export |
| 5 | 打开患者记录时展示基本情况汇总 | Patient detail 展示原始字段，无自动摘要 | 需要 Patient Summary |
| 6 | 告诉 AI 诊疗信息，自动更新病历 | Chat 可间接更新，但缺少显式 action | 需要 `update_medical_record` brain action |

### 科研

| # | 用户故事 | 当前支持 | 缺口 |
|---|---|---|---|
| 7 | 上传科研计划，自动提取入选规则和时间安排 | `import-protocol` + `extract-rules` 已支持 | 基本满足 |
| 8 | 确认/修改规则并保存到研究计划 | 可提取，规则编辑工作流不完整 | 需要 Rule Curation |
| 9 | 查看已入选患者和分组 | Roster / schedule / safety / eligibility 已支持 | 基本满足 |
| 10 | 查看研究进展、规则满足情况、时间节点数据 | 只有安全/入组状态，无综合 dashboard | 需要 Study Progress Dashboard |
| 11 | 查看时间节点上患者情况和检查数据 | 事件计划与患者实际检查数据未联动 | 需要 Study Event ↔ Patient Record 关联 |
| 12 | AI 汇总研究进展和患者数据用于论文引用 | Document chat 可总结，无科研专用生成 | 需要 Research Summary Generator |
| 13 | 导出/同步时间节点和患者联系到日历 | Calendar iCal export 已支持 | 基本满足 |
| 14 | 让 AI 根据进展、检查、对照组生成论文/报告草稿 | 无结构化科研写作模板 | 需要 Research Report Skill |

### 经验沉淀

| # | 用户故事 | 当前支持 | 缺口 |
|---|---|---|---|
| 15 | 自动整理诊疗和科研经验，后续参考引用 | KB 会合成 articles，Skill 系统计划 `/learn`，但无跨患者/科研的自动沉淀机制 | 需要 Experience Synthesis Worker |

**核心结论：** 真正的缺口不是“记忆不够大”，而是**缺少把临床/科研数据结构化、自动化、再沉淀成经验的四层流水线**。

---

## 3. GraphRAG / Embedding 是不是前提？

**不是严格前提，但它是放大器。**

### 没有 GraphRAG 也能做的事

- 上传化验单 → 提取文本 → LLM 分析 → 写入结构化病历
- DICOM quick-scan → 写入 findings
- 生成患者摘要 / 病例报告
- 跟踪科研入组、日程、事件
- 把规则、日程、患者数据展示在页面上

这些功能依赖的是**结构化数据模型**和**清晰的业务规则**，不是向量检索。

### 有 GraphRAG 才能做的事

- 患者大脑里自动浮现“与当前患者相关的全局知识”（无法靠关键词精确匹配）
- 自动发现跨患者的诊疗模式（例如：某种治疗方案对某类患者更有效）
- 从海量聊天记录里找到“三周前类似病例的处理方式”
- 自动把相关 facts / study results 聚类成经验文章或 skill
- 用自然语言问“我去年处理过多少类似的肝功异常患者？”并真正召回正确结果

### 结论

> **先做结构化数据 + Ingestion Pipeline，再做 GraphRAG。**
>
> 没有结构化的 GraphRAG 只是噪声检索；没有 GraphRAG 的 Brain 2.0 已经可以支撑 80% 的诊疗/科研闭环。

---

## 4. 设计原则

1. **先结构化，再智能化**：病历、科研事件、检查记录必须先有 schema，才能被 AI 可靠地使用。
2. **EventLog 是唯一真相源**：所有记忆/病历/知识/规则/Skill 的变更先写事件，再投影到查询视图。
3. **上传即触发分析**：文件上传不是终点，而是 Ingestion Pipeline 的起点。
4. **人类在关键环节把关**：高影响写入（病历更新、规则变更、经验发布）默认 `pending_review`。
5. **记忆有预算**：核心记忆必须 bounded，超出时硬截断或人工整理。
6. **患者上下文是一等公民**：全局大脑和患者大脑共享组件，但患者相关数据优先、醒目、可溯源。
7. **科研和诊疗数据联动**：研究事件必须能引用患者真实检查记录。

---

## 5. 信息架构

### 5.1 全局路由

```
/app/today                 今日概览（含待审批、今日随访、研究提醒）
/app/brain                 全局大脑
/app/research              科研空间
/app/writing               写作空间
/app/settings              设置（含 Plugins、LLM、Profile）
```

### 5.2 Brain 页内 tab

```
/app/brain                 → Overview（大脑仪表盘 + 待审批 inbox）
/app/brain/knowledge       → Knowledge（facts / articles / gaps / documents）
/app/brain/graph           → Graph（记忆图谱）
/app/brain/persona         → Persona（动态人设）
/app/brain/skills          → Skills（技能手册 + 待审批经验）
```

### 5.3 患者嵌套路由

```
/app/patient/:hash                 患者摘要（含基本情况汇总、检查时间线）
/app/patient/:hash/chat            问诊聊天
/app/patient/:hash/record          病历时间线（结构化 MedicalRecord）
/app/patient/:hash/case-report     病例报告（可导出/共享）
/app/patient/:hash/imaging         影像
/app/patient/:hash/labs            化验
/app/patient/:hash/memory          患者大脑
/app/patient/:hash/studies         该患者参与的科研项目
/app/patient/:hash/report          报告
```

### 5.4 科研路由（补充）

```
/app/research/:studyId             研究详情
/app/research/:studyId/protocol    方案与规则管理
/app/research/:studyId/roster      入组患者
/app/research/:studyId/schedule    日程与事件
/app/research/:studyId/progress    进展 dashboard
/app/research/:studyId/writing     科研写作（引用患者数据生成草稿）
```

---

## 6. 核心概念

### 6.1 Global Brain（全局大脑）

跨患者的记忆与知识总览：
- facts / articles / gaps / skills / entities / documents
- 跨患者统计、最近活动、待审批 inbox
- 全局 Persona
- 全局 Skills

### 6.2 Patient Brain（患者大脑）

当前患者的记忆视图，是全局大脑按 `patientHash` 过滤后的聚焦视图。

默认显示：
- 该患者的 facts / findings / medications / documents
- 相关 articles / gaps / conflicts / reports
- 该患者参与的科研项目及进展

### 6.3 MedicalRecord（结构化病历）

取代把所有信息塞进 `chiefComplaint` 的做法。每个条目有类型、来源、时间、AI 摘要、人工确认状态。

```ts
interface MedicalRecordEntry {
  id: string;
  patientHash: string;
  type: 'lab' | 'imaging' | 'note' | 'diagnosis' | 'medication' | 'procedure';
  title: string;
  date: string;
  content: string;
  aiSummary?: string;
  sourceFileId?: string;
  sourceStudyId?: string;
  status: 'pending_review' | 'confirmed' | 'rejected';
  createdBy: 'system' | 'user' | 'agent';
}
```

### 6.4 Case Report（病例报告）

从患者所有结构化病历生成的一份可导出、可共享的摘要文档：
- demographics
- 检查时间线
- 关键 findings
- 当前诊断与治疗建议
- 导出 DOCX / PDF

### 6.5 Study Event（科研事件）

研究日程上的节点，可以关联到具体患者的 MedicalRecordEntry：

```ts
interface StudyEvent {
  id: string;
  studyId: string;
  patientHash?: string;
  scheduledAt: string;
  eventType: 'screening' | 'treatment' | 'followup' | 'assessment';
  description: string;
  linkedRecordIds: string[];
  status: 'planned' | 'completed' | 'overdue' | 'missed';
}
```

### 6.6 Persona（可写身份）

系统每次聊天前根据记忆动态生成的“系统人设”。
- 展示 `preferences`、`goals`、`keyFacts`
- 标注每条内容来源
- agent 可提议更新
- 用户可手动添加/删除/锁定

### 6.7 Skill（程序性记忆）

- 用 `SKILL.md` 描述可复用流程
- 存储为 memory graph 节点，`content` 存 markdown 全文
- 支持渐进加载
- agent 可提议创建（`/learn`）
- 用户可编辑、锁定、禁用

### 6.8 Experience（经验沉淀）

从多个相关 cases / study results 中自动 synthesized 的候选知识：
- 输出形式：SKILL.md 或 article
- 默认状态 `pending_review`
- 医生批准后发布为正式 skill / article

---

## 7. 数据模型

### 7.1 四层结构

```
┌─────────────────────────────────────────────┐
│  Runtime View（运行时投影）                   │
│  - Persona block                             │
│  - Relevant facts / articles / skills        │
│  - Patient summary / case report preview     │
├─────────────────────────────────────────────┤
│  Memory Graph（结构化查询视图）              │
│  - Nodes: fact / article / gap / skill       │
│  - Relations: derives_from / depends_on      │
├─────────────────────────────────────────────┤
│  MedicalRecord + StudyEvent（业务模型）      │
│  - 结构化病历条目                            │
│  - 科研事件与患者记录关联                    │
├─────────────────────────────────────────────┤
│  Event Log（唯一真相源）                     │
│  - file_uploaded                             │
│  - ingestion_completed                       │
│  - medical_record_entry_created              │
│  - medical_record_entry_confirmed            │
│  - study_event_linked                        │
│  - memory_* / skill_* / persona_*            │
└─────────────────────────────────────────────┘
```

### 7.2 Ingestion Pipeline

文件上传后自动触发：

```
文件上传 → EventLog(file_uploaded)
  → IngestionWorker
    → 1. 提取文本 / OCR（PDF） / 解析 DICOM / 解析图片
    → 2. 路由到对应 analyzer（lab / imaging / report / protocol）
    → 3. LLM 分析，产出 MedicalRecordEntry（status=pending_review）
    → 4. 写入 EventLog（medical_record_entry_created）
    → 5. 投影到 Memory Graph（生成 facts / articles）
    → 6. 通知用户（Brain Overview inbox + Today 页 widget）
```

**审批原则：** 所有 AI 生成的病历条目默认 `pending_review`，医生确认后才变成 `confirmed`。

---

## 8. 后端 API 设计

### 8.1 Ingestion

```ts
// 触发或查询文件分析状态
POST /api/v1/ingestions/:fileId/analyze
GET  /api/v1/ingestions/:fileId/status
GET  /api/v1/ingestions/pending          // 待审批列表
POST /api/v1/ingestions/:entryId/confirm // 医生确认
POST /api/v1/ingestions/:entryId/reject  // 医生拒绝
```

### 8.2 Medical Record

```ts
GET    /api/v1/patients/:hash/medical-records          // 病历时间线
POST   /api/v1/patients/:hash/medical-records          // 手动添加
PATCH  /api/v1/patients/:hash/medical-records/:id      // 编辑
DELETE /api/v1/patients/:hash/medical-records/:id      // 删除
GET    /api/v1/patients/:hash/summary                  // 自动生成的患者摘要
```

### 8.3 Case Report

```ts
POST /api/v1/patients/:hash/case-report         // 生成病例报告
GET  /api/v1/patients/:hash/case-report         // 查看
POST /api/v1/patients/:hash/case-report/export  // 导出 DOCX/PDF
POST /api/v1/patients/:hash/case-report/share   // 生成共享链接
```

### 8.4 Brain

```ts
GET /api/v1/agent/brain
GET /api/v1/agent/persona
POST /api/v1/agent/brain/actions
POST /api/v1/agent/search/sessions
```

### 8.5 Research（补充）

```ts
GET    /api/v1/research/studies/:studyId/progress
GET    /api/v1/research/studies/:studyId/events
POST   /api/v1/research/studies/:studyId/events/:eventId/link-record
POST   /api/v1/research/studies/:studyId/summary
POST   /api/v1/research/studies/:studyId/report-draft
```

### 8.6 Experience Synthesis

```ts
GET  /api/v1/experiences/pending      // 待审批的经验候选
POST /api/v1/experiences/:id/approve  // 发布为 skill/article
POST /api/v1/experiences/:id/reject
POST /api/v1/experiences/generate     // 手动触发合成
```

---

## 9. 前端架构

### 9.1 新增/重构页面与组件

```
packages/web/src/
  routes/
    brain.tsx                          # BrainPage
    patient.tsx                        # PatientLayout
    patient-summary.tsx                # /app/patient/:hash 默认内容
    patient-record.tsx                 # /app/patient/:hash/record
    patient-case-report.tsx            # /app/patient/:hash/case-report
    patient-studies.tsx                # /app/patient/:hash/studies
    settings.tsx                       # 新增 Plugins tab
    research-progress.tsx              # /app/research/:studyId/progress
    research-writing.tsx               # /app/research/:studyId/writing

  components/brain/
    BrainOverview.tsx                  # 统计卡片 + 待审批 inbox
    BrainKnowledge.tsx
    BrainGraph.tsx
    BrainPersona.tsx
    BrainSkills.tsx
    BrainNav.tsx
    IngestionInbox.tsx                 # 待审批的 AI 分析结果
    ExperienceApprovalList.tsx         # 待审批的经验候选

  components/patient/
    PatientHeader.tsx
    PatientModeTabs.tsx
    PatientSummaryCard.tsx             # 基本情况汇总
    ExaminationTimeline.tsx            # 检查时间线
    MedicalRecordList.tsx
    MedicalRecordEditor.tsx
    CaseReportViewer.tsx
    CaseReportExportButton.tsx

  components/research/
    StudyProgressDashboard.tsx         # 入组、规则满足、里程碑
    StudyEventTimeline.tsx
    PatientDataLinker.tsx              # 把 study event 关联到患者记录
    ResearchReportDraftPanel.tsx

  components/today/
    PendingIngestionsWidget.tsx        # 今日待审批
    TodaysStudyEventsWidget.tsx        # 今日随访/研究事件
    ActivePatientsWidget.tsx
```

### 9.2 关键前端交互

#### 今日页（/app/today）

- **待审批 inbox**：AI 分析了化验单/影像/科研协议，等你确认
- **今日随访**：哪些 study event 今天要处理
- **活跃患者**：最近查看/修改过的患者

#### 患者摘要（/app/patient/:hash）

- 顶部：demographics + 关键标签（过敏、慢病）
- 中部：AI 生成的患者摘要（基于 MedicalRecord）
- 下部：最近检查时间线
- 操作：导出病例报告、开始问诊、上传化验/影像

#### 病历时间线（/app/patient/:hash/record）

- 按时间倒序展示所有 MedicalRecordEntry
- 每项显示：类型图标、标题、日期、AI 摘要、来源文件、确认状态
- 支持人工编辑、删除、确认 pending 条目

#### 病例报告（/app/patient/:hash/case-report）

- 左侧：报告大纲
- 中间：Markdown 预览
- 右侧：引用的原始记录列表
- 顶部：导出 DOCX / PDF / 生成共享链接

#### Brain > Overview

- 大脑统计卡片
- Ingestion inbox（跨患者的待审批）
- Experience inbox（待审批的经验候选）
- 最近活动

#### Brain > Skills

- 已发布 skills
- 待审批经验（ExperienceApprovalList）
- 从插件发现 marketplace 入口

---

## 10. 实现阶段（重新排序）

### Phase 0：结构化数据模型 + Ingestion Pipeline

**为什么先做：** 没有结构化病历和自动分析，后面的 Brain 页面、Graph、经验沉淀都是空中楼阁。

1. 设计 `MedicalRecordEntry` schema 和 API。
2. 设计 `StudyEvent` 与 `MedicalRecordEntry` 的关联。
3. 实现 `IngestionWorker`：监听文件上传，调用对应 analyzer。
4. 实现 PDF/OCR 提取（已完成）、DICOM 解析、图片 OCR 的统一 `DocumentExtractor`。
5. 实现 lab / imaging / report / protocol 四个 analyzer。
6. 所有 analyzer 产出默认 `pending_review`，写入 EventLog。
7. 前端：Ingestion inbox（Brain Overview + Today widget）。

### Phase 1：患者诊疗闭环

1. 患者摘要页面（PatientSummaryCard + ExaminationTimeline）。
2. 病历时间线页面（/app/patient/:hash/record）。
3. 病例报告生成与导出（/app/patient/:hash/case-report）。
4. 患者路由重构（/app/patient/:hash/*）。
5. Labs / Imaging 上传后自动触发 Ingestion。

### Phase 2：科研-患者数据联动

1. Study event 可关联患者 MedicalRecordEntry。
2. Study Progress Dashboard（/app/research/:studyId/progress）。
3. Rule Curation UI（/app/research/:studyId/protocol）。
4. Research Report Draft（/app/research/:studyId/writing）。
5. Calendar sync 保持现有能力。

### Phase 3：Brain 页面与 Agent 可写记忆

1. 抽出 `KnowledgeHub` 和 `BrainGraph`。
2. 新建 `BrainPage` + 5 tab。
3. 实现 `brain` tool：`add_fact`、`update_medical_record`、`update_persona`。
4. 实现写前审批与 inbox。
5. 删除旧 `/app/knowledge`、`/app/memory*` 路由。
6. Plugins 移到 Settings。

### Phase 4：Skill 系统

1. SKILL.md schema。
2. skill 作为 memory graph 节点存储。
3. `/learn` 流程。
4. chat 中 `/skill-name` 加载。

### Phase 5：GraphRAG / Embedding

1. 为 facts / articles / gaps / skills 生成 embedding。
2. 向量存储选型与实现。
3. 语义搜索 + 图遍历检索。
4. 更新 `MemoryProjection` 为混合检索。
5. 患者大脑的全局知识叠加（低透明度相关节点）。

### Phase 6：Graph 大脑化

1. 深色主题、神经元节点、突触边。
2. Compound nodes 脑区聚类（依赖 GraphRAG 聚类）。
3. 脉冲动画、聚焦交互、HUD。

### Phase 7：Experience Synthesis

1. Experience Synthesis Worker。
2. 从 cases / study results 生成候选 skill/article。
3. 待审批 inbox 与发布流程。

### Phase 8：收尾

1. 更新 `web-ui-redesign.md`。
2. 性能优化（大 PDF OCR、向量索引）。
3. 全量测试。

---

## 11. 测试计划

| 层级 | 内容 |
|---|---|
| 单元 | `DocumentExtractor`（文本 PDF、扫描 PDF OCR、DICOM、图片） |
| 单元 | IngestionWorker 路由与 analyzer 输出 |
| 单元 | MedicalRecord CRUD 与状态流转 |
| 集成 | 文件上传 → Ingestion → pending_review → 医生确认 → Memory Graph 更新 |
| 集成 | 患者摘要 / 病例报告生成 |
| 集成 | Study event 关联 patient record |
| e2e | 上传化验单 → AI 分析 → 医生确认 → 病历时间线可见 |
| e2e | 上传科研协议 → 提取规则 → 医生修改 → 保存 |
| e2e | 聊天中 agent 提议更新病历 → 医生确认 |
| 视觉 | Graph 主题化回归 |
| 性能 | 大 PDF OCR 超时与降级 |

---

## 12. 已确认决策

1. **命名统一**：产品/代码/路由全部使用 `Brain`。
2. **第一步不是 GraphRAG**：先做结构化数据模型 + Ingestion Pipeline。
3. **GraphRAG 放在 Phase 5**：它是放大器，不是地基。
4. **结构化病历**：用 `MedicalRecordEntry` 取代把所有信息塞进 `chiefComplaint`。
5. **上传即触发分析**：Labs / Imaging / Research protocol 上传后自动进入 Ingestion Pipeline。
6. **AI 生成内容默认 pending_review**：医生确认后才生效。
7. **Skill 存储格式**：作为 memory graph 节点，`content` 字段保存 markdown 全文。
8. **患者大脑 Persona tab**：允许修改全局 preferences。
9. **Graph 3D**：远期路线图。
10. **旧路由处理**：`/app/knowledge`、`/app/memory*` 直接删除，不做重定向。
11. **插件前端位置**：管理入口在 `Settings > Plugins`，能力发现在 `Brain > Skills`，使用入口在 `Chat Composer`。

---

## 13. 剩余开放问题（已决策）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 向量存储选型 | **SQLite + 用户级内存 brute-force**。embedding 存在现有 SQLite 节点表中，查询时加载该用户向量在内存做 cosine similarity。零额外依赖，足够支撑单用户数千节点；规模上来后迁移到 `sqlite-vec` 或 `pgvector`。 |
| 2 | Embedding 模型 | **本地开源模型优先，默认 `BAAI/bge-m3`，dimensions=1024**。原因：Moonshot/Kimi 与 DeepSeek 目前均未公开 Embedding API，且临床数据倾向于本地部署。OpenAI 保留为可选云 fallback；未来若国产 API 推出 embedding，可通过 adapter 切换。 |
| 3 | MedicalRecordEntry `type` 枚举 | **可扩展**。初始枚举：`lab`、`imaging`、`pathology`、`ecg`、`note`、`diagnosis`、`medication`、`procedure`、`vaccination`、`allergy`。 |
| 4 | DICOM 分析 | **继续使用 Gemini Vision**。现有 quick-scan 已集成，保持 fire-and-forget 改为同步等待（见 patients.router.ts 修复）。 |
| 5 | 病例报告共享安全模型 | **限时只读 signed token + 审计日志**。默认 7 天过期，访问记录写入 audit log；可选“院内用户”模式。不开放完全匿名链接。 |
| 6 | `/learn` 生成的 skill | **必须用户审批**。生成后状态 `pending_review`，医生确认后发布。 |
| 7 | 记忆预算 token 上限 | **按模型动态调整**。根据当前使用模型的 tokenizer/上下文窗口计算上限。 |
| 8 | Experience Synthesis 触发 | **手动 + 定时**。用户可点击“整理经验”，系统每晚/每周自动扫描已确认病例和科研结果。 |

---

## 14. AI Provider Strategy

| 能力 | 默认 Provider | 模型 | 决策依据 |
|---|---|---|---|
| 聊天 / 推理 / 结构化提取 | **DeepSeek** | `deepseek-v4-pro` / `deepseek-v4-flash` | 已确认使用 DeepSeek；兼容 OpenAI SDK，支持 JSON Mode、Tool Calls。 |
| 文本 Embedding | **本地开源模型** | 默认 `BAAI/bge-m3`（multilingual，8192 tokens，1024/768 维）；备选 `bge-large-zh-v1.5`、`nomic-embed-text-v1.5` | 满足数据不出院、无外部 API 依赖；中文医学场景下 `bge-m3` 效果与上下文长度兼顾。OpenAI 仍保留为可选云 fallback。 |
| 视觉 / DICOM / 图片分析 | **Google Gemini Vision** | 当前使用的 vision 模型（如 `gemini-2.0-flash`） | 已有 DICOM quick-scan 集成，继续复用；未来若 DeepSeek/Moonshot 多模态 API 稳定，可评估迁移。 |
| 本地 / 离线部署 | 可配置 | Ollama / LM Studio / `transformers.js` | 满足数据不出院、内网部署等合规需求。 |

### 14.1 环境变量与抽象

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com   # 可选，用于代理/转接
DEEPSEEK_CHAT_MODEL=deepseek-v4-pro

# 本地/自托管 Embedding（默认）
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=32
EMBEDDING_DEVICE=cpu           # cpu / cuda / mps
EMBEDDING_QUANTIZATION=none    # none / int8 / onnx
EMBEDDING_SERVICE_URL=         # 若使用独立微服务则填 URL

# 可选：OpenAI 云 embedding fallback
OPENAI_API_KEY=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536

GEMINI_API_KEY=...
GEMINI_VISION_MODEL=gemini-2.0-flash
```

后端提供统一抽象：

```ts
interface AiProvider {
  chat(messages: Message[], options: ChatOptions): Promise<ChatResult>;
  embed(texts: string[], options: EmbedOptions): Promise<number[][]>;
  vision(images: ImageInput[], prompt: string): Promise<VisionResult>;
}
```

业务代码只依赖 `AiProvider`，不直接调用具体 SDK。切换 provider 只需改配置和 adapter。

### 14.2 本地 Embedding 部署形式

| 部署方式 | 适用场景 | 推荐框架 |
|---|---|---|
| 后端进程内加载（`transformers` / `sentence-transformers`） | 单实例、低并发、数据不出院 | Python `sentence-transformers` + FastAPI 微服务；或 Node.js `transformers.js` |
| 独立 Embedding 微服务 | 多实例共享、需要批量/并发 | `text-embeddings-inference` (TEI)、`infinity`、Ollama |
| ONNX / OpenVINO 量化 | CPU 机器、内存/速度敏感 | `optimum[onnxruntime]`、OpenVINO |
| 浏览器端 | 离线 Demo、少量文本 | `transformers.js`（仅轻量模型） |

### 14.3 关键提醒

- **Moonshot/Kimi 目前没有 Embedding API**：设计里不应假设其可用来生成向量；若后续发布，新增一个 `MoonshotEmbeddingAdapter` 即可。
- **Embedding 与 Chat 解耦**：即使未来 DeepSeek 推出 embedding，也不一定要把 chat 和 embedding 绑定到同一家，保持独立配置最灵活。
- **模型维度必须固定**：一个部署实例只能使用固定维度的模型；切换模型时需要重新生成全部 embedding。

### 14.4 本地 Embedding 硬件要求参考

| 模型 | 参数量 | FP16 模型大小 | 推荐 RAM | GPU VRAM（可选） | CPU 单条延迟* | 适用场景 |
|---|---|---|---|---|---|---|
| `sentence-transformers/all-MiniLM-L6-v2` | ~22 M | ~80 MB | 2 GB | 1 GB | 10-30 ms | 英文/通用，速度极快 |
| `BAAI/bge-small-zh-v1.5` | ~33 M | ~120 MB | 2 GB | 1 GB | 15-40 ms | 中文通用，轻量 |
| `nomic-ai/nomic-embed-text-v1.5` | ~137 M | ~550 MB | 4 GB | 2 GB | 30-80 ms | 长文本、英文为主 |
| `thenlper/gte-base` (或 `bge-base-zh`) | ~110 M | ~400 MB | 4 GB | 2 GB | 30-70 ms | 中文，效果与速度平衡 |
| **BAAI/bge-m3**（推荐） | ~567 M | ~2.2 GB | 8 GB | 4-6 GB | 80-200 ms | 多语言、8192 tokens、中文医学场景 |
| `BAAI/bge-large-zh-v1.5` | ~326 M | ~1.3 GB | 6 GB | 3-4 GB | 60-150 ms | 中文，效果优于 bge-m3 在部分任务 |
| `intfloat/multilingual-e5-large` | ~550 M | ~2.2 GB | 8 GB | 4-6 GB | 80-200 ms | 多语言，对查询/段落模板敏感 |

\* CPU 延迟为普通文本（≤512 tokens）在 4 核 modern CPU 上的粗略估算；实际受 token 长度、批大小、量化、框架影响较大。

#### 选型建议

- **最小可用（开发/POC）**：`bge-small-zh-v1.5`，2 GB RAM，纯 CPU，效果足够跑通流程。
- **推荐默认（Heurion 生产）**：`bge-m3`，8 GB RAM 或 4 GB+ GPU，支持长病历文本和多语言。
- **追求极致效果**：`bge-large-zh-v1.5` 或 `multilingual-e5-large`，需要 6-8 GB+ RAM/GPU。

#### 量化与加速

- **INT8 量化**：模型大小和内存减半，CPU 延迟通常降低 30-50%，效果损失 1-3%。
- **ONNX Runtime / OpenVINO**：CPU 上通常比 PyTorch 快 2-5 倍。
- **批处理（batching）**：将多条文本一起 encode，GPU/CPU 利用率大幅提升；建议 batch size 16-64。

#### 并发与规模估算

- 若每个医生每天上传/生成 ≤ 100 条文档，单 CPU 实例即可消化。
- 若医院多科室同时大量上传，建议：
  - 独立 embedding 微服务（TEI / infinity）；
  - 1 块 8 GB VRAM 显卡可支撑每秒数十到上百条 embedding；
  - 或启动多个 ONNX CPU worker 做负载均衡。

---

## 15. Vector Storage Design

本设计用于 **Phase 5（GraphRAG / Embedding）**，但在 Phase 0 预留 schema，避免后续大改。

### 15.1 表结构

```sql
CREATE TABLE memory_node_embeddings (
  node_id      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  node_type    TEXT NOT NULL,       -- fact / article / gap / skill / document_chunk
  model        TEXT NOT NULL,       -- 生成该向量的模型标识，例如 "BAAI/bge-m3"
  vector       TEXT NOT NULL,       -- JSON array of float
  norm         REAL NOT NULL,       -- 预计算的 L2 norm，加速 cosine
  updated_at   TEXT NOT NULL        -- ISO 8601
);

CREATE INDEX idx_embeddings_user_type ON memory_node_embeddings(user_id, node_type);
CREATE INDEX idx_embeddings_updated   ON memory_node_embeddings(updated_at);
```

为什么不直接存二进制 blob？SQLite 中 JSON 文本足够小（1024 维 ≈ 8-12 KB），且便于调试、迁移、后续接入 `sqlite-vec`。

### 15.2 检索算法（per-user brute-force）

```ts
function searchSimilar(
  userId: string,
  queryVector: number[],
  options: { nodeTypes?: string[]; topK?: number; minScore?: number }
): Promise<Array<{ nodeId: string; score: number }>> {
  // 1. 加载该用户（可选按 node_type 过滤）的全部向量
  // 2. 计算 queryVector 与每个 vector 的 cosine similarity
  //    score = dot(query, v) / (norm(query) * norm(v))
  // 3. 按 score 降序，取 topK，过滤 minScore
}
```

### 15.3 规模预估与升级路径

| 单用户节点数 | 向量内存占用 | 检索延迟 | 策略 |
|---|---|---|---|
| < 1,000 | ~10-20 MB | < 50 ms | brute-force，无需索引 |
| 1,000 - 10,000 | ~100-200 MB | 100-300 ms | brute-force + 缓存热点 query |
| > 10,000 | > 200 MB | 不可接受 | 迁移到 `sqlite-vec` / `pgvector` / 专用向量库 |

**升级路径：** 保留 `MemoryVectorStore` 接口，实现 `SqliteBruteForceVectorStore` 和 `SqliteVecVectorStore`，通过配置切换。

---

## 16. Ingestion Pipeline Specification

### 16.1 状态机

```
file_uploaded
    │
    ▼
pending ──► extracting ──► analyzing ──► awaiting_review ──► completed
    │           │             │                │
    ▼           ▼             ▼                ▼
 failed       failed        failed           rejected (医生拒绝)
```

| 状态 | 含义 |
|---|---|
| `pending` | 已收到上传事件，等待 worker 认领 |
| `extracting` | 正在提取文本 / OCR / DICOM 元数据 |
| `analyzing` | LLM analyzer 正在生成结构化条目 |
| `awaiting_review` | 已生成 `pending_review` 的病历条目，等待医生确认 |
| `completed` | 医生确认或 analyzer 标记为无需确认（仅人工条目） |
| `rejected` | 医生拒绝该分析结果 |
| `failed` | 提取或分析失败，超过最大重试次数 |

### 16.2 Analyzer I/O 契约

每个 analyzer 是纯函数：`IngestionJob → IngestionResult`。

```ts
interface IngestionJob {
  jobId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  patientHash?: string;      // 从上传上下文传入
  studyId?: string;          // 科研文件可关联研究
  uploadedBy: string;
  extractedText?: string;    // 由 extraction 阶段产出
  extractedJson?: unknown;   // DICOM 等结构化元数据
}

interface IngestionResult {
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;         // 简要说明分析依据，用于 UI 展示
  entries: MedicalRecordEntryDraft[];
  facts?: FactDraft[];       // 可投影到 Memory Graph
  suggestedStudyEvents?: StudyEventDraft[];
  errors?: string[];         // 非致命错误，不会导致 job failed
}
```

### 16.3 Analyzer 路由表

| MIME 类型 / 文件特征 | Analyzer | 输出 |
|---|---|---|
| `application/pdf`（含文本层） | `PdfReportAnalyzer` | note / lab / imaging 等 |
| `application/pdf`（扫描件，经 OCR） | `PdfReportAnalyzer` | 同上，置信度可能降低 |
| `image/*`（化验单、报告照片） | `ImageReportAnalyzer`（Gemini Vision） | note / lab / imaging |
| `application/dicom` | `DicomAnalyzer`（Gemini Vision） | imaging findings |
| 科研协议 Word/PDF | `ProtocolAnalyzer` | rules / schedule events |
| 普通文本 / markdown | `NoteAnalyzer` | note |

### 16.4 重试与幂等

- **重试**：`extracting` 和 `analyzing` 阶段失败时，按指数退避重试最多 3 次；成功后不再重试。
- **幂等**：`jobId = hash(fileId + analyzerVersion + patientHash + studyId)`。同一文件在上传后 24 小时内重复触发不会创建重复 job；重新上传（文件 hash 变化）会创建新 job。
- **降级**：LLM 调用失败时，可只生成 `raw_extracted_text` 类型的 `MedicalRecordEntry`，让用户手动整理，而不是完全失败。

### 16.5 通知

- `awaiting_review` 时：在 `Today` 页 widget 和 `Brain > Overview` inbox 中显示。
- `failed` 时：发送站内通知，并附带错误原因和原始文件链接。

---

## 17. MedicalRecordEntry Schema Detail

Phase 0 落地的核心表，扩展第 6.3 节的接口。

```ts
interface MedicalRecordEntry {
  id: string;
  patientHash: string;

  type: MedicalRecordEntryType;
  title: string;
  date: string;              // 医学事件发生时间（用户可修正）
  content: string;           // 人工可读摘要/正文
  aiSummary?: string;        // AI 生成的简要摘要

  // 来源
  sourceFileId?: string;
  sourceFilePage?: number;   // PDF 页码等
  sourceStudyId?: string;
  sourceJobId?: string;      // 关联 ingestion job

  // 原始数据
  extractedText?: string;    // 从文件提取的原始文本
  rawJson?: unknown;         // DICOM 元数据、化验结构化 JSON 等

  // 状态与审批
  status: 'pending_review' | 'confirmed' | 'rejected';
  createdBy: 'system' | 'user' | 'agent';
  confirmedAt?: string;
  confirmedBy?: string;
  rejectedReason?: string;

  // 版本与关联
  version: number;
  previousVersionId?: string;
  linkedRecordIds: string[]; // 关联的其他 MedicalRecordEntry

  // 元数据
  createdAt: string;
  updatedAt: string;
}

type MedicalRecordEntryType =
  | 'lab'
  | 'imaging'
  | 'pathology'
  | 'ecg'
  | 'note'
  | 'diagnosis'
  | 'medication'
  | 'procedure'
  | 'vaccination'
  | 'allergy';
```

### 17.1 索引

```sql
CREATE INDEX idx_medical_records_patient_date ON medical_record_entries(patient_hash, date DESC);
CREATE INDEX idx_medical_records_status       ON medical_record_entries(status);
CREATE INDEX idx_medical_records_type         ON medical_record_entries(type);
CREATE INDEX idx_medical_records_source_file  ON medical_record_entries(source_file_id);
CREATE INDEX idx_medical_records_job          ON medical_record_entries(source_job_id);
```

### 17.2 版本控制

- 用户编辑 `MedicalRecordEntry` 时，不原地覆盖，而是创建新版本，旧记录保留。
- `previousVersionId` 形成版本链，便于审计与回滚。
- AI 重新分析同一文件时，如果已存在 `confirmed` 条目，新生成条目仍为 `pending_review`，并提示用户“是否覆盖”。

---

## 18. Approval & Audit Workflow

所有高影响写入统一走“生成 → pending_review → 审批 → 生效”流程。

### 18.1 需要审批的操作

| 操作 | 生成者 | 审批者 | 生效后动作 |
|---|---|---|---|
| AI 生成 `MedicalRecordEntry` | Ingestion Worker / Agent | 医生 | 状态变为 `confirmed`，投影到 Memory Graph |
| `/learn` 生成 Skill | Agent | 医生 | 发布为正式 skill，可被 chat 加载 |
| Agent 提议更新 Persona | Agent | 医生 | 更新全局/患者偏好 |
| Agent 提议添加 Fact / Article | Agent | 医生 | 写入 Memory Graph |
| 科研 Rule 变更 | 用户/Agent | PI 或管理员 | 更新研究协议规则 |

### 18.2 统一审批队列

- 后端表：`approval_requests`。
- 前端入口：`Today` 页 widget + `Brain > Overview` inbox。
- 每个审批项显示：类型、来源、生成理由、diff、操作（确认/拒绝/编辑后确认）。

### 18.3 审计日志

所有状态变化写入 `audit_log`：

```ts
interface AuditLogEntry {
  id: string;
  actor: string;             // user id / agent / system
  action: string;            // e.g. 'medical_record.confirmed'
  targetType: string;        // 'MedicalRecordEntry' | 'Skill' | 'Persona' | ...
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  createdAt: string;
}
```

审计日志不可删除、不可修改，保留期限按部署合规要求（默认 7 年）。
