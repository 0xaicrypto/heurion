# Skills 进化环唤醒设计 — 程序性记忆闭环

**Status:** Approved v1.0（2026-09-04 评审通过，D1-D6 决策记录见 §6）
**更新:** 2026-09-04
**Deciders:** JZ (architect)
**关联:** epic #841（本设计的跟踪 epic）；#839 写入闸门统一（skill 提案复用 propose）；#840 双存储收敛（读路径切换清单包含 skills）；#817 brain2.0 治理先例（设计先行 + 回归锁定）；TURN_INTENT_DESIGN §3（TurnIntent 动作信号）；现有零件 #298（capture）/ #24（experience-synthesis）/ #106（load_skill）/ #737（episodes）。

---

## 0. 现状盘点 — 三个表示 × 三条断链（2026-09-04 代码核查）

### 0.1 skill 的三套表示互不相通

| 表示 | 位置 | 契约形状 | 现状 |
|---|---|---|---|
| `CapturedSkill` | Prisma 表（skill-capture.service.ts:54） | **富契约**：name/description/steps/prompt/status(draft→confirmed) | 入口活：#298 显式捕捉 + #24 经验合成（24h 调度器在跑，experience-synthesis.service.ts:145） |
| `LearnedSkill` | VersionedStore 文件（evolution/stores.ts:41） | **贫契约**：仅 name/taskKind/bestStrategy/taskCount/successCount/failureCount，**无剧本** | 出口活：Layer 4 索引注入（memory-projection.ts:203）+ `load_skill` 工具（skill-tools.ts:34）都读它 |
| `SkillNode` | memory graph 类型（memory.types.ts:73） | 镜像 LearnedSkill 贫契约 | 类型已定义，无写入方 |

### 0.2 三条断链

1. **断链 1 — 建了不用**：`capturedSkill` 在 `modules/skills/` 之外**零引用**——医生确认（confirm）后的技能永远进不了注入层，Skills 页之外是死数据。捕捉/合成两条入口白跑。
2. **断链 2 — 进化无原料**：`SkillsStore.recordTask`（evolution/stores.ts:231）全仓零调用方，没有任何"任务轨迹"采集，归纳器无从谈起。
3. **断链 3 — 契约不兼容**：CapturedSkill 有剧本（steps/prompt）无统计；LearnedSkill 有统计无剧本。即使搭桥也无法互通，必须先统一契约。

> 结论：问题不是"缺一条进化环"，而是**三个半成品各缺一截**。本设计先把三者收敛为一个契约，再补齐缺的那截（轨迹采集 + 遵循度反馈）。

---

## 1. 核心决策 C1 — 统一 skill 存储：graph SkillNode 为单一事实源

对齐 #840 的方向（graph 单一事实源、派生投影可重建）：

- **SkillNode 扩展为完整契约**（§2），成为 skill 的唯一权威存储；
- **CapturedSkill 降级为 intake 草稿区**：draft/refine 流程不动（#298 医生自然语言微调的 UX 保留），confirm 动作 = 写入 graph SkillNode（走 propose 闸门，见 §3.3）+ CapturedSkill 行标记 `promoted`。Prisma 表不再承担"已生效技能"的存储职责；
- **LearnedSkill/VersionedStore 退役**：纳入 #840 切换清单，Layer 4 与 `load_skill` 改读 graph（或其派生索引）；
- **experience-synthesis（#24）收编**：触发条件从"category ≥3 facts"改为"轨迹聚类达标"（§3.2），避免两套归纳并存；其 LLM 合成模式（fast tier + STRICT JSON + parseLlmJson）复用。

迁移安全性：存量 CapturedSkill confirmed 行一次性迁移为 SkillNode（幂等脚本，模式同 kb-rename-migration.ts:7）；LearnedSkill 文件数据量极小（recordTask 从未运行），直接废弃不迁移。

---

## 2. Skill 统一契约（SkillNode v2）

```ts
interface SkillNode extends MemoryNodeBase {
  type: 'skill'
  // ── 剧本（来自 CapturedSkill 富契约）──
  name: string                  // ≤120 chars
  description: string           // 一句话适用场景，≤300
  steps: string[]               // 步骤列表，单步 ≤500
  promptTemplate: string        // ≤4000，load_skill 返回的正文
  // ── 检索与激活（新增）──
  taskKind: TurnAction          // 'edit' | 'generate' | 'retrieve' | 'command'（对齐 TurnIntent）
  triggers: string[]            // 激活匹配特征（场景关键词/文档类型/期刊名），≤10 条
  scope: 'personal' | 'institution'   // 默认 personal；institution 显式 opt-in（§5）
  // ── 证据链（来自归纳，新增）──
  evidence: {
    trajectoryIds: string[]     // 支撑本 skill 的任务轨迹 id（≥5）
    sessionIds: string[]        // 溯源会话（审批 UI 反查用）
    observationCount: number
    correctionRate: number      // 归纳时用户修正率
  }
  source: 'capture' | 'synthesis' | 'marketplace'   // marketplace 见 D4
  // ── 统计（来自 recordTask，沿用）──
  taskCount: number
  successCount: number
  failureCount: number
  followRate: number            // 遵循率（§3.5 维护）
  // ── 生命周期 ──
  status: 'active' | 'suspended' | 'deprecated'
  version: number               // stableId@vN，沿用 fact 版本语义
}
```

设计要点：
- **`taskKind` 对齐 TurnIntent**（TURN_INTENT_DESIGN §3）而非自造动作集——激活匹配直接复用 intent-router 的判定信号，零额外 LLM。
- **evidence 与统计分离**：evidence 是"诞生证据"（不可变，审批时看），统计是"运行证据"（持续演化，降级判定看）。
- **`status: 'suspended'` 是一等状态**：降级不删除（§3.5），医生重审后可恢复。

---

## 3. 五环设计

### 3.1 环① 任务轨迹采集（recordTask v2）

**触发**：postTurn（chat-orchestrator.ts:31 既有钩子），仅任务型回合记录——`TurnIntent.action ∈ {edit, generate, retrieve, command}`；纯对话（answer）不记。

**轨迹 schema**（`TaskTrajectory`，操作元数据，零正文）：

```ts
interface TaskTrajectory {
  id: string                    // trj_
  userId: string
  sessionId: string
  turnId: string
  action: TurnAction            // 与 SkillNode.taskKind 同枚举
  scene: Scene                  // general/patient/document/chart
  toolsUsed: string[]           // 工具名序列（按调用序）
  docEdits: { count: number }   // 编辑类回合的写回次数
  outcome: 'completed' | 'abandoned' | 'corrected'
  userCorrection: boolean       // AI 产出后用户拒绝/重做（隐式反馈信号）
  durationMs: number
  createdAt: number
}
```

**存储（决策 D1，见 §6）**：**不新增 graph 节点类型**——EventLog 已按 session 记录轮事件（chat-orchestrator `query({sessionId})`），轨迹作为 eventLog 之上的**投影聚合**（每回合终了聚合一条，内存 Map + 定期物化到 VersionedStore，模式同 episodes）。理由：轨迹是高频低值数据，进 graph 会稀释图谱密度与向量索引质量；投影可随时从 eventLog 重建。

**成本**：零 LLM、零外呼，纯结构化记录。隐私天然安全：不含患者正文、不含文档内容。

### 3.2 环② 归纳（轨迹 → skill 候选）

**触发条件**（对齐 coverage 调度模式，不硬编码时间）：

| 条件 | 默认值 | 理由 |
|---|---|---|
| 同 `taskKind` + 同工具序列指纹（toolsUsed 序列 hash）聚类 | — | 序列指纹是"做法"的最小充分统计 |
| `observationCount ≥ N` | 5 | 一次是巧合，五次是习惯 |
| 时间跨度 ≥ 14 天 | — | 防止短期集中操作误归纳 |
| `correctionRate ≤ 0.3` | — | 用户频繁修正的做法不值得学 |

**首发范围（决策 D2，见 §6）**：仅 `action='generate' ∧ scene='document'`（写作流程）。与 #382 期刊模板联动：已选模板的结构偏好（章节顺序/图表位/字数习惯）是最高价值且最可验证的信号。检索策略归 knowledge（更像陈述性偏好），汇报框架 Phase 3；扩类型门槛：采纳率>50% ∧ 遵循率>60%。

**归纳器**：复用 experience-synthesis 的 LLM 模式——fast tier、STRICT JSON、parseLlmJson 容错（#694）；输入从"事实列表"改为"轨迹聚类摘要"（工具序列 + 编辑计数 + 场景，**仍零正文**）。输出候选（name/description/steps/promptTemplate/triggers）。

**产物路径**：候选 → `gateway.propose`（**对齐 #839，skill 提案为新的提案类型**）→ 审批 → 写入 graph。绝不直写。

### 3.3 环③ 质量闸门（证据链 + diff 预览）

- 提案 payload 三件套：候选剧本 + evidence（≥5 条 trajectoryId，审批 UI 可反查会话）+ **diff 预览**——渲染"激活后医生会看到什么"的剧本卡样例（§3.4），让审批者看到行为影响而非抽象描述。
- 审批 UI 复用 approval.service 模式（#666 审批请求钩子），追加展示：观察次数 / 修正率 / 溯源会话列表。
- **PII 硬线**：轨迹与归纳输入零正文（架构性保证，非过滤性保证）；提案落库前跑患者标识扫描（姓名/hash/住院号正则 + 已有脱敏器），命中即拒绝并标记。
- **scope**：默认 `personal`；`institution` 需机构管理员显式开启且逐条确认（跨医生共享 = 跨主体数据流动，走显式授权而非默认）。

### 3.4 环④ 按需激活（Layer 4 v2）

**保留 #106 两段式骨架**（索引进 prompt + `load_skill` 拉全文——这个设计本来是对的），改的是**谁进索引**：

- 现状：`params.skills` 截前 N 无条件注入（memory-projection.ts:206-208），store 为空时索引为空（无害），但一旦有 skill 就会盲目全量注入。
- v2：索引槽位改为 **trigger 匹配**——匹配函数**零 LLM**：
  1. `taskKind` 相等（intent-router 本轮判定结果）；
  2. `triggers` 关键词与本轮 query/scene/document 上下文倒排匹配（≥1 命中）。
- 命中 → 索引注入**剧本卡摘要**（name + description + followRate 统计，≤3 条）；模型认为相关再 `load_skill` 拉全剧本。
- 无命中 → 索引为空，零 token 消耗。
- 降级：intent 判定为 `uncertain` 时本轮不激活（宁可不注入，不可错注入）。

token 经济：skills 从"有就全塞"变为"按需 ≤3 条摘要 + 显式拉取"，是本环可规模化的前提。

### 3.5 环⑤ 遵循度度量（闭环的闭环）

**遵循判定**（零 LLM）：
- `generate/command` 类：激活后该回合实际工具序列与剧本 steps 的工具序列指纹比对（序列包含即算遵循）；
- `edit` 类（决策 D5，见 §6）：退化为产出物判定——是否完成了剧本声明的产出类型（如"逐节写回 → docEdits.count ≥ 3"）。

**telemetry 四事件**（telemetry.service 既有基建）：`skill_activated` / `skill_followed` / `skill_ignored` / `skill_task_outcome`（含 success/abandoned/corrected）。每次注入与判定可回放（审计要求，§5）。

**自动降级**：滑动窗口（最近 10 次激活）`followRate < 0.4` → SkillNode `status='suspended'` + 通知医生重审。**降级不删除**——skill 可能只是过时（换了期刊模板），重审（refine 流程 #298 保留）后可恢复 active。

**用户显式反馈**：Skills 页 per-skill 开关（toggle 端点已有，skills.router.ts:97，接新存储）。

---

## 4. 医疗合规边界（汇总）

| 红线 | 保证方式 |
|---|---|
| 轨迹/归纳零正文 | 架构性保证：TaskTrajectory schema 无内容字段；归纳输入仅操作元数据 |
| skill 无 PII | 落库前患者标识扫描（正则 + 脱敏器），命中即拒 |
| scope 隔离 | personal 默认；institution 显式逐条授权 |
| 不进患者侧 | skill 注入仅存在于 chat 上下文装配，患者侧界面/邮件零接触（对齐 RESEARCH_WORKSPACE_DESIGN.md:756） |
| 可审计 | 每次激活/遵循判定落 telemetry；skill 版本链 stableId@vN 可回溯 |

---

## 5. 实施分期（评审通过后拆 #841 子任务）

**Phase 0（前置，独立推进）**：#839 闸门统一（skill 提案复用 propose 入口）；#840 读路径（Layer 4/load_skill 切 graph 在其清单内）。

**Phase 1 — 最小闭环（环①+③+②，仅写作流程）**：
- C1 存量迁移（CapturedSkill confirmed → SkillNode，幂等脚本）→ **#842**
- TaskTrajectory 采集（postTurn 接线）→ **#843**
- 归纳器（写作流程一类，阈值默认值）→ **#844**
- 提案闸门 + 审批 UI（diff 预览 + PII 扫描）→ **#845**
- **不动 Layer 4**——新 skill 通过既有索引注入（量少，全量无害）

依赖：#842/#843 并行起步 → #844（需两者）→ #845（还需 #839 闸门统一就绪）。

**Phase 2 — 规模化（环④+⑤）**：
- Layer 4 trigger 匹配 + 剧本卡
- 遵循度 telemetry + 自动降级
- Skills 页改造（接 graph 存储 + followRate 展示）

**验证计划**：两周灰度（写作场景活跃医生），基线指标：候选生成数 / 采纳率 / 遵循率 / `active_skills` 层 token 前后对比（memory-projection.ts:242 已有分层 telemetry，直接可比）。达标（采纳率 > 50%、遵循率 > 60%）再扩 skill 类型。

---

## 6. 决策记录（2026-09-04 评审通过）

| # | 问题 | 决策 | 核心理由 |
|---|---|---|---|
| D1 | 轨迹存储 | **eventLog 投影**，不进 graph | 轨迹是喂给归纳的遥测而非知识；高频低值数据进 graph 会稀释向量索引；投影可从 eventLog 重建，恰好是 #840 想要的终态（投影=可重建缓存） |
| D2 | 首发范围 | **仅写作流程**（generate ∧ document），达标（采纳率>50% ∧ 遵循率>60%）再扩 | 写作流程信号最清晰且有 #382 模板作 ground truth；检索策略**归 knowledge**（更像陈述性偏好）；医疗产品注入坏 skill 一次就失去信任，首发类必须归纳偏差可验证 |
| D3 | LearnedSkill 退役归属 | **契约+迁移脚本归 #841（#842），读路径切换归 #840 批次** | 切读路径前契约必须先存在（依赖倒置）；同一批文件避免两次回归；#840 整体不受阻，仅 skills 部分排后 |
| D4 | marketplace 纳管 | **纳管**（source='marketplace'），三条件：evidence 为空合法 / install 强制 PII 扫描 + scope=personal / followRate 从 0 起算同受自动降级约束 | 一套注入/激活/合规逻辑；附带让 marketplace 第一次有真实使用数据（运营反馈环） |
| D5 | edit 类遵循判定 | **产出物判定先行**（如 docEdits.count ≥ 剧本声明次数），LLM judge 留作 Phase 3 | 指标职责是抓明显坏的 skill（<0.4 降级），不是精确打分；粗糙信号够用且零成本零误判风险 |
| D6 | CapturedSkill 表去留 | **保留为 intake 草稿区**；confirm = promote 到 graph（走闸门）+ 原行标 promoted 零逻辑参与（纯归档） | draft/refine 是高频多中间态 UI 操作，与 MemoryProposal"成熟待审批"语义不匹配；promoted 行留档防内容漂移无据可查 |

> 原"开放问题"表已按评审结论定案；若后续实施中发现决策前提不成立（如 D1 投影查询性能不达标），须回到本节修订并注明日期，不得静默偏离。

---

## 7. 与既有设计的边界

- **不等同于 #817 的 summary 合成**：summary 是陈述性知识的"读取格式"（从 facts 蒸馏"是什么"）；skill 是程序性知识（从轨迹蒸馏"怎么做"）。两者共享 propose 闸门与版本语义，但数据源、触发、度量完全独立。
- **不引入新的进化执行器**：DigitalTwin 的 evolver 架构不动，本环的所有触发都是确定性条件（聚类达标/阈值突破），LLM 只出现在归纳合成一步——与 brain2.0"确定性调度 + LLM 合成"的分工一致（whitepaper-brain2 §K4 先例）。
- **#298 capture 是正交入口**：医生显式捕捉单会话技能的 UX 保留不变，只是 confirm 后的落地从孤立 Prisma 行改为 graph SkillNode——两条入口（显式捕捉 / 隐式归纳）最终汇入同一契约。
