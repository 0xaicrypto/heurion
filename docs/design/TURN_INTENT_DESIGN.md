# 意图→工具→回答：场景感知的业务流设计

**Status:** Design proposal (v1.0)
**更新:** 2026-08-20
**Deciders:** JZ (architect), backend team
**关联:** 承接 `docs/design/HARNESS_INSPIRED_EVOLUTION.md` §4.5；落地于 heurion 现有 scene（#510/#546）、意图判定（#549/#557/#558/#562/#561）、`edit_document`（§15.4）与附件注入（#2/#511）。

---

## 1. 问题定义

用户的完整诉求是：**意图精准理解 → 判定调用对应工具 → 给用户合理回答**。

同一个句子在不同入口语义不同、工具路径不同：

| 用户输入 | 场景 | 期望行为 |
|---|---|---|
| 上传文件 +「帮我润色一下」 | 通用 chat | 在对话里直接给出润色结果（不动草稿） |
| 「帮我润色一下」 | 写作 chat（`doc-{id}`） | 直接改当前草稿（`edit_document` 写回，画布更新） |
| 「帮我总结一下治疗经过」 | 任意 | 口头总结，**绝不生成文件**（#558 回归） |
| 「生成一份出院小结 docx」 | 任意 | 走渲染插件生成文件 |

现状已经有支撑各分段的零件，但其职责散落在 `chat-handler.ts` 的线性代码里，且存在三处盲区：

1. **场景盲区**：`isSidecarVetoed` 只回答「是不是文件生成请求」（布尔），不区分 action 与 target——「编辑当前草稿」和「编辑刚上传的附件」都算 edit，但工具路径完全不同。
2. **目标消歧盲区**：写作 chat 里上传外部文件并说「润色这个」，系统和当前文档（`docContext`）与附件并存，不知道该改谁。
3. **结果落地盲区**：通用 chat 附件的润色结果只留在对话里，没有「保存/导出」出口。

本设计把这三处盲区显式化并补上，形成一条可测试、可观测的完整业务流。

---

## 2. 决策信号（路由的输入特征）

| 信号 | 来源 | 说明 |
|---|---|---|
| `scene` | `resolveScene()`（#546） | 用户所在入口：`general / patient / document / chart`；决定作用域与工具面 |
| `attachments` | `buildAttachmentParts()`（#511） | 本轮是否携带上传文件（图片/文本）；决定是否存在候选 target |
| `action` | 判定管道（§4） | 用户想**做什么**：`answer / edit / generate / retrieve / command` |
| `target` | 判定管道（§4） | 作用于**哪个对象**：`current_doc / attachment / patient / none / external` |
| `history`（最近 2-6 轮） | `eventLog` | 承接指代（「做好了发我」）；#558 已验证必需 |
| `availability` | 插件安装 + `SCENE_OMIT_TOOLS` + 会话前缀 | 工具/插件是否可达（`edit_document` 仅 `doc-`；渲染插件需安装启用） |

**核心原则：scene 回答「作用域」，action 回答「做什么」，target 回答「作用于谁」——三者解耦后组合。**

---

## 3. TurnIntent 模型

判定结果不再是一个布尔，而是一个结构化的、可落事件、可回滚的意图对象：

```ts
type TurnAction =
  | 'answer'     // 讨论/解释/口头总结/普通对话
  | 'edit'       // 修改既有对象：当前文档或上传附件
  | 'generate'   // 产生新交付物（文档/PPT/表格/图表/PDF）
  | 'retrieve'   // 检索（患者/知识库/SQL/文件）
  | 'command'    // 显式命令（kb_search / kb_remember / …）

type TurnTarget =
  | 'current_doc'  // 写作会话的当前草稿（doc-{id}）
  | 'attachment'   // 本轮上传的文件
  | 'patient'      // 当前患者（patient/scene 下）
  | 'none'         // 无具体对象
  | 'external'     // 用户提到的外部文件（非本轮附件、非当前文档）

interface TurnIntent {
  action: TurnAction
  target: TurnTarget
  /** 判定来源，用于审计与成本核算。 */
  source: 'veto' | 'rule' | 'semantic' | 'llm' | 'clarify'
  confidence: number
  needsClarify: boolean       // 需要用户确认（不确定性）
  clarifyOptions?: string[]   // 给前端的反问选项（复用 intent_clarify 事件）
  payload: {
    editDocumentId?: string
    attachmentHash?: string
    patientHash?: string
    summary?: string          // 模型判定的意图摘要，用于语料
  }
}
```

注意：`needsClarify` 必带 `intent_clarify` 事件 + 标签回写（#561），并把用户选择写回语料（#560）作为显式种子。

---

## 4. 双层判定管道（场景感知）

把现在 `resolveSidecarIntent` 里的 if-else 上移为显式解码函数 `decodeTurnIntent(context) → TurnIntent`，纯函数、可单测、可记录。

```
用户消息 (scene, attachments, text, history)
  │
  ├─ L0 确定性特征（0 LLM）
  │    ├─ target 解析：写在 target 判定前
  │    │    ├─ scene=document 且无附件 → target=current_doc
  │    │    ├─ 有附件 + 明确指代（"这个文件/这个附件/上传的"） → target=attachment
  │    │    ├─ scene=patient → target=patient（无则降级，见 #546）
  │    │    └─ 其余 → none
  │    ├─ command 匹配（parseKnowledgeCommand）→ action=command
  │    ├─ 强否决（DISCUSSION/EDIT_MARKERS）→ action=answer（edit 已含于 EDIT_MARKERS，见下）
  │    └─ 触发词候选召回 → action=generate（低置信候选）
  │
  ├─ L1 语义层（可选，INTENT_SEMANTIC_ROUTER=shadow|on）
  │    └─ 对 (text) 三分类：generate / veto(edit/answer) / uncertain（复用 #562）
  │
  ├─ L2 LLM 裁决（一次，≤50 token，deepseek-chat）
  │    └─ 输入：scene + target 候选 + text + history
  │       输出：JSON { action: ..., target: ..., confidence, needsClarify }
  │       规则：编辑/润色绝不等于 generate；粘贴长文配短指令不构成 generate；
  │             拿不准 → needsClarify=true, action 保持保守（answer/generate 中的保守侧）
  │
  └─ L3 落定
       ├─ needsClarify=true → 发 intent_clarify 事件，等用户选择后续回合
       ├─ 否则按 §5 路由表执行
       └─ 全程落 turn/intent-decode 事件（含 source/confidence/成本）
```

设计要点：

- **veto 的职责收窄为「action=answer 的确定性锚点」**。`EDIT_MARKERS` 不再只是「不生成」，而是映射为 **action=edit**（编辑已存在对象）——同一个否决信号在路由表里往前走而不是退回对话。
- **LLM 只裁决最必要的一维**：action + target + 置信度；scene/attachment/可达性是确定性的，不进 LLM（省 token、可回归）。
- **保守原则不因语义层削弱**：任何一层失败 → 回落到下一层；L2 失败/超时/异常 → `answer`（永不生成）。
- **成本可度量**：`turn/intent-decode` 事件记录 `llmCalls: 0|1`、`source`、`confidence`，作为 #560 语料字段。

---

## 5. 路由决策表（action × scene）

| scene \ action | answer | edit | generate | retrieve | command |
|---|---|---|---|---|---|
| **general** | 直接对话 | 有附件 → 对话中给结果 + 提供「另存/导出」选择；无附件 → 直接对话给修改建议（不触碰任何文件） | 确认 `generate` 后走插件路径（§6） | 常规检索（不含患者工具） | KB 命令处理 |
| **document** | 基于 `docContext` 对话 | `target=current_doc` → 调 `edit_document` 写回草稿 + `doc_updated` 事件；`target=attachment` → 对话给结果 + 可选导入当前文档 | 新文件需求 → 插件生成；「把当前草稿整理为规范文档」→ 仍走 `edit_document` | 常规检索（不含患者工具） | KB 命令处理 |
| **patient** | 基于患者上下文对话 | 编辑患者摘录/记录（对话内确认后写回） | 出院小结等患者交付物 → 插件（携带 patient 上下文） | 患者检索（完整工具面） | KB 命令处理 |
| **chart** | 图表解读/分析（诚实：无数据则明说） | 不适用（图表无编辑对象） → 降级 answer | 统计图表 → 渲染插件 | 数据表/统计检索 | — |

**既定不变式（不可妥协）：**

1. `answer` 与 LLM 失败/uncertain 永不触发生成（#557/#558 原则）。
2. `scene=document` 场景只格式化当前文档相关数据源，不注入患者检索/全局记忆（#510/#546）。
3. `edit_document` 只在 `doc-` 会话暴露；非 `doc-` 会话即使模型输出该调用也**拒绝执行**（现有工具内校验保留）。
4. 写作会话（`doc-*`）内容永不进入记忆抽取/压缩（现有 `isWritingSession` 逻辑保持）。

---

## 6. 走通四个典型例子

### 例 A：通用 chat 上传文件 +「帮我润色一下」

```
L0: scene=general；有附件 → target=attachment 候选；EDIT_MARKERS("润色") 命中
   → 候选 action=edit
L2: LLM 确认 action=edit, target=attachment（附件的修饰对象）
落定: 不进入插件、不调用 edit_document（无 doc- 会话）
执行: 对话流注入附件文本 → 模型输出润色结果
改进点(新增): 结果后追加「保存为文档 / 导出」可选项
   → 用户选择后创建新 doc 或走导出插件（把「对话答案」升级为「可交付物」，消除盲区 3）
```

### 例 B：写作 chat「帮我润色一下」（正在编辑草稿）

```
L0: scene=document；无附件 → target=current_doc；EDIT_MARKERS 命中 → 候选 action=edit
L2: 确认 action=edit, target=current_doc
落定: 不进入生成插件
执行: docContext 注入当前文档 → 模型调用 edit_document(full_text, summary)
   → worker/服务写回草稿 → doc_updated 事件 → 前端画布更新（现有 §15.4 链路）
```

### 例 C：写作 chat 上传外部论文 +「润色这个文件」（新增场景，消歧盲区 2）

```
L0: scene=document；有附件 + 明确指代("这个文件") → target=attachment 优先
   歧义：同时存在 current_doc 与 attachment
L2: LLM 裁决 target：
   ├─ 若为 attachment → 对话中给出润色结果；可提供「并入当前文档」(导入草稿)选项
   └─ 若为 current_doc → 走 edit_document（附件仅作参考材料）
   若 LLM 也不确定 → needsClarify → 前端反问：「润色当前草稿还是上传的文件？」
```

### 例 D：通用 chat「帮我总结一下这个病人的治疗经过」

```
L0: scene=general；DISCUSSION_MARKERS("总结"是讨论语义，见 #558 硬规则) → 候选 action=answer
L2: 确认 action=answer（verbal summary，非文件）
落定: 普通对话返回口头总结；绝不生成文档（即使装置 docx 插件）
回归锚点：intent-regression 真值集用例（#559）保持锁定
```

---

## 7. 事件与持久化

复用 `HARNESS_INSPIRED_EVOLUTION.md` §4.1 的会话事件日志模型，新增/复用以下事件：

| 事件 | 时机 | 关键字段 |
|---|---|---|
| `turn/intent-decode` | 每轮判定落定后 | `action, target, source, confidence, llmCalls, cacheHit` |
| `turn/route` | 路由执行前 | `scene, route, tools 数量` |
| `tool/edit-document` | 写回时刻 | `docId, version, snapshotId, bodyHash` |
| `intent_clarify` + 标签回写 | needsClarify 时 | `options, choice→(explicit_confirm/explicit_deny)` |
| `socket/file-export` | 例 A 的导出出口 | `sourceAttachmentHash, outputFileId` |

所有事件脱敏（`patient_hash`/`query_hash`），供 #560 语料导出与审计重建。

---

## 8. 对现有代码的最小改造清单

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | 新增纯函数 `decodeTurnIntent()` | 新 `modules/chat/turn-intent.ts` | 收敛所有散落的判定（scene/attachment/marker/LLM/语义层），返回 `TurnIntent`；导出 `buildTurnIntentPrompt()` 供单测 |
| 2 | `chat-handler.ts` 主流程改消费 `TurnIntent` | `modules/chat/chat-handler.ts` | 替换 §520-620 的手写 `resolveSidecarIntent`/`matchIntent` 分支；SSE 仍按决策表发事件（事件化在阶段 1 落地） |
| 3 | `matchIntent` 改为「插件可用性确认」 | `plugins/plugin-capability.service.ts` | 接收 `TurnIntent`，仅在 `action=generate` 时查询插件，保持三态语义 |
| 4 | `edit_document` 暴露面由场景决定 | `tools/edit-document-tool.ts` + `tool-registry.ts` | 非 `doc-` 会话不暴露该工具定义（当前仅运行时拒绝） |
| 5 | 新增目标消歧（例 C） | `turn-intent.ts` + 前端 | 当 `target` 候选 ≥2 且 LLM 不确定 → `intent_clarify` 事件 |
| 6 | 附件导出出口（例 A 改进） | `modules/files` / `plugins` | 「保存为文档」→ 创建 doc 或走导出插件 |
| 7 | 回归锚点扩展 | `tests/unit/intent-regression.test.ts` | 新增例 A-D 四组用例，表驱动 |

---

## 9. 验收标准

- [ ] 例 A/B/C/D 行为断言成立（真值集新增 4 组用例 + 单测）。
- [ ] `TurnIntent` 五类 action 全部可达，且 `source/confidence/llmCalls` 有测试覆盖。
- [ ] 场景盲区 2/3 已消除：写作会话的附件消歧有 UI 分支；通用会话附件的展示有一次导出入口。
- [ ] `doc-` 会话未暴露 `edit_document` 到非 `doc-` 工具面；通用会话无生成插件误入。
- [ ] 全量测试基线不劣化（当前 780 passed / 3 skipped；tsc --noEmit 无错误）。
- [ ] 无新依赖；`lint`/`typecheck` 通过。

---

## 附：与既有系统映射

| 概念 | 现状 | 本设计落地 |
|---|---|---|
| scene 判定 | `resolveScene`（#546） | 保留；并入 `decodeTurnIntent` 特征 |
| 强否决 | `isSidecarVetoed`（#557） | 收窄为 `action=answer/edit` 锚点 |
| 语义路由 | `SemanticIntentRouter`（#562，opt-in） | 作为 L1；正式化门槛按 #559 recall |
| LLM 裁决 | `createDefaultSidecarClassifier`（3 态，50 token） | 升级为输出 `{action, target, confidence, needsClarify}` 的 4+ 维 JSON（仍一次调用） |
| 插件路由 | `matchIntent` + `handlePluginChatRequest` | 收敛为「generate 时的插件可用性确认 + 渲染」 |
| 文档写回 | `edit_document`（§15.4） | 由决策表驱动，仅 `doc-` 暴露 |
| 语料/回写 | `sidecar_judge` 遥测（#560）、`intent-regression`（#559） | 新增 `turn/intent-decode` 事件承载更细字段 |