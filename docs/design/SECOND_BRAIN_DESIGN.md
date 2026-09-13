# 第二大脑设计 — 用户流程与实现方案

> **日期**：2026-09-13
> **目标**：本文档面向**重构**——是一份完整、独立可读的设计文档，重点讲清楚
> 用户流程与"第二大脑"如何落地为具体机制，供拆解为实现任务使用。
> **姊妹篇**：[`WRITING_MODULE_REVIEW.md`](./WRITING_MODULE_REVIEW.md)（写作模块
> 代码/产品评审）、[`WRITING_MODULE_REDESIGN.md`](./WRITING_MODULE_REDESIGN.md)
> （写作模块北极星重设计）。
> **2026-09-13 补充**：第四节新增"统一记忆架构"——引用材料（本文档主线）和
> Brain 2.0 的 Facts/Summary/Skills 不再是两套平行演进的记忆系统，而是共享
> 同一套颗粒度决策/使用反馈/分层存储架构（依据 arXiv 2602.06052 综述关于
> 自演进 agent 记忆管理的框架）。

---

## 一、产品定位

一句话：不管用户在写论文、日常聊天、还是回顾很久以前记下的东西，Heurion
应该表现得像**用户自己的第二个大脑**——说过的、传过的、记住的东西，不需要用户
费心整理，也不需要用户费心想起来，需要的时候它自己在那儿。

**现状与愿景的落差**：Heurion 已经有 Brain 2.0（episodes → facts → 人工审核 →
记忆图谱）这套骨架，覆盖"对话内容怎么沉淀"这一件事，起点比大多数从零开始的
笔记类产品高。但"用户上传的文件"和"知识库里的内容"目前是按**场景**（写作
chat / 主 chat）各自管理的，同一份材料换个场景要重新弄一遍——这是"第二大脑"
体验里最先会被戳破的一处：用户对"我的大脑"的直觉期待是"它是我的，不是这篇
文档的"，只要有一个地方要求"再录入一遍"，这个感觉就碎一次。

## 二、四条设计原则

市面上大部分"第二大脑"类产品最后都变成"笔记坟场"——用户兴致勃勃建了分类、
标签、文件夹，之后没人再打开。原因几乎总是同一个：**捕获的时候要求用户先想
清楚"这东西该放哪儿"，而人在捕获瞬间根本不想做这件事**。下面四条原则都是在
回避这个失败模式。

### 原则 1：捕获零摩擦

捕获动作应该是同一个手势，不管捕获的是一句话、一段总结还是一个文件——"记住
这个/钉一下"，仅此而已。不要求用户在捕获时分类、打标签、想好以后怎么用。

Heurion 现状：对话里的"记住"（`kb_remember`）已经是这个手势；本文档把它扩展
到"文件"和"已有知识库内容"上，让捕获动作在三种输入类型上保持一致。

### 原则 2：结构是被看见的，不是被设置的

组织结构应该是系统看完内容之后自动归纳出来给用户看（就像现有的
fact → summary 合成管道），用户的动作永远是"确认/修正"这种低成本操作，不是
"分类/打标签"这种高成本操作。

对应本设计的取舍：`ReferenceItem`（第四节）故意不设文件夹/标签字段——先用
"最近用过""用得最多""当前场景提到过"这类基于使用行为的隐式组织，用户真的
需要显式分类时再加，不预先假设需要。

### 原则 3：该出现的时候自己出现

真正的第二大脑不是"我需要的时候去搜索它"，而是"我在做一件事的时候，相关的
东西自己冒出来"。这是本设计**新增**的能力（第三节 3.4），现状完全没有——
现在不管写作 chat 还是主 chat，都只有用户主动打开"引用"弹层这一条路。

### 原则 4：信任来自看得见、能纠正，不是来自全自动

这正是 Brain 2.0 现有的核心设计（没有直写路径，一切先进审批队列）。补上原则 3
的"主动建议"能力之后，必须重新守住这条：任何自动/建议出来的东西，在变成
"正式生效"之前，用户必须能一眼看到、一键忽略——不能让"建议"悄悄变成既成事实。

## 三、用户流程

按"捕获 → 审核 → 引用 → 主动建议 → 回顾管理"五个阶段展开，每个阶段是用户
实际会做的事，不涉及内部实现细节（实现细节见第四节）。

### 3.1 捕获

用户可以通过四条路径往"第二大脑"里放东西，捕获动作统一、不要求分类：

1. **上传文件**——不管是在写作 chat 的"引用"入口、主 chat 的附件按钮，还是
   独立的文件页面，上传这个动作本身只做一件事：把文件放进用户自己的文件库
   （`FileIndex`，已有）。
2. **显式说"记住这个"**——对话里的 `kb_remember` 指令（已有），把这句话
   变成一条待审核的事实。
3. **AI 自动从对话提炼**——会话压缩/关闭时（已有的 `extractSegment` 管道），
   系统自动把值得记住的内容提炼成候选事实，用户全程无感，只在审核收件箱里
   看到结果。
4. **从知识库里挑一条已经存在的总结**——通过 Reference 弹层的"知识库"入口，
   把一条已经生成好的 Summary 标记为"我要在当前工作里用它"。

前两条是"用户主动放入"，第三条是"系统主动帮用户放入"，第四条是"从已经
沉淀好的知识库里取用"——三种动作分工不同，但都归到同一个用户级的内容池
（`ReferenceItem` / Facts，见第四节），不因为捕获渠道不同而在后面被区别对待。

### 3.2 审核（信任闸门）

这一段复用 Brain 2.0 现有机制，不是本次新设计，写在这里是为了让整条用户
流程完整：

- 对话自动提炼、或用户显式"记住"的内容，先进 `MemoryProposal` 待审核队列，
  **没有任何直写路径**。
- 用户在审核收件箱（Brain inbox，已有）里批准或拒绝；批准后才进入版本化的
  记忆图谱（Facts → 可被合成为 Summary）。
- 低重要性提案 7 天后自动归档，避免收件箱堆积（已有）。

**上传文件不经过这一步**——文件是用户自己主动放进来的确定性内容，不是 AI 从
对话里"猜"出来的事实，不需要审核；但文件被引用到某个具体会话时，仍然遵循
原则 4，即下面 3.4 提到的"建议态"必须显式确认。

### 3.3 引用（把已有内容带进当前工作）

1. 用户在写作 chat 或主 chat 里打开"引用"入口（同一个组件，两个场景共用，
   见第五节）。
2. 三个来源：**从文件库选**（已上传过的文件）、**从知识库选**（已生成的
   Summary）、**当场粘贴一段文本**——选好之后，这份内容立刻在当前会话生效。
3. **换一个会话再用同一份东西**：不用重新上传/重新粘贴，直接从"最近引用过"
   列表里选——这是本设计相对现状最大的体验提升（现状细节见第四节 4.1）。
4. 主 chat 里图省事的临时附件（甩个文件问一句话，问完不需要它了）继续保留，
   不强制升级；用户想让它持续生效时，点一下"固定为引用"，从临时附件变成
   正式引用。

### 3.4 主动建议（第二大脑区别于普通文件管理的关键流程）

这是原则 3 的具体落地，现状完全没有，是本次要新增的用户流程：

1. **开局建议**：用户打开一篇写作文档、或开始一段新的主 chat 对话时，如果
   已有的引用材料（`ReferenceItem`）标题/内容和当前场景明显相关，系统弹出
   一条不打断操作的提示："你可能想用上：《XX》——要引用吗？"
2. **对话中建议**：用户在对话中提到的问题，如果恰好被某条用户尚未在当前
   会话引用的材料覆盖，系统在该轮回复里附带一条建议（不是打断式弹窗，是
   跟着回答一起出现的小提示）。
3. **用户的两种反应**：点"引用"——立刻变成正式引用，等同于 3.3 的手动操作；
   划走/忽略——不留痕迹、不重复用同一条材料骚扰同一个会话。
4. 建议**永远不会**自动变成正式引用——这是原则 4 的红线，任何时候用户都能
   在引用列表里清楚区分"我确认要用的"和"系统建议但我还没理它的"。

### 3.5 回顾与管理

- **引用材料选择器**：不分文件夹，按"最近用过""用得最多""当前场景提到过"
  排序展示（原则 2 的隐式组织）。
- **知识库审核收件箱**：管理 Facts/Summary 的批准/拒绝/归档，现有功能不变。
- **删除引用 ≠ 删除内容**：从某个会话"取消引用"只影响这个会话，内容本体
  （`ReferenceItem`）作为用户级资产继续存在，除非用户明确去文件库/知识库里
  删除它本身。

## 四、数据与技术架构

### 4.1 现状：三条互不相通的路径

| 路径 | 载体 | 是否落库 | 是否可跨会话复用 |
|---|---|---|---|
| 主 chat 附件 | `chat.tsx` 里的 `currentAttachedFiles`（纯前端 state） | 否 | 否——每条消息都要重新带 `fileId` |
| 写作 chat 参考材料 | `DocReference` 表（绑定 `docId`） | 是 | 否——绑死单篇文档，换一篇要重新登记 |
| 知识库检索 | `kb_search` 等命令，动态检索 Facts/Summary | 否（检索结果不落库） | 不适用——本来就是"问一次答一次"的工具 |

**主 chat**：`buildAttachmentParts`（`modules/shared/chat-context.ts:337`）每次都
重新解析上传文件全文注入当前这条消息，不落库、不可复用。

**写作 chat**：`DocReference`（`prisma/schema.prisma:173`）+ `useDocReferences`
hook（`routes/writing-editor/references.ts`）+ Reference 弹层（Pick from files /
知识库 / Paste text），落库、可列表可删除，每轮由 `buildDocReferenceBlocks`
（`chat-context.ts:530`）解析注入。

**`DocReference` 自身还有建模问题**，不只是"主 chat 缺一个功能"这么简单：

1. **`refType` 混了两个维度**——**来源**（用户粘贴 / 知识库 / 上传文件）和
   **要不要重新解析**（`'file'/'pdf'/'docx'` = 只存文件名，每次要反查
   `FileIndex` 重新提取正文；`'note'` = 内容已经是纯文本，直接用）。历史上
   知识库摘要曾经被塞进 `kind='guideline'`（`references.ts:130`：
   `it.kind === 'document' ? 'file' : 'guideline'`）——"guideline"是"临床
   指南粘贴"这个最早场景留下的命名，和知识库毫无关系，纯粹是复用了一个
   凑巧存在的枚举值。
2. **`targetId` 字段名不对**——路由层（`documents.router.ts:535`）请求体里
   这个字段叫 `source_patient_hash`，是只为"患者相关引用"设计的特例字段，
   落库时才映射成通用的 `targetId`。它从来就不是一个"指向来源实体"的通用
   外键——文件类引用不存 `FileIndex.id`，而是把文件名存进 `snapshot`，每次
   靠 `findUploadFileByName` 按名字反查（`chat-context.ts:473`）。
3. **引用永远绑定 `docId`**——同一份文件/同一条知识库摘要，换一篇论文想再
   用，要重新走一遍"选文件/知识库/粘贴"流程，产生一条新的 `DocReference`
   行，正文（`snapshot`）整段重复存一份。
4. **主 chat 完全没有对应物**——`chat.tsx` 里连"引用列表"这个概念都不存在，
   只有一次性的 `currentAttachedFiles`。

**知识库检索**：`kb_search` 等命令动态检索 Facts/Summary（embedding 语义
检索），结果不落库，是"问一次答一次"的工具——这条路径**不需要**并入下面的
统一模型，见 4.4。

### 4.2 统一记忆架构：三个核心组件

现状不是一个架构，是一堆各自演进的管道拼起来的：`compaction/runner.ts` 管
情景边界和事实提取、`knowledge-synthesis.ts` 管 Facts→Summary 合成、
`embedding-index.ts` 独立维护向量索引、`gap-research.service.ts` 独立做缺口
检测——每一处"什么时候该做什么"都是散落在各自文件里的局部规则（覆盖率
阈值、轮次计数、facts 数量），没有一个地方能回答"这个系统整体的颗粒度决策
逻辑是什么"。更根本的问题：**Skills（程序性记忆，`modules/skills`/
`trajectory-induction.service.ts`）和 Brain 2.0（情景/语义记忆）是两套完全
独立的体系**，各自维护自己的"从经验里学习"逻辑，互不知道对方存在。

依据 arXiv 2602.06052（"A Survey of Agent Memory in the Second Half"）的
框架，情景/语义/程序记忆是同一套记忆系统的三个层，理应共享同一套巩固/反馈
机制；该综述也明确指出——**颗粒度正在从固定方案变成可学习的能力**，agent
应当通过真实使用反馈决定"这条经验该保留、该压缩合并、还是该丢弃"，而不是
靠工程师预先写死的规则。这是本节新增三个架构组件的直接依据。

**`MemoryGranularityController`（颗粒度决策集中点）**——把现在散落在
`compaction/runner.ts`（情景边界）、`knowledge-synthesis.ts`（合成时机）、
`gap-research.service.ts`（缺口检测）里的判断，收敛成统一接口：
`shouldConsolidate(tier, candidateUnit)` / `shouldPromote(unit, usageStats)` /
`shouldDemote(unit, usageStats)`。今天内部实现仍是规则（覆盖率、语义漂移
检测），但它是**唯一决策入口**——以后想把规则换成学习出来的策略，只需要
改这一个组件，不需要动任何调用方。

**`MemoryUsageBus`（统一使用反馈总线）**——仿照 `EventLog`（唯一真相源）的
架构模式，新增一条同等地位的 append-only 流，专门记录"某条记忆单元被使用
了"：Fact 被 `kb_search` 命中选中、Summary 被 `SuggestedReference` 采纳、
Skill 被 trajectory 匹配调用，都写进这一条流，而不是各自散落在不同表里的
局部计数器。`MemoryGranularityController` 只对接这一条总线。

**`MemoryTierStore`（分层存储统一契约）**——给情景/语义/程序三层定义同一套
存/取/提升/降级/留痕接口：`write(unit, tier)` / `promote/demote(unitId,
fromTier, toTier, reason)`（留痕，可见可回滚）/ `read(query, tier)`。Facts/
Summary/Persona 各自实现这个接口（内部存储形态不变），Skills 也实现同一
接口正式并入，`ReferenceItem` 同样实现这个接口——升降级操作统一走这个契约，
把"可见可纠正"（原则 4）在架构层面强制，而不是每个模块各自决定要不要记
审计日志。

```
EventLog（对话/操作原始记录，已有）      MemoryUsageBus（谁用了哪条记忆，新增）
        │                                    │
        ▼                                    ▼
  提取/合成候选 ──→ MemoryGranularityController ──→ 决策（提取/合成/提升/降级）
                            │                              │
                            ▼                              ▼
                    MemoryTierStore（情景层/语义层/程序层/引用层统一契约）
                            │
                            ▼
                    留痕事件（可见可回滚，原则 4）
```

`ReferenceItem`/`SessionReference`/`SuggestedReference`（4.4 节）是这套架构
在"外部内容"这个记忆层上的一个具体实现——不是另一套独立设计，详见 4.9 节。

### 4.3 层次总览（引用材料这条线）

```
EventLog（已有，唯一真相源：所有对话/操作的原始记录）
   │
   ├─ extractSegment（已有）→ MemoryProposal（已有，待审核队列）
   │                              │ 批准
   │                              ▼
   │                        Facts → Summary（已有，记忆图谱 + embedding 语义索引）
   │
   └─ 用户主动捕获（上传文件 / 从知识库选 / 粘贴文本）
                                   │
                                   ▼
                         ReferenceItem（新增，用户级、跨会话的内容池）
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
            SessionReference  SuggestedReference   （被写作 chat / 主 chat
            （新增，正式引用）  （新增，待用户确认的建议）  共用同一套解析注入逻辑）
```

`ReferenceItem` 与 `Facts/MemoryProposal` 是两条**并行**的沉淀路径，不是替代
关系：前者是"用户主动收藏的确定性内容"（文件、知识库摘要、粘贴文本），后者
是"AI 从对话里提炼、需要人工审核的候选事实"。两条路径共享同一个信任模型——
"任何自动/建议的东西，变成正式生效前都要用户确认"（原则 4），这也是为什么
`SuggestedReference` 这个新状态在语义上等价于 `MemoryProposal` 的"待审核"，
只是作用对象是"引用材料"而不是"事实"。

### 4.4 数据模型

把"什么内容可以被引用"和"这份内容在这个会话里生效"这两件事分开建模。
下面三张表最终都实现 4.2 节的 `MemoryTierStore` 接口（`ReferenceItem` 对应
"引用材料"这一层的存储单元，升降级——即建议被采纳/引用被取消——统一走
`promote`/`demote`，而不是本节描述的这套裸 CRUD；4.9 节详细说明落地方式）：

```
ReferenceItem {                // 第一层：可被引用的内容，用户级，不属于任何会话
  id, userId
  kind: 'file' | 'kb_summary' | 'pasted_text'   // 不用 'kb_article'，理由见 4.5
  sourceRef: string | null   // file → FileIndex.id；kb_summary → Summary 的 stableId；
                             // pasted_text → null
  label: string
  snapshot: string           // kb_summary/pasted_text 直接是正文；file 类可空，走懒解析
  createdAt, updatedAt
}

SessionReference {           // 第二层：这份内容在这个会话里被引用了（正式生效）
  id
  sessionId: string          // 'doc-<docId>' 或普通 chat 的 sessionId —— 复用项目里
                             // 本来就有的 sessionId 概念，不发明新概念
  userId, referenceId        // FK → ReferenceItem
  addedAt
  source: 'manual' | 'suggestion_accepted'   // 追踪来源，用于统计建议采纳率
}

SuggestedReference {         // 待用户确认的建议，新增
  id, sessionId, userId, referenceId
  reason: string              // 触发原因，如 "标题关键词匹配" / "对话内容命中未引用材料"
  suggestedAt
  status: 'pending' | 'accepted' | 'dismissed'
  resolvedAt: string | null
}
```

`docId` 绑定换成 `sessionId` 绑定后，写作会话和主 chat 会话在这一层完全对称——
项目里 `doc-<docId>` 本来就只是 `sessionId` 的一种前缀约定（参见
`TURN_INTENT_DESIGN.md` §2 对 scene 的定义），不需要为主 chat 另建一套模型。

`SuggestedReference` 被采纳时，创建一条 `source='suggestion_accepted'` 的
`SessionReference`，`SuggestedReference.status` 同步置 `accepted`；被划走则
只置 `dismissed`，不产生 `SessionReference`。

**收益**：

1. 一份文件/一条知识库摘要，在 A 文档引用过，切到 B 文档或主 chat 想用，只是
   新增一条 `SessionReference`（选择器里能看到"最近引用过的"直接勾选），不用
   重新粘贴/重新解析、不重复存正文。
2. 主 chat 免费获得和写作 chat 一样的引用体验——同一个 Reference 弹层组件、
   同一个解析注入函数（`buildDocReferenceBlocks` 泛化成按 `sessionId` 取数，
   参数从 `docId` 换成 `sessionId`），不用另起一套。
3. 主 chat 现在"每条消息重新带 fileId"的一次性附件可以保留，作为真正临时、
   不想留痕的快捷路径；用户想让某个文件持续生效时，点一下"固定为引用"，就从
   ephemeral attachment 升级成 `SessionReference`——两种模式并存，用户自己选。
4. `kind` 拆干净后，"要不要重新解析"从字符串魔法值（现在的
   `DOC_FILE_REF_KINDS = Set(['file','pdf','docx'])`）变成结构化判断：`file` 类
   必然有 `sourceRef` 指向 `FileIndex` 走提取管线，其余类型必然 `snapshot`
   直接可用。

### 4.5 与知识库检索（`kb_search`）的关系

`kb_search` 是**动态检索**：用户问一句话，系统实时去 Facts/Summary 里找最
相关的内容作答，结果是查询相关的、临时的，不需要被"固定"。`ReferenceItem`
解决的是另一件事：用户明确说"这份东西我要一直参考着"——是一个主动的、持久
的钉选动作。

两者的关系是：`kb_search` 检索到一条 Summary 之后，用户觉得有用，通过
Reference 弹层里的"知识库"入口把它**登记**成一条 `ReferenceItem`
（`kind='kb_summary'`）——从"检索结果"变成"固定引用"，是用户的一次显式动作，
不是自动发生的。这个衔接点本来就存在（`KbPicker` → `handleKbPickConfirm`），
不需要新设计，只是纳入新模型后数据落点从 `DocReference` 变成 `ReferenceItem`。

### 4.6 命名规范：`article` vs `summary` vs `document`

设计过程中发现代码里有**三个**不同的东西都可能被叫"article"，容易互相绕
进去，必须在新模型里避开：

1. **KB 合成摘要**（事实被总结出来的东西）：历史上叫 `article`，已经做过
   一次改名迁移成 `summary`（`common/kb-rename-migration.ts`）——
   `MemoryProposal.kind`、`embedding-index.ts`、`memory.graph.ts`、API 层
   （`/api/v1/knowledge/summaries`、`SummaryNode`）都已经是新名字。但没改
   干净，还留了几处历史命名的尾巴：
   - `memory/summary-service.ts:144,169` — 事件类型还叫 `memory_article_edited` /
     `memory_article_deleted`
   - `modules/knowledge/knowledge.router.ts:404` — 编辑 summary 时的审计日志
     `action: 'article_edited'`，和它旁边的 `'summary_created'`/`'summary_regenerated'`
     对不上，像是那次改名漏掉的一处
   这两处不是用户可见的地方（内部事件类型/审计日志），但既然要在本设计里
   新增 `ReferenceItem.kind = 'kb_summary'`，应该顺手把这两处遗留的
   `article` 命名也迁移掉，避免新老命名混着出现在同一份事件/审计记录里。

2. **用户上传的文件**：`/api/v1/knowledge/picker` 端点
   （`knowledge.router.ts:280` 注释："除合成文章(summary)外，同时列出用户
   上传过的文件(document)"）里叫 `document`；而 `DocReference.refType` 里叫
   `file`/`pdf`/`docx`。两处名字不统一，本设计选择沿用 `file`（因为
   `DOC_FILE_REF_KINDS`/`FileIndex` 这条提取管线已经用这个词），迁移时把
   picker 前端的 `document` 一并改成 `file`。

3. **真实的学术论文**（`submission/journal-*.ts`、`crossref.client.ts`、
   `oa-pdf-tool.ts`、`openalex-search-tool.ts` 里的"article"）：指的是从
   Crossref/OpenAlex 检索到的、发表在期刊上的论文，是选刊/文献检索模块的
   合法用词，和上面两个都不是一回事。**不在本次命名清理范围内**——做"全局
   搜 article 改名"时要明确排除这部分，否则会把选刊模块的正确命名也误改掉。

**结论**：`ReferenceItem.kind` 用 `'file' | 'kb_summary' | 'pasted_text'`，
不用 `'kb_article'`——否则会把已经费劲分清楚的"KB 合成摘要"和"上传的文章/
文件"两个概念重新绞在一起，违背当初改名的初衷。

### 4.7 主动建议怎么实现

**开局建议（关键词版，可以先上线的最小版本）**：打开会话时，用标题/最近
消息和用户名下所有 `ReferenceItem.label` 做关键词重叠匹配，命中则生成
`SuggestedReference`。不需要语义检索，成本很低，先解决"完全零建议"的问题。
建议的采纳/忽略结果应写入 4.2 节的 `MemoryUsageBus`（而不是只更新
`SuggestedReference.status` 这一处局部状态），这样"建议准不准"这个信号
才能反过来喂给 `MemoryGranularityController`，供未来自适应颗粒度使用。

**对话中建议（语义版，依赖一个现状缺口）**：现状 `embedding-index.ts` 只对
"已审核的记忆"（Facts/Summary）建语义索引，用户上传的文件全文**没有**被
embedding 索引——这是做"对话中建议"之前需要先补的一块基建：`ReferenceItem`
写入时（尤其是 `kind='file'`）把 `snapshot` 一并送入 embedding 索引，语义
检索才能覆盖文件类引用，不止 Facts/Summary。

**对话中建议的判定逻辑，复用而非新造**：知识库已有的"知识缺口检测"
（K6，`modules/knowledge/gap-research.service.ts`）判断的是"这个问题没被
任何事实覆盖"；同一个判定函数反过来跑一次就是"这个问题其实被一条材料覆盖，
但用户当前会话没有引用它"——不是新机制，是同一逻辑换一个方向使用。

### 4.8 与 STAIR（结构感知检索）的连接点，作为独立后续项

本设计理顺的是"引用列表怎么管理"，没有动"引用内容超预算时怎么选相关片段"
这件事——现在 `renderReferenceBody`（`chat-context.ts:510`）靠正则猜"第 N
章"或标题子串匹配，属于 STAIR 论文（arXiv 2609.03874）批评的"定长/朴素
匹配"检索问题。

可以作为独立的下一步：`ReferenceItem` 写入时顺手生成一份结构索引（复用
`block-projection.ts` 现成的 H1-H3 section 投影逻辑，泛化成"任意长文本"的
结构提取器，而不是只服务于 `Doc.body`），解析注入超预算时按结构选段，而不是
按正则猜章节号。这个思路同样能用在知识库自己的检索上——如果 KB 内容有天然
层级（长 Summary 有小标题，或未来允许结构化文档入库），可以把"检索单元从
定长 chunk 换成目录叶子节点"这个 STAIR 的核心动作用在 `kb_search` 上，与
embedding 语义检索互补，而不是替代（STAIR 论文自己在 Limitations 里也承认，
对没有天然结构的语料不适用）。

这一节不是本次要实现的内容，只是记录连接点，避免以后重新发现一遍。

### 4.9 与 Facts/Summary/Skills（Brain 2.0）的收敛关系

`ReferenceItem`/`SessionReference`/`SuggestedReference` 管理的是"外部内容"
（用户上传的文件、知识库摘要）的颗粒度；Facts/Summary（对话里提炼的知识）
和 Skills（`trajectory-induction.service.ts`，行动模式/经验）管理的是另外
两类内容——但面对的是**同一个架构问题**：什么时候该把一条细粒度记忆提升为
常驻、什么时候该把用不上的记忆降级/折叠。现状是三套（引用/Facts+Summary/
Skills）各自实现一遍这个逻辑，本设计不允许这种重复：

- `ReferenceItem`/Facts/Summary/Skills 都实现 4.2 节的 `MemoryTierStore`
  接口——存储形态各自不同（引用材料是文件快照、Facts 是图谱节点、Skills 是
  行为模式），但升降级/留痕走同一套契约。
- `SessionReference`/`SuggestedReference` 的采纳/忽略/引用次数，和 Facts/
  Summary 被 `kb_search` 命中、Skills 被 trajectory 匹配调用，都写进同一条
  `MemoryUsageBus`——不是"引用系统一套埋点、Facts 一套埋点"。
- `MemoryGranularityController` 是唯一的颗粒度决策入口，不区分"这条决策是
  为引用材料做的还是为 Facts 做的"。

这意味着本文档第七节的迁移阶段，不能只做"引用材料"这一条线就算完——
`ReferenceItem` 要真正纳入统一架构，需要 Facts/Summary/Skills 那一侧也完成
架构收敛，两者是同一个迁移计划的两条并行分支，具体阶段划分见第七节。

## 五、跨界面一致性

写作 chat 与主 chat 在"引用"这件事上必须是同一套东西，不是两套相似的实现：

- **同一个 UI 组件**：Reference 弹层（Pick from files / 知识库 / Paste text）
  从"绑 `docId`"泛化成"绑 `sessionId`"，同一份代码挂在两个页面上。
- **同一个后端解析函数**：`buildDocReferenceBlocks` 泛化为
  `buildSessionReferenceBlocks`，入参从 `docId` 换成 `sessionId`。
- **同一套建议机制**：`SuggestedReference` 的生成、展示、采纳/忽略逻辑不
  区分场景。

## 六、验收标准 / 北极星指标

设计红线（一句话）：**用户从"捕获"到"下次用上"之间，除了"钉一下"和
"确认一下"，不应该有第三个动作。** 任何功能设计出来需要用户做第三件事，
就要停下来问一句"这是必须的，还是我们在把整理工作丢给用户"。

可衡量的指标：

- **跨会话复用率**：同一条 `ReferenceItem` 被超过 1 个 `sessionId` 引用的
  比例——越高说明"一个记忆面"真正在发挥作用，而不是用户仍然在每个会话里
  重新登记。
- **建议采纳率**：`SuggestedReference` 里 `accepted` 占 `accepted+dismissed`
  的比例——过低说明建议触发得不准，过度打扰；持续为零说明这个功能形同虚设。
- **临时附件升级率**：主 chat 里"固定为引用"这个动作的使用率——验证
  ephemeral attachment → 正式引用这条路径是否真的被用户发现和使用。
- **验收标准（功能层面）**：
  - [ ] 同一份文件/知识库摘要在写作 chat 与主 chat 之间无需重新上传即可复用
  - [ ] 开局建议在标题/近期消息命中已有引用材料时正确触发，忽略后不重复打扰
  - [ ] 建议态与正式引用在 UI 上有清晰的视觉区分
  - [ ] 取消引用不影响 `ReferenceItem` 本体与其它会话的引用关系

## 七、迁移与实施阶段

`DocReference` 不需要推倒重来。迁移分两条并行分支——**引用材料线**（原
Phase 0-4，交付用户可见的功能）和**架构线**（新增，交付 4.2/4.9 节的共享
组件）——两条线在 Phase 5 之后汇合，前面可以部分并行，具体依赖见下表。

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **Phase 0** | 数据模型迁移：`ReferenceItem`/`SessionReference` 建表 + `DocReference` 数据迁移 + 命名清理（`article`→`summary`、`document`→`file`，见 4.6 节） | 无，最先做 |
| **Phase 1** | 主 chat 对称化：后端 `buildSessionReferenceBlocks` + `/api/v1/sessions/:sessionId/references`；前端 `useDocReferences` 泛化挂载 + "固定为引用" | Phase 0 |
| **Phase A**（架构线，可与 Phase 0/1 并行） | `MemoryGranularityController` 抽象：把 `compaction/runner.ts`/`knowledge-synthesis.ts`/`gap-research.service.ts` 现有规则原样搬进统一接口，**零行为改动的纯重构**，不涉及 `ReferenceItem` | 无，可并行 |
| **Phase B**（架构线） | `MemoryUsageBus` 落地：先只接 Facts/Summary 的使用信号（`kb_search` 命中、Summary 引用） | Phase A |
| **Phase 2** | 建议态（关键词版）：`SuggestedReference` 模型 + 开局建议横幅，采纳/忽略结果写入 `MemoryUsageBus`（而不是发明局部计数器，见 4.7 节） | Phase 0/1、Phase B |
| **Phase C**（架构线） | `MemoryTierStore` 契约化：Facts/Summary/Persona 三层实现统一升降级接口，留痕可见 | Phase B |
| **Phase D**（架构线） | Skills 并入：`trajectory-induction.service.ts` 改接 `MemoryTierStore`/`MemoryUsageBus`，两套平行体系正式合并 | Phase C |
| **Phase E**（架构线） | `ReferenceItem` 并入：实现 `MemoryTierStore` 接口，"固定为引用"/取消引用统一走该契约（见 4.9 节） | Phase 0/1、Phase C |
| **Phase 3** | 建议态（语义版）：文件类 `ReferenceItem` 接入 embedding-index；对话中建议接入 K6 反向判定逻辑 | Phase E |
| **Phase 4** | 隐式组织：引用材料选择器按"最近用过/最常用/当前场景相关"排序，直接读 `MemoryUsageBus` 聚合数据 | Phase E |
| **Phase F**（架构线，最后，风险最高） | 颗粒度自适应：`MemoryGranularityController` 内部规则逐步替换为基于 `MemoryUsageBus` 历史数据的自适应策略——前置条件是 Phase B-E 已跑一段时间、有真实使用数据可评估，不能一步到位 | Phase C/D/E 全部完成 + 观察期 |

排序原则：**先立架构边界（Phase A 是零风险重构），再把功能并进来（Phase
B-E），最后才碰"要不要自适应"这个最不确定的部分（Phase F）**——不会因为
想做"智能"而先破坏现有稳定行为。

与 STAIR 结构化检索相关的"引用内容超预算时怎么选相关片段"（4.8），是独立于
本迁移路径之外的后续优化项，不在上表范围内。

## 八、开放问题

- **主 chat 里的 ephemeral attachment 要不要默认自动升级成 `SessionReference`**
  （更省心，但可能让用户的"引用列表"意外堆积一堆一次性文件），还是必须
  用户手动点"固定为引用"（更明确，但多一步操作）？本设计倾向后者，理由见
  3.3 第 4 条，但需要产品确认。
- **`SessionReference` 是否需要支持"取消引用但保留 `ReferenceItem`"**（内容
  还在，只是这个会话不再用它）——这应该是默认行为（`ReferenceItem` 是用户级
  资产，删除 `SessionReference` 只影响这个会话），但要在实现时显式测试覆盖，
  避免误删 `ReferenceItem` 本体。
- **开局建议的触发时机**：每次打开会话都判定一次，还是只在会话的第一条消息
  时判定一次？前者更"主动"，但可能在长会话里显得啰嗦；需要产品拍板。
- **建议的展示位置**：写作 chat 里可以放在文档顶部的提示条；主 chat 里放在
  哪里（消息流顶部？输入框上方？）需要单独出一版交互稿。
- **`SuggestedReference` 的生命周期**：一条建议被划走之后，是永久不再对
  同一个会话提示同一条材料，还是有个冷却期后可以再提示一次（类似知识缺口
  的 7 天去重）？倾向永久不再提示（尊重用户的一次性决定），但需要确认。
- **文件类引用接入 embedding 索引后的隐私边界**：现有 embedding-index 只
  收录"已审核的记忆"，文件全文接入后是否需要额外的患者信息隔离规则（复用
  现有 `patient_hash` 范围隔离逻辑，还是需要新的边界）？涉及临床数据，
  需要单独确认。
- **Phase F 的自适应策略需要多久的观察期才可信**：`MemoryGranularityController`
  从固定规则换成基于 `MemoryUsageBus` 历史数据的自适应策略之前，需要多长的
  真实使用数据积累期、多少条独立样本，才能确认新策略不是过拟合到某个用户的
  偶然使用习惯？这一步在启动前需要单独出一份评估方案，不能靠直觉定"观察两周"
  这类数字。
- **`MemoryTierStore` 的降级操作会不会误伤低频但关键的记忆**：临床场景里有些
  事实"很少用到但一旦用到就很重要"（罕见并发症、过敏史），如果降级只看使用
  频率，可能把这类记忆错误折叠。需要在 Phase C/F 设计时加一个"重要性"信号
  （复用现有高重要性提案"置顶不自动归档"的逻辑），不能让使用频率成为唯一
  的降级依据。
