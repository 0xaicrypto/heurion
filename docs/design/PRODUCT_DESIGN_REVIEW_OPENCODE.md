# 产品设计评审 — 对照 opencode 的优化机会

> **背景**：拉取 opencode（`github.com/anomalyco/opencode`）源码，重点阅读其 Session Runtime
> （`CONTEXT.md` + `packages/core/src/session/`）、System Context、compaction、tool 系统
> 与 Web/Session UI。以此重新审视 Heurion 当前产品设计。
> **日期**：2026-08-02

---

## 0. 总览

opencode 本质上是一个**"会话运行时"**（durable session runtime）：把每一条消息、
工具调用、上下文来源都建模为**可持久化、可类型化、可增量更新**的实体。Heurion 是
**临床对话产品**：chat + Brain2 记忆 + 插件/技能 + 科研工作台。两者形态不同，但
opencode 在四个层面上的设计比 Heurion 当前实现更成熟：

| 层面 | opencode | Heurion 现状 |
|---|---|---|
| 系统上下文 | 类型化 Context Source 注册表 + snapshot + **增量更新** | 每轮全量重组 projection（4 层预算） |
| 压缩 | anchored summary（**更新而非重建**）+ 严格模板 | #96 硬裁剪 + 占位提示；设计稿 C.1–C.6 尚未实现 |
| 会话消息 | 类型化 Part（text/reasoning/tool/compaction/synthetic/shell）+ **工具状态机持久化** | event log 只有 user/assistant_response + metadata |
| 工具系统 | 权限即数据、输出限量、作用域注册、stale 检测 | 简单 ToolRegistry + 手写 <tool_call> 解析 |

---

## 1. 会话运行时（最高优先）

### R1. 系统上下文增量更新（Context Epoch）— 高
**opencode**：`system-context/` 把系统提示拆成**独立的 typed source**（key + codec +
loader + baseline/update/removed renderer）。每个 Context Epoch 渲染一次 baseline，
快照落库；后续每轮**只对比 source 值，变更的 source 以"会话中系统消息"增量追加**；
source 消失走 removal renderer；加载失败 = unavailable（保留旧值，不当作删除）。
效果：省 token、兼容 provider 侧 prompt cache、上下文变更可追溯。

**Heurion**：`MemoryProjection.project()` 每轮把 persona/patient/episodes/facts/skills
全量重组进 systemPrompt——即使只有 facts 变了，整个 system prompt 都重发。
**建议**：在 projection 之上引入轻量 Context Source 模式：
- `patient_context` / `episodes` / `facts` / `skills` 各自独立渲染器 + 内容 hash
- 每轮对比 hash，只把变更源以 `[Context update: facts] …` 增量消息追加
- 无变更轮次 system prompt 完全复用（配合 DeepSeek 缓存）

### R2. anchored compaction（更新式摘要）— 高
**opencode**（`session/compaction.ts`）：
- 触发：`estimate(system+messages+tools) > context - max(output, buffer)`（buffer 默认 20k），
  基于**模型实际窗口**而非固定值
- 保留最近 `tokens`（默认 8k）原文逐字，更早部分进摘要；**中间消息可拆分**（prefix 进摘要、suffix 保留）
- 摘要消息带 `summary + recent` 两字段，**下次压缩是"更新锚定摘要"**（喂旧摘要 + 新历史），
  不是从零重建
- 严格模板：Objective / Important Details / Work State(Completed/Active/Blocked) / Next Move / Relevant Files
- 工具结果序列化进摘要时截断到 2000 字符
- 摘要生成失败 → 静默跳过，不影响主流程

**Heurion**：#96 是硬裁剪 + 提示占位；`CHAT_CONTEXT_COMPACTION.md` 设计稿用的是
"生成 JSON 摘要"（decisions/pending/values）。**建议吸收**：
- 摘要改为**锚定更新**（存 summary+recent，下次更新而非重建）——省 token 且不丢旧事实
- 模板映射为临床版：Objective / 患者重要信息 / 决策与理由 / 完成 / 进行中 / 阻塞 / 下一步 / 相关文件与检查
- 触发用 `MODEL_CONTEXT_WINDOW - max(output, buffer)`，替代固定 8000

### R3. 工具调用持久化状态机 — 中
**opencode**：工具调用持久化为 `pending→running→completed/error` 的 Part 状态机，
崩溃后可从落库历史续跑；doom-loop 检测（同工具同参数 3 次 → 额外授权）。
**Heurion**：工具调用不落库（只落最终 assistant_response），中断/刷新后工具执行过程不可见。
**建议**：event log 增加 `tool_call` / `tool_result` 事件类型（含状态、参数、输出摘要），
既支持 UI 渲染进度，也为重试/审计提供基础。

---

## 2. 工具系统

### T1. 工具输出限量（bounded projection）— 高
**opencode**：`tool-output-store` 统一限量（默认 2000 行 / 50KB），超限**头部+尾部采样**
（head/tail 各半）并落 managed file，消息里只留 marker。工具本身可自定义"喂给模型的视图"
（`toModelOutput`）。
**Heurion**：`search_node` 等工具把完整 JSON 注入下一轮对话，长结果直接膨胀上下文。
**建议**：ToolRegistry.execute 之后统一 `bound()`：>2000 行/50KB 截断为 head+tail
采样，完整结果落盘（`uploads/` 或独立 tool-output 目录），消息里给 marker；搜索结果
类工具输出改为紧凑摘要视图。

### T2. 权限即数据（allow/deny/ask 规则集）— 中
**opencode**：每个 agent/会话/工具可带 Ruleset（`Rule{action, resource, effect}`，
wildcard 覆盖，后匹配优先）；`ask` 非阻塞发事件、`assert` 阻塞等用户；"always" 持久化。
**Heurion**：审批是硬编码的 `approval.service`（targetType 白名单 + isAdmin），
规则不可配置。
**建议**：把审批建模为可配置规则集（哪些工具/条目需要人工确认、哪些自动放行），
为后续"PI/医生/管理员"角色差异化审批铺路。

### T3. 子代理 = 独立会话（上下文隔离）— 中
**opencode**：Task 工具为子代理新建独立 Session（parentID 树），子代理有独立历史/
模型/权限，父会话只拿 `<task_result>` 摘要；可续跑（task_id）、可后台化（background）。
**Heurion**：无委派机制；长任务（如科研入组筛选、DICOM 批量分析）都在主会话内做。
**建议**：为耗时的分析类工作引入"后台任务 + 结果注入"模式（已有 execution/worker 基建，
缺的是"结果以 synthetic 消息注入会话"和"子上下文隔离"）。

### T4. 作用域注册 + stale 检测 — 低
插件热增删工具时，模型可能调用已被替换的工具。opencode 在 settle 时检测 stale 并
返回明确错误。Heurion 插件系统可加同样检查（低成本高价值）。

---

## 3. 技能系统

### S1. 清单注入 + 按需加载 — 低（已部分覆盖）
opencode：系统上下文只放 `<available_skills>` 清单，模型调用 `skill` 工具时才读全文注入。
Heurion：projection layer4 已只注入"名称+策略"指引（类似 guidance）——**方向一致**。
缺口：模型无法按需加载技能全文；如需扩展，加一个 `load_skill` 工具即可。

---

## 4. UI / UX（可移植性强，性价比高）

### U1. 流式 markdown 三件套 — 高
opencode：块级投影（已完成的块全量渲染、尾部未完成块 heal）+ **节奏控制**（24ms
步进渲染 + 标点吸附，避免每 token 重排）+ worker 流式高亮。
**Heurion**：react-markdown 每 chunk 全量重解析重渲染，长文流式时明显卡顿。
**建议**：至少实现前两层——按块切分 + 尾部块只追加文本、流式期间节流渲染
（当前 chunk 是 80 字符/帧，可先做"非流式结束才全量渲染 + 流式时简化渲染"）。

### U2. 工具调用分组折叠（ContextToolGroup）— 中
opencode：连续 read/grep/glob 合并为一行 "Gathering context · 5 files"，数字动画。
**Heurion**：工具调用各自为一行（目前 tool_call 甚至不展示过程）。
**建议**：chat UI 把检索类工具折叠成一行进度摘要（"已检索 N 条患者记忆"），
推理链更可读。

### U3. 上下文用量圆环 + 构成堆叠条 — 中（与 C5 呼应）
opencode：顶栏 16px 百分比圆环（hover 显示费用/用量/tokens），详情面板按
system/user/assistant/tool 分色堆叠条。
**建议**：按 CHAT_CONTEXT_COMPACTION C5 实现 `context_usage` chunk 后，UI 直接采用
圆环 + 堆叠条；顺带展示 cache read/write（DeepSeek 有 context caching）。

### U4. Compaction 分隔线 — 低
opencode：`— 压缩历史记录 —` 居中弱化分隔线 + 渐变线，压缩摘要正文独立弱化显示。
**建议**：实现自动压缩时同步做这个 UI（成本低，用户感知强）。

### U5. Reasoning 摘要标题 — 低
opencode：reasoning 流式时提炼 markdown 标题，默认折叠为一行
`+ Thought: <标题> · <时长>`。
**Heurion**：reasoning 全部展开在 details 里，长思考体验差。
**建议**：取 reasoning 第一行/标题 + 时长，折叠展示。

### U6. 虚拟时间线 + 滚动快照 — 低（会话很长时）
opencode：虚拟化 + 切会话恢复滚动位置 + 上滚暂停自动跟随。
**建议**：Heurion 会话目前够短，列为远期。

---

## 5. 可靠性 / 可观测

### O1. 每会话串行协调 + wake 合并 — 低
opencode：run-coordinator 按 sessionID 串行、运行中唤醒只置标记、结束后自动续跑。
Heurion 单线程 chat 已有类似语义，无需大改；后台任务（ingestion/evolution）可复用该模式。

### O2. 会话快照 / 步骤 patch — 远期
opencode：每步 git-tree 快照 + patch part，可预览/回滚。
临床场景等价物：**每轮生成的 MedicalRecordEntry 已经版本化**（PATCH 新版本）——
这个能力 Heurion 已有且适配得更好，无需照搬。

### O3. Context 度量（cache read/write）— 中
opencode：context 面板显示 cache read/write tokens。
**建议**：LLM telemetry 已记录 usage；增加 cache 字段展示，指导"何时该开新会话"。

---

## 6. 优先级路线

| 优先级 | 项 | 预估 |
|---|---|---|
| P0 | R1 上下文增量更新、R2 锚定压缩（改 CHAT_CONTEXT_COMPACTION 设计） | 3–4d |
| P0 | U1 流式 markdown 块投影 + 节流 | 2–3d |
| P1 | T1 工具输出限量、R3 工具调用落库 | 2–3d |
| P1 | U3 context 圆环 + 堆叠条（C5）、U2 工具折叠 | 2d |
| P2 | T2 权限规则集、S1 load_skill 工具、T4 stale 检测 | 2–3d |
| P2 | U4 压缩分隔线、U5 reasoning 标题、O3 cache 度量 | 1–2d |
| 远期 | T3 子代理委派、U6 虚拟时间线 | — |

---

## 6.5 与现有知识库的协同

新设计与现有知识库（`docs/design/knowledge-base-design.md` v2.2）是**互补关系**：
知识库是跨会话的长期事实存储（可版本化、可审批），本设计的优化集中在单会话运行时。

```
知识库（现有，跨会话）                会话运行时（新设计，单会话）
Facts / Articles / Persona / Gaps ←── 每轮上下文组装（R1）
T+1 facts 提取、T+30s 文章合成   ←── 压缩的"安全网"（R2）
expand() 按需加载（§4.3，未实现）←── 工具输出限量（T1）/ load_skill（S1）
文章 / gap / feedback 审批流转   ←── 权限规则集（T2）
```

### 逐项配合

| 新设计项 | 与知识库的配合 |
|---|---|
| **R1 增量更新** | KB 是天然 Context Source：`kb/facts`（版本化 `v{N}.json` → hash 变更检测）、`kb/articles`（`status=current`）、`kb/persona`（动态合成，可缓存）。KB §4.2 三级压缩即现有 `context-compressor.ts`，R1 将其正式化为 facts 源的渲染器 |
| **R2 锚定压缩** | KB 是压缩的安全网：事实提取管道（T+1/T+30s）已把对话沉淀入库，压缩可放心裁剪旧对话。闭环①：压缩摘要（患者重要信息/决策）→ facts 提取（`sourceType: patient`）双保险入库；闭环②：锚定摘要更新时以 KB 文章/事实为基线，避免从零重建 |
| **T1 输出限量** | KB 查询（search/gaps/article）返回的文章全文是"大输出"典型；配合 KB §4.3 的 `expand()` 按需加载（**该模式目前未实现**），超长文章走限量 + 展开 |
| **S1 技能加载** | 正交：KB = 陈述性知识（是什么），Skills = 程序性知识（怎么做）。建议统一为按需加载工具族：`expand(article)` + `load_skill(name)` |
| **T2 权限规则** | KB 已有审批语义（文章 current/stale/superseded、gap resolve/ignore、sidecar feedback saveAll）——规则集可覆盖"谁可确认文章合成 / 谁可 resolve gap"，替换隐式逻辑 |
| **U3 用量 UI** | 堆叠条应包含 `kb/facts`、`kb/articles` 分段，直观展示知识库上下文占比 |

### 现状缺口

KB 设计 §4.3 的"分层加载 expand()"从未实现（现有命令只有 remember / search / summarize / gaps）。
建议将 `expand(article)` 并入 S1（#106），实现统一的按需加载工具族。

---

## 7. 不建议照搬的部分

- **快照/patch 回滚**：临床场景由 MedicalRecordEntry 版本控制 + 审批流程替代，更合规。
- **Effect Schema 全套**：Heurion 用 zod + Fastify，能力等价，无需换框架。
- **durable session store / 事件总线**：Heurion 的 event log + prisma 已够用；
  增量式引入会增加复杂度。
