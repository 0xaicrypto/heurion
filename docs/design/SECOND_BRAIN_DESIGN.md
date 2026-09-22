# 第二大脑设计 — 用户流程与实现方案（as-built）

> **状态**：已交付（epic #1004，引用材料线 Phase 0-4 + 架构线 Phase A-E 全部落地；
> 唯一例外 Phase F #1018 颗粒度自适应仍在 backlog）。本文档 2026-09-13 版本
> 写作时该架构尚未动工，全部以"现状缺口 + 未来工作"口径叙述；统一引用架构
> 上线后（#1005-#1017 已关闭），文档与代码之间出现系统性漂移——2026-09-22
> 逐条对照代码重写为 as-built（参照 `CITATION_SYSTEM.md` 的补记式写法）。
> **本次重写核对过的代码**（抽查声明逐条可验证）：
> `packages/server-ts/src/lib/reference-store.ts`（两层池唯一读写入口）、
> `modules/references/references.router.ts`（会话引用 + 建议端点）、
> `modules/chat/session-refs-builder.ts` + `modules/shared/chat-context.ts`
> （注入管线）、`modules/shared/suggested-reference.service.ts`（建议引擎）、
> `memory/reference-embedding.ts`（文件语义索引）、`memory/memory-usage-bus.ts` /
> `memory/memory-tier-store.ts` / `memory/granularity-controller.ts`（架构线三组件）、
> `prisma/schema.prisma`（ReferenceItem/SessionReference/SuggestedReference/
> MemoryUsageEvent/MemoryTierEvent 五张表）。
> **修正声明**：第四节原"现状：三条互不相通的路径""数据模型（设计稿）"
> "迁移阶段（待实施）"等表述均已失效，现按实际交付形态改写；未交付部分
> （§4.8 STAIR、Phase F）明确保留为未来工作。
> **姊妹篇**：[`WRITING_MODULE_REVIEW.md`](./WRITING_MODULE_REVIEW.md)（写作模块
> 代码/产品评审）、[`WRITING_MODULE_REDESIGN.md`](./WRITING_MODULE_REDESIGN.md)
> （写作模块北极星重设计）。

---

## 一、产品定位

一句话：不管用户在写论文、日常聊天、还是回顾很久以前记下的东西，Heurion
应该表现得像**用户自己的第二个大脑**——说过的、传过的、记住的东西，不需要用户
费心整理，也不需要用户费心想起来，需要的时候它自己在那儿。

**设计时的落差**（2026-09-13）：Heurion 已经有 Brain 2.0（episodes → facts →
人工审核 → 记忆图谱）骨架，但"用户上传的文件"和"知识库里的内容"按**场景**
（写作 chat / 主 chat）各自管理，同一份材料换个场景要重新弄一遍。这段落差
即本文档的立项依据，如今已按 §四 的架构消除。

## 二、四条设计原则（未变，全部已按原样落地）

市面上大部分"第二大脑"类产品最后都变成"笔记坟场"——用户兴致勃勃建了分类、
标签、文件夹，之后没人再打开。原因几乎总是同一个：**捕获的时候要求用户先想
清楚"这东西该放哪儿"，而人在捕获瞬间根本不想做这件事**。四条原则都是在
回避这个失败模式，四条都已进入实现：

1. **捕获零摩擦**——同一手势捕获任何内容；上传 / `kb_remember` / 知识库选一条
   总结登记为引用，都不要求先分类（`ReferenceItem` 至今没有文件夹/标签字段，
   见 §4.4）。
2. **结构是被看见的，不是被设置的**——系统基于使用行为自动归纳（#1010 隐式
   排序），用户的动作是"确认/修正"。
3. **该出现的时候自己出现**——开局建议 + 对话中建议（#1008/#1009）。
4. **信任来自看得见、能纠正**——建议态永不自动生效；升降级统一走
   `MemoryTierStore` 留痕（#1015/#1017）。

## 三、用户流程（全部已实现，逐条标注代码落点）

### 3.1 捕获 ✅

四条路径捕获动作统一、不要求分类，全部落到同一个用户级内容池
（`ReferenceItem`）：

1. **上传文件**——写作 chat 引用入口 / 主 chat 附件 / 文件页面；
2. **显式"记住这个"**——`kb_remember`（`modules/knowledge/knowledge-command-handler.ts`）；
3. **AI 从对话提炼**——`extractSegment` 管道（`memory/compaction/runner.ts`）；
4. **从知识库挑一条总结**——Reference 弹层"知识库"入口
   （`kind='kb_summary'`，写路径同步写 MemoryUsageBus `referenced` 动作，
   `references.router.ts`）。

### 3.2 审核（信任闸门）✅（复用 Brain 2.0 机制，未改动）

- 对话提炼 / 显式"记住"的内容走 `MemoryProposal` 待审核队列
  （`memory/proposal/proposal.service.ts`），无直写路径；唯一的显式例外是
  用户命令直写（`kb_remember` 等带 `fastTrack: true` 的显式动作，#839
  统一收口——走与人审相同的 applier，提案行保留作审计记录）。
- 低重要性提案 7 天后自动归档：`archiveStaleProposals`
  （`modules/approvals/approval.service.ts`，pending 列表时惰性执行）。

**上传文件不经过审核**——确定性内容直接进 `ReferenceItem`；被引用到具体会话时
遵循原则 4（建议态需显式确认）。

### 3.3 引用 ✅

1. "引用"入口在写作 chat 与主 chat 是**同一套端点**：
   `GET/POST/DELETE /api/v1/sessions/:sessionId/references`
   （`modules/references/references.router.ts`，#1006）——sessionId 复用
   项目既有约定：写作 `doc-<docId>`，主 chat 普通 sessionId。
2. 三个来源（文件库 / 知识库 / 粘贴文本）选好即在本会话生效
   （`SessionReference` 挂载）。
3. **跨会话复用**：同一份内容在别的会话直接从引用列表再挂载——确定性 ID
   （`ref_`/`sr_` + sha1 前 16 位）保证幂等，正文不重复存。
4. 主 chat 临时附件保留，附件条上有"固定为引用"按钮（`routes/chat.tsx`
   `pinAsReference`，#1007；doc-chat 附件对称按钮见 #1032）。

### 3.4 主动建议 ✅（原"现状完全没有"的部分，现已交付）

1. **开局建议（关键词版，#1008）**：打开会话时前端调
   `POST /api/v1/sessions/:sessionId/references/scan`，
   `detectOpeningSuggestions`（`modules/shared/suggested-reference.service.ts`）
   用上下文关键词与未挂载材料做重叠匹配，≥2 个关键词命中才建议
   （宁缺勿扰）。#1012 交付前端横幅 + 建议态视觉区分。
2. **对话中建议（语义版，#1009）**：`detectSuggestedReference` 复用 K6 的
   `detectQuestionShaped`（`modules/knowledge/gap-detect.ts`）反向运行——
   问题形态消息被某条未挂载材料的语义索引命中（阈值 0.5）时生成
   pending 建议；文件类正文靠 `memory/reference-embedding.ts` 的分块索引
   （type='reference'，分块 ID `<itemId>::cN`）。
3. **两种反应**：接受 → `SessionReference(source='suggestion_accepted')`；
   忽略 → 只置 `dismissed`，同会话不再重复提示（surfaced 集合含
   dismissed，`suggested-reference.service.ts`）。
4. **红线成立**：建议永不自动变成正式引用；建议的命中/接受/忽略全部写
   MemoryUsageBus（`accepted`/`dismissed`/`suggested` 动作），不是局部计数器。
5. #1036 补齐结构化原因码（`reasonCode`，前端 i18n）与交互细节。

### 3.5 回顾与管理 ✅

- **引用材料选择器**（#1010）：`GET /api/v1/references` 不分文件夹，按
  `sort=recent`（最近用过）/ `frequent`（用得最多）/ `relevant`（当前场景
  相关，关键词重叠打分）排序，数据源 = ReferenceItem 本体 + MemoryUsageBus
  聚合。
- **知识库审核收件箱**：不变。
- **删除引用 ≠ 删除内容**：`removeSessionReference` 只删会话挂载行，
  `ReferenceItem` 本体保留（`lib/reference-store.ts` 注释级纪律 + 端点实现）。

## 四、数据与技术架构（as-built）

### 4.1 原现状：三条互不相通的路径（已废除，保留为迁移背景）

| 路径 | 载体 | 是否落库 | 是否可跨会话复用 |
|---|---|---|---|
| 主 chat 附件 | `chat.tsx` 的 `currentAttachedFiles` | 否 | 否 |
| 写作 chat 参考材料 | `DocReference` 表（绑 `docId`） | 是 | 否——绑死单篇文档 |
| 知识库检索 | `kb_search` 动态检索 Facts/Summary | 否 | 不适用（问一次答一次） |

`DocReference` 的建模问题（`refType` 混来源与解析方式 / `targetId` 双语义 /
正文重复存 / 主 chat 无对应物）在 #1005 迁移中收口：新表已在，旧表只作
双写兼容与懒修复回退（`loadSessionReferenceItems` 的 fallback 分支）；
#1034 写作编辑器引用链路迁到 session 端点后，旧端点仅服务极旧存量。

### 4.2 统一记忆架构：三个核心组件 ✅（原"新增"目标，现已全部落地）

原设计依据 arXiv 2602.06052 把"颗粒度决策/使用反馈/分层存储"收敛为共享
架构，对应三个组件如今全部存在于 `packages/server-ts/src/memory/`：

| 组件 | 设计 | 实际落地 |
|---|---|---|
| `MemoryGranularityController`（颗粒度决策集中点） | 收敛 compaction/knowledge-synthesis/gap-research 的分散规则 | `memory/granularity-controller.ts`（#1013）：`shouldConsolidate`（情景提取 ≥2 / 压缩段 ≥4 / 语义簇 ≥3，`SUMMARY_MIN_CLUSTER`）、`shouldPromote`（K6 缺口升级）、`shouldDemote`（恒 false——降级策略属 Phase F #1018） |
| `MemoryUsageBus`（统一使用反馈总线） | 仿 EventLog 的 append-only 流 | `memory/memory-usage-bus.ts`（#1014）→ `memory_usage_events` 表：kb_search 命中 → `retrieved`（knowledge-command-handler）、摘要登记引用 → `referenced`、建议接受/忽略 → `accepted`/`dismissed`、技能调用 → #1016 接入 |
| `MemoryTierStore`（分层存储统一契约） | 情景/语义/程序/引用统一升降级契约 | `memory/memory-tier-store.ts`（#1015）：`FactTierStore`/`SummaryTierStore`/`SkillTierStore`（#1016 经 `modules/skills/follow-through.ts` 接入）/`ReferenceTierStore`（#1017）/`PersonaTierStore`；promote/demote 一律写 `memory_tier_events` 留痕（可在 `/api/v1/memory/health` 回溯） |

架构图（原文示意 → 实际接线）：

```
EventLog（对话/操作原始记录）          MemoryUsageBus（谁用了哪条记忆, #1014）
        │                                     │
        ▼                                     ▼
  提取/合成候选 ──→ MemoryGranularityController（#1013 唯一决策入口）
                             │
                             ▼
        MemoryTierStore（#1015: fact/summary/skill/reference/persona 五层）
                             │
                             ▼
                   memory_tier_events 留痕（可见可回滚，原则 4）
```

### 4.3 层次总览（引用材料线，as-built）

```
EventLog ─ extractSegment（压缩时/会话关闭时批量, §BRAIN2 §13 简化模型）
              └─→ MemoryProposal（pending）→ 批准 → Facts → Summary
用户主动捕获（上传 / 知识库登记 / 粘贴）
              └─→ ReferenceItem（prisma reference_items, 用户级内容池）
                       │
          SessionReference（会话挂载, session_references）
                       │
          SuggestedReference（待确认建议, suggested_references）
```

`ReferenceItem` 与 `Facts/MemoryProposal` 是两条并行沉淀路径，共享同一个
信任模型；`SuggestedReference` 在语义上等价于 `MemoryProposal` 的"待审核"。

### 4.4 数据模型（as-built 实表）

设计中的三张表已原样建表（`prisma/schema.prisma`），字段与设计稿一致：

```
ReferenceItem        （schema.prisma:284 → reference_items）
  id                 ref_<sha1(userId|identityKey)[:16]> 确定性 ID
  kind: 'file' | 'kb_summary' | 'pasted_text'
  sourceRef          file → FileIndex.id；kb_summary → Summary stableId；pasted_text → null
  label / snapshot   kb_summary/pasted_text 直接是正文；file 类为文件名（注入时懒解析）

SessionReference     （schema.prisma:306 → session_references）
  id                 sr_<sha1(sessionId|referenceId)[:16]>
  sessionId          'doc-<docId>' 或主 chat sessionId
  source             'manual' | 'suggestion_accepted'
  @@unique([sessionId, referenceId]) — 幂等挂载

SuggestedReference   （schema.prisma:199 → suggested_references）
  reason / reasonCode (#1036 结构化原因码) / score
  status: 'pending' | 'accepted' | 'dismissed'
```

唯一读写入口是 `lib/reference-store.ts`：确定性 ID + 主键冲突读回实现
幂等；`resolveOrCreateReferenceItem` / `addSessionReference` /
`listSessionReferences` / `removeSessionReference`（只删挂载）/ 以及
`loadSessionReferenceItems`——新表优先，`doc-` 会话新表为空时回退旧
`DocReference` 并顺带双写修复（懒迁移）。升降级统一走
`ReferenceTierStore`（#1017）：「固定为引用 / 取消引用」每次动作产生
`memory_tier_events`（from/to 均 'reference'，会话记在 reason），实际挂载
仍由 references 路由执行。

**收益兑现情况**：①跨会话复用 ✅（确定性 ID 幂等）；②主 chat 免费
对称化 ✅（`buildSessionReferenceBlocks` 单一实现，`chat-context.ts:550`；
旧 `buildDocReferenceBlocks:602` 已是薄封装）；③临时附件升级路径 ✅
（pin 按钮）；④kind 结构化判断 ✅（`normalizeLegacyRefType`，
`DOC_FILE_REF_KINDS` 魔法值集合消失）。

### 4.5 与知识库检索（`kb_search`）的关系 ✅

设计保留原判：`kb_search` 是动态检索（不落库），`ReferenceItem` 是主动钉选。
衔接点已在实现中：`kb_search` 命中 → MemoryUsageBus `retrieved`；
检索结果经引用弹层"知识库"入口登记 → `kind='kb_summary'` 的
`ReferenceItem` + `referenced` 信号。`KbPicker → handleKbPickConfirm` 数据
落点已从 `DocReference` 切到新模型。

### 4.6 命名规范：`article` vs `summary` vs `file` ✅（#1011 已收尾）

1. **KB 合成摘要**：全仓统一 `summary`（`common/kb-rename-migration.ts` 启动
   幂等迁移 + `MemoryProposal.kind` / `embedding-index.ts` / `memory.graph.ts`
   / `/api/v1/knowledge/summaries` 均为新名）。原设计点名的两处遗留尾巴
   （`summary-service.ts` 的 `memory_article_*` 事件类型、knowledge.router 的
   `article_edited` 审计 action）已随 #1011 迁移完毕；现存 `article` 字样
   （`memory.graph.ts:28`、`embedding-index.ts:72`、`staleness.ts` 历史键
   `article_superseded`、`agent.router.ts` 旧事件名 i18n 映射）全部是
   **对旧数据的兼容读取**，不再产生新命名。另：`fetch_article_summary`
   （`tools/medical-web-tools.ts`）与 submission 模块的 "article" 指期刊
   论文，属第三个概念（真实学术论文），与 KB 无关，不在改名范围。
2. **用户上传的文件**：picker 已统一 `file`（#1011）。`ReferenceItem.kind`
   用 `'file' | 'kb_summary' | 'pasted_text'`，不用 `'kb_article'`。

### 4.7 主动建议的实现（as-built）✅

- **开局建议**：关键词重叠版（`extractKeywords`，CJK bigram 口径来自
  `modules/knowledge/gap-detect.ts`），由前端打开会话时显式调用 scan 端点
  触发——采纳/忽略结果写 MemoryUsageBus，喂给未来的自适应策略。
- **对话中建议**：`detectSuggestedReference` 走 post-turn best-effort；
  文件类 `ReferenceItem` 在登记/挂载时把正文分块送入 EmbeddingIndex
  （#1009 前置基建已补齐）。判定复用 K6 判定族反向运行，非新造机制。

### 4.8 与 STAIR（结构感知检索）的连接点 —— 仍是未来项

本节保持为**未实施的独立后续项**（原样成立）：超预算参考材料仍由
`renderReferenceBody`（`chat-context.ts:512`）按"用户指名章节 + 章节清单"
启发式选段（#833 的章节寻址），`lib/block-projection.ts` 的 H1-H3 结构投影
只服务 `Doc.body`，尚未泛化为"任意长文本"的结构提取器。做全文结构检索时
再按本节思路接入，此处仅记录连接点。

### 4.9 与 Facts/Summary/Skills（Brain 2.0）的收敛关系 ✅（Phase C/D/E 已落地）

三套体系的"什么时候提升/什么时候折叠"逻辑已收敛到同一套契约：

- Facts/Summary/Skills/ReferenceItem/Persona 各自实现
  `MemoryTierStore`（`memory-tier-store.ts` 五个类），存储形态不变
  （facts 图谱节点 / summaries 图谱节点 / skills 行为模式 / 引用材料
  reference_items / persona 派生渲染），升降级/留痕走同一接口。
- 使用信号统一写 `MemoryUsageBus`（skills 的调用/淘汰经
  `modules/skills/follow-through.ts` #1016 接入 SkillTierStore.demote）。
- `MemoryGranularityController` 是唯一决策入口，不区分决策对象。

## 五、跨界面一致性 ✅

写作 chat 与主 chat 的"引用"是同一套实现：同一组 session 端点（写作侧
`doc-` 前缀会话由 `doc-context-builder.ts` 走 document_context 段，主 chat
由 `session-refs-builder.ts` 走 Reference Materials 段——取数与注入同一
函数）、同一套建议机制（建议生成不区分场景）。前端弹层挂载与"固定为
引用"两侧对称（#1007/#1012/#1032）。

## 六、验收标准 / 北极星指标

设计红线（不变）：**用户从"捕获"到"下次用上"之间，除了"钉一下"和
"确认一下"，不应该有第三个动作。**

北极星指标的数据源已按设计落在 MemoryUsageBus（#1014，埋点单一来源）：
跨会话复用率（同一条 `ReferenceItem` 被多个 `sessionId` 引用）、建议采纳率
（`accepted` / `accepted+dismissed`）、临时附件升级率（pin 动作）均可从
`memory_usage_events` 聚合（#1010 的选择器 API 已在消费这些聚合）。

验收标准（功能层面）逐条对账：

- [x] 同一份文件/知识库摘要在写作 chat 与主 chat 之间无需重新上传即可复用
  （`SessionReference` 挂载 + 确定性 ID 幂等，#1005/#1006）
- [x] 开局建议在标题/近期消息命中已有引用材料时正确触发，忽略后不重复打扰
  （#1008/#1009/#1012；surfaced 集合含 dismissed，同会话永不重复）
- [x] 建议态与正式引用在 UI 上有清晰的视觉区分（#1012，#1036 细节）
- [x] 取消引用不影响 `ReferenceItem` 本体与其它会话的引用关系
  （`removeSessionReference` 只删挂载行，测试锁定）

## 七、迁移与实施阶段（已全部排账完毕，仅 Phase F 未做）

| 阶段 | 内容 | 实际状态 |
|---|---|---|
| Phase 0 | 数据模型迁移 `ReferenceItem`/`SessionReference` + 命名清理 | ✅ #1005（+ #1011 命名收尾） |
| Phase 1 | 主 chat 对称化（后端泛化 + 前端挂载/固定为引用） | ✅ #1006 后端 → #1007 前端 |
| Phase A | `MemoryGranularityController` 零行为重构 | ✅ #1013 |
| Phase B | `MemoryUsageBus`（Facts/Summary 信号先行） | ✅ #1014 |
| Phase 2 | 建议态（关键词版）+ 开局横幅 | ✅ #1008 → #1012（#1036 细节） |
| Phase C | `MemoryTierStore` 契约化（Facts/Summary/Persona） | ✅ #1015 |
| Phase D | Skills 并入（trajectory/follow-through 接线） | ✅ #1016 |
| Phase 3 | 建议态（语义版）：文件类接 embedding + K6 反向判定 | ✅ #1009 |
| Phase 4 | 引用选择器隐式排序（读 MemoryUsageBus 聚合） | ✅ #1010 |
| Phase E | `ReferenceItem` 并入统一架构 | ✅ #1017 |
| **Phase F** | 颗粒度自适应（规则 → 使用数据驱动策略） | ⬜ **#1018 仍开放**——前置条件（B-E 跑过观察期）已满足，启动前需单独的评估方案（原 §八 的观察期问题仍有效） |

原"数据迁移"细节（确定性 ID、双写纪律、回填）见
[`SECOND_BRAIN_PHASE0_MIGRATION.md`](./SECOND_BRAIN_PHASE0_MIGRATION.md)（已按
交付时点执行完毕，保留为迁移方案存档）。

## 八、开放问题（实现已裁决的标注结论，其余保留）

- ~~主 chat ephemeral attachment 自动升级 vs 手动固定~~ → **已裁决：手动
  "固定为引用"**（`chat.tsx` pin 按钮，#1007），更明确且不污染引用列表。
- ~~取消引用是否保留 `ReferenceItem`~~ → **已实现为默认行为**：
  `removeSessionReference` 只删挂载行（有回归测试锁定）。
- ~~开局建议触发时机~~ → **已裁决**：前端打开会话时调用一次 scan 端点
  （非每轮判定），上下文由前端传入。
- ~~建议划走后是否再提示~~ → **已裁决**：同会话永久不再提示（surfaced 集
  合含 dismissed）；跨会话仍可再次出现（不同 sessionId），与"尊重一次性
  决定"精神一致且粒度更合理。
- ~~文件类引用接入 embedding 的隐私边界~~ → **已裁决**：文件类记录携带
  `FileIndex.patientHash`，语义检索按患者隔离过滤；kb_summary/pasted_text
  标记为未分级（patientHash=undefined → 仅全局范围可见）。该口径有显式
  测试用例锁定（`memory/reference-embedding.ts` 模块注释）。
- **建议展示位置**：主 chat 建议跟随回复展示（#1012），独立交互稿未再需要。
- **Phase F 观察期**：仍开放——启动 #1018 前需单独出评估方案（样本量、
  过拟合风险），不能靠直觉定"观察两周"。
- **`MemoryTierStore` 降级误伤低频关键记忆**：仍开放——shouldDemote 当前
  恒 false，Phase F 启用前需补"重要性"信号（复用高重要性提案置顶逻辑）。
