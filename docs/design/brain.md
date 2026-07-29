# Brian 2.0 — 统一记忆中枢设计

**状态：** 设计提案 v2.0  
**日期：** 2026-07-29  
**范围：** `packages/web`、`packages/server-ts`  
**相关文档：**
- `docs/design/web-ui-redesign.md`（浏览器优先的 UI 架构）
- `docs/design/MEMORY_KNOWLEDGE_EVOLUTION_REFACTOR.md`（记忆/知识/进化系统重构）
- `docs/design/knowledge-base-design.md`（知识库产品设计）

---

## 0. 一句话目标

把 Heurion 从“一个会查资料、能记录 fact 的助手”，升级成**一个会自己记笔记、写手册、整理知识的临床 agent**。

> **代号：Brian 2.0** —— 比 Brain 多一个“i”，代表 intelligent、interactive、iterative。

---

## 1. 我们从 Hermes 学到了什么

我们分析了 `NousResearch/hermes-agent`。它最值得我们借鉴的不是技术栈，而是三个产品设计直觉：

1. **记忆是 agent 自己写的笔记**：`MEMORY.md` / `USER.md` 直接出现在 system prompt 里，agent 知道自己在写什么、为什么写、写满了怎么办。
2. **技能就是操作手册**：`SKILL.md` 是 markdown 文档，agent 按需加载， `/learn` 能把刚完成的任务自动转成 skill。
3. **写记忆/技能前要有审批**：`write_approval` gate 防止 agent 污染自己的长期记忆。

Hermes 是为单用户个人 agent 设计的（数据在 `~/.hermes/`，一个 profile 一个环境）。我们不会照搬它的进程模型，但会把这三个思想吸收进我们的多租户、事件驱动、版本化的架构里。

---

## 2. 当前设计的问题

| 问题 | 表现 | 从 Hermes 得到的启发 |
|---|---|---|
| 记忆对 agent 不透明 | facts/articles 存在 DB，agent 不能主动读写 | 给 agent 一个 `brain` tool |
| Persona 是只读摘要 | 用户看不到、agent 也不能更新 | Persona 应该是 agent 可写的身份文件 |
| Skills 不是文档 | 技能是代码/plugin，全部塞进 prompt | 引入 SKILL.md + 按需加载 |
| 没有写前审批 | 自动提取的 fact 直接入库 | 高影响记忆/技能写入需要用户确认 |
| 没有记忆硬预算 | 记忆可能无限增长 | 给核心记忆设 token/char 上限，强制合并/遗忘 |
| 没有会话级全文搜索 | 只有 activity feed | 加 `session_search` tool |
| 上下文压缩策略缺失 | 长对话靠硬截断 | 中间轮次 summarization |

---

## 3. 设计原则

1. **EventLog 是唯一真相源**：所有记忆/知识/Persona/Skill 的变更先写事件，再投影到查询视图。
2. **Agent 可读写**：agent 不只是记忆的消费者，也是记忆的整理者。
3. **人类在关键环节把关**：高影响写入需要审批，人类可以随时覆盖、删除、锁定。
4. **记忆有预算**：核心记忆必须_bounded_，超出时 agent 要负责 consolidate。
5. **技能即文档**：Skill 是 markdown 手册，支持渐进加载，agent 能生成、能学习。
6. **患者上下文是一等公民**：全局大脑和患者大脑共享同一套组件，只是过滤条件不同。

---

## 4. 信息架构

### 4.1 全局路由

```
/app/today                 今日概览
/app/brain                 全局大脑（Overview / Knowledge / Graph / Persona / Skills）
/app/research              科研空间
/app/writing               写作空间
/app/settings              设置（含 Plugins、LLM、Profile、Observability）
```

### 4.2 患者嵌套路由

```
/app/patient/:hash         患者摘要
/app/patient/:hash/chat    问诊聊天
/app/patient/:hash/imaging 影像
/app/patient/:hash/labs    化验
/app/patient/:hash/memory  患者大脑
/app/patient/:hash/report  报告
```

### 4.3 Brain 页内 tab

```
/app/brain                 → Overview
/app/brain/knowledge       → Knowledge（facts / articles / gaps / documents）
/app/brain/graph           → Graph（记忆图谱）
/app/brain/persona         → Persona（动态人设）
/app/brain/skills          → Skills（技能手册）
```

患者大脑同样支持这五个 tab，只是默认按 `patientHash` 过滤。

---

## 5. 核心概念

### 5.1 Global Brain（全局大脑）

跨患者的记忆与知识总览。包含：
- 所有 facts / articles / gaps / skills / entities / documents
- 跨患者统计与最近活动
- 全局 Persona
- 全局 Skills（临床通用手册）

### 5.2 Patient Brain（患者大脑）

当前患者的记忆视图。**不是独立数据模型**，而是全局大脑按 `patientHash` 过滤后的聚焦视图。

**默认显示：**
- 该患者的 facts / findings / medications / documents
- 相关 articles / gaps / conflicts / reports

**可选叠加（低透明度）：**
- 全局 skills
- 通用医学知识 articles

**Persona tab：** 患者大脑的 Persona tab 允许修改全局 preferences（这是用户级配置，不属于单个患者）。修改后同步到全局 Persona。

### 5.3 Persona（可写身份）

系统每次聊天前根据记忆动态生成的“系统人设”。在 Brain 中：
- 展示 `preferences`、`goals`、`keyFacts`
- 标注每条内容来自哪些 facts/articles
- **agent 可以在聊天中提议更新**（如“你似乎更关注副作用，是否把这点加入 Persona？”）
- 用户可手动添加/删除/锁定

### 5.4 Skill（程序性记忆）

- 用 `SKILL.md` 描述一个可复用的临床流程或策略
- **存储为 memory graph 节点**，节点 `content` 字段保存 markdown 全文
- 支持渐进加载：列表 → 摘要 → 全文
- agent 可提议创建新 skill（`/learn`）
- 用户可编辑、锁定、禁用

---

## 6. 记忆模型：从“数据库”到“agent 的笔记本”

### 6.1 三层结构

```
┌─────────────────────────────────────────┐
│  Runtime View（运行时投影）              │
│  - Persona block                         │
│  - Relevant facts/articles               │
│  - Active skills                         │
├─────────────────────────────────────────┤
│  Memory Graph（结构化查询视图）          │
│  - Nodes: fact / article / gap / skill   │
│  - Relations: derives_from / depends_on  │
├─────────────────────────────────────────┤
│  Event Log（唯一真相源）                 │
│  - memory_fact_extracted                 │
│  - memory_article_synthesized            │
│  - memory_persona_updated                │
│  - memory_skill_learned                  │
└─────────────────────────────────────────┘
```

### 6.2 Agent 可写记忆的机制

在聊天中给 agent 一个 `brain` tool：

```json
{
  "action": "add_fact",
  "content": "患者对青霉素过敏，曾出现皮疹",
  "category": "allergy",
  "importance": 5,
  "patientHash": "abc123"
}
```

```json
{
  "action": "update_persona",
  "target": "preferences",
  "operation": "add",
  "text": "用户倾向于先看药物相互作用再讨论剂量"
}
```

```json
{
  "action": "learn_skill",
  "name": "diabetes-followup",
  "description": "2 型糖尿病随访检查清单",
  "source_turn_ids": ["turn_1", "turn_2"]
}
```

**写前审批：**
- `importance >= 4` 或涉及患者的 fact → 需要用户确认
- 新 skill / 修改 locked skill → 需要用户确认
- 普通 fact / preference 可自动写入

### 6.3 记忆预算（Memory Budget）

给核心记忆设置上限，超出时 agent 必须 consolidate：

| 区域 | 预算 | 超出行为 |
|---|---|---|
| Persona preferences | ~500 tokens | agent 合并相似项 |
| Persona goals | ~300 tokens | agent 删除已达成目标 |
| Key facts（注入 prompt） | ~1,500 tokens | 按 importance × recency 淘汰 |
| Active skills | ~2,000 tokens | 按使用频率卸载 |

预算信息要反馈给 agent，让它在写之前就知道还剩多少空间。

### 6.4 会话搜索（Session Search）

所有聊天记录写入 SQLite + FTS5。agent 可以使用 `session_search` tool：

```json
{
  "query": "患者上次肝功能异常是什么时候",
  "patientHash": "abc123",
  "limit": 5
}
```

返回实际对话片段，不是 summarization。

---

## 7. Skill 系统设计

### 7.1 SKILL.md 格式

```markdown
---
name: diabetes-followup
description: 2 型糖尿病随访检查清单
version: 1.0.0
author: heurion
metadata:
  heurion:
    tags: [endocrinology, diabetes, follow-up]
    requires_toolsets: [labs]
    patient_scoped: true
---

# 2 型糖尿病随访

## When to Use
患者已确诊 2 型糖尿病，需要定期随访时。

## Procedure
1. 询问近 2 周低血糖/高血糖事件
2. 检查 HbA1c、空腹血糖、肾功能
3. 评估用药依从性
4. 调整药物或生活方式建议

## Pitfalls
- 不要只调药不看饮食和运动
- eGFR < 30 时慎用二甲双胍

## Verification
- 患者能复述下次复诊时间和检查项目
```

### 7.2 渐进加载

```
Level 0: skills_list()        → name + description (~3k tokens)
Level 1: skill_view(name)     → full SKILL.md
Level 2: skill_view(name, path) → specific reference
```

### 7.3 自动学习（`/learn`）

agent 完成复杂任务后可以提议：

> “我注意到你经常让我按这个流程处理糖尿病随访。要不要把它保存为一个 skill，下次直接调用？”

用户确认后，agent 用 `learn_skill` action 生成 SKILL.md，经审批后存入事件流。

### 7.4 技能审批

- 新 skill / 修改 skill → 用户审批
- 官方 skill（heurion 提供）默认锁定，用户可 fork
- 患者特异性 skill 标记 `patient_scoped: true`

---

## 8. Graph 大脑化设计

记忆图谱不只是可视化，要体现“神经网络/脑区”心智模型。

### 8.1 视觉

- 深色画布
- 节点：神经元形态，按类型着色
- 边：弯曲突触，按关系类型着色
- 聚类：compound nodes 表示患者/主题脑区
- 最近更新节点：缓慢脉冲

### 8.2 交互

- 点击节点：高亮相邻 1-hop，其余 dim
- 双击：进入聚焦模式
- 搜索：实时过滤
- 布局切换：`cose` / `circle` / `grid`

### 8.3 HUD

右上角显示：
- 节点/边总数
- 活跃 facts 数（24h 内）
- 未解决 gaps 数
- 当前布局名

### 8.4 3D 图谱（远期路线图）

- 使用 `react-force-graph-3d` 或 `three.js` 实现立体神经网络
- 节点按 z 轴分层：患者层 / facts 层 / articles 层 / skills 层
- 支持 VR/AR 浏览（可选）
- 先在 2D 大脑化成熟后再启动

---

## 9. 后端 API 设计

### 9.1 `GET /api/v1/agent/brain`

```ts
interface BrainOverview {
  stats: {
    facts: number;
    articles: number;
    gaps: number;
    skills: number;
    entities: number;
    documents: number;
    conflicts: number;
  };
  personaSummary: string;
  recentActivity: ActivityItem[];
  openGaps: Gap[];
  topKnowledge: Article[];
  topSkills: Skill[];
}
```

### 9.2 `GET /api/v1/agent/persona`

```ts
interface PersonaResponse {
  preferences: PersonaItem[];
  goals: PersonaItem[];
  keyFacts: PersonaFact[];
  knowledgeArticles: { id; title; summary }[];
  budget: { usedTokens; totalTokens };
  generatedAt: string;
}
```

### 9.3 `POST /api/v1/agent/brain/actions`

agent 通过 tool 调用，统一入口：

```ts
interface BrainAction {
  action: 'add_fact' | 'update_fact' | 'delete_fact'
        | 'update_persona' | 'learn_skill' | 'update_skill'
        | 'answer_gap' | 'ignore_gap';
  payload: Record<string, unknown>;
}
```

所有 actions 都写入 EventLog，返回是否需要用户审批。

### 9.4 `POST /api/v1/agent/search/sessions`

会话级全文搜索：

```ts
interface SessionSearchRequest {
  query: string;
  patientHash?: string;
  limit?: number;
  offset?: number;
}
```

### 9.5 现有 API 复用

- `/api/v1/knowledge/articles`、facts、gaps
- `/api/v1/agent/activity`
- `/api/v1/memory/graph`

---

## 10. 前端架构

### 10.1 新建/重构文件

```
packages/web/src/
  routes/
    brain.tsx                 # BrainPage，含 tab 切换
    patient.tsx               # PatientLayout
    settings.tsx              # 新增 Plugins tab
  components/brain/
    BrainOverview.tsx
    BrainKnowledge.tsx        # 复用 KnowledgeHub
    BrainGraph.tsx            # 复用 Cytoscape 图谱
    BrainPersona.tsx
    BrainSkills.tsx
    BrainNav.tsx
  components/patient/
    PatientHeader.tsx
    PatientModeTabs.tsx
```

### 10.2 旧页面处理

| 旧页面 | 处理 |
|---|---|
| `/app/knowledge` | 直接删除，功能并入 `/app/brain/knowledge` |
| `/app/memory` | 直接删除 |
| `/app/memory-graph` | 直接删除 |
| `/app/memory-graph-viz` | 直接删除 |
| `/app/plugins` | 移至 `/app/settings/plugins` |

### 10.3 侧边栏

```
Today
Patients
Brain
Research
Writing
Settings
```

Plugins 管理入口从侧边栏移除，收进 Settings。

### 10.4 插件在前端的暴露位置

插件是“系统扩展”，应该分三层暴露：

1. **管理入口：Settings > Plugins**
   - 安装 / 启用 / 停用 / 删除
   - 插件设置
   - 开发者模式 / 日志
   - 路由：`/app/settings/plugins`

2. **能力发现：Brain > Skills**
   - 已安装插件提供的 skills / tools 作为 skill 卡片展示
   - 每个卡片显示来源插件、版本、状态
   - 提供 “Browse plugin marketplace” 快捷入口

3. **使用入口：Chat Composer**
   - `/` slash 菜单中列出插件提供的 skills/tools
   - 聊天中 agent 可直接调用插件工具

这样既不把 marketplace  bury 在 Settings 里，也不让主导航被 Plugins 占据。

---

## 11. 实现阶段

### Phase 1：Backend 基础
1. 扩展 EventLog schema，支持 `memory_*` / `skill_*` / `persona_*` 事件。
2. 实现 `BrainService`：统一处理 brain actions，包括审批判定。
3. 实现 `POST /api/v1/agent/brain/actions`。
4. 实现 `GET /api/v1/agent/brain` 和 `GET /api/v1/agent/persona`。
5. 实现 `POST /api/v1/agent/search/sessions`（SQLite FTS5）。

### Phase 2：Brain 页面
1. 抽出 `KnowledgeHub` 和 `BrainGraph`。
2. 新建 `BrainPage` + 5 个 tab。
3. 实现 `/app/brain/skills` 列表/查看。
4. 侧边栏改为 Brain 单一入口。
5. 删除旧 `/app/knowledge`、`/app/memory*` 路由。

### Phase 3：Agent 可写记忆
1. 给 chat orchestrator 暴露 `brain` tool。
2. 实现写前审批逻辑。
3. 在 UI 中显示待审批的 brain actions。
4. 实现 Persona 更新提议的展示和确认。

### Phase 4：Skill 系统
1. 定义 SKILL.md schema。
2. 实现 skill 存储：作为 memory graph 节点，`content` 字段存 markdown 全文。
3. 实现 `/learn` 流程。
4. 在 chat 中支持 `/skill-name` 快捷加载。

### Phase 5：Graph 大脑化
1. 深色主题、神经元节点、突触边。
2. Compound nodes 脑区聚类。
3. 脉冲动画、聚焦交互、HUD。

### Phase 6：患者路由重构
1. 新建 `PatientLayout` + `PatientModeTabs`。
2. 改为 `/app/patient/:hash/*`。
3. 患者大脑复用 `BrainPage patientScoped`。

### Phase 7：收尾
1. Plugins 管理入口移到 `/app/settings/plugins`。
2. 在 Brain > Skills 中暴露插件提供的 skills/tools。
3. 旧 `/app/chat` 重定向到 `/app/patient/:hash/chat`（使用最近活跃患者）。
4. 更新 `web-ui-redesign.md`。
5. 全量测试。

---

## 12. 测试计划

| 层级 | 内容 |
|---|---|
| 后端 | Brain actions 写入 EventLog；审批逻辑；权限隔离；session search |
| 前端 | Brain tab 切换；skills 渐进加载；待审批列表 |
| e2e | 聊天中 agent 提议添加 fact → 用户确认 → Brain 中可见 |
| 视觉 | Graph 主题化回归 |

---

## 13. 已确认决策

1. **Skill 存储格式**：作为 memory graph 节点，`content` 字段保存 markdown 全文。
2. **患者大脑 Persona tab**：允许修改全局 preferences（用户级配置）。
3. **Graph 3D**：纳入远期路线图，2D 成熟后再启动。
4. **旧 `/app/chat`**：重定向到 `/app/patient/:hash/chat`，使用最近活跃患者。
5. **插件前端位置**：管理入口在 `Settings > Plugins`，能力发现和使用入口分别在 `Brain > Skills` 和 `Chat Composer`。

## 14. 剩余开放问题

1. 插件 marketplace 的发现卡片在 Brain > Skills 中占多大比重？
2. `/learn` 生成的 skill 是否默认需要用户审批，还是低影响 skill 可自动发布？
3. 记忆预算的 token 上限是否按模型动态调整？
4. 活跃患者多久未操作后清空，重定向到患者列表？

