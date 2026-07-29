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

## 13. 剩余开放问题

1. 向量存储选型：SQLite 扩展 / pgvector / 内存 HNSW？
2. Embedding 模型：本地模型还是 API？
3. MedicalRecordEntry 的 `type` 枚举是否要扩展（例如病理、心电图）？
4. Ingestion 中 DICOM 分析是继续用 Gemini Vision，还是复用 Python legacy pipeline？
5. 病例报告共享的安全模型：只读 token / 院内用户 / 匿名链接？
6. `/learn` 生成的 skill 是否默认需要用户审批？（建议：必须审批）
7. 记忆预算的 token 上限是否按模型动态调整？
8. Experience Synthesis 触发条件：手动 / 定时 / 里程碑事件？
