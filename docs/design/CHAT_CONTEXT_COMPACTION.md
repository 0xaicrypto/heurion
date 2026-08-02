# Chat 上下文预算管理与自动压缩 — 优化设计

> 状态：设计稿（Draft）
> 关联：ROADMAP Phase P（RLM 聊天上下文）、#96（历史 token 预算）、brain2.0 chat
> 参考实现：opencode 的 compaction / summary 系统代理、子代理（explore）按需检索模式

---

## 1. 背景与现状

### 1.1 问题

长会话中 LLM 上下文无限膨胀。当前只有输出侧 `max_tokens: 4096` 兜底，输入侧历史全量注入，导致：

- 长会话 token 成本线性增长，最终触发模型窗口上限；
- 注入内容中大部分是早已过时的早期对话，稀释注意力（lost in the middle）；
- 裁剪/压缩逻辑缺失，早期关键信息（诊断结论、决策）可能被静默丢弃。

### 1.2 现状盘点

| 模块 | 现状 | 位置 |
|---|---|---|
| 记忆侧预算 | ✅ 4 层 token 预算（persona/patient/最近轮次/episode/事实/技能），每层限额 + reserve | `src/retrieval/memory-projection.ts` |
| 会话摘要 | ✅ EpisodesStore 7 天摘要，注入 layer2（注意力衰减排序） | `src/evolution/stores` |
| 压缩原语 | ✅ rankByAttention / dedup；`compactContext` 目前是死代码 | `src/retrieval/context-compressor.ts` |
| 历史 token 预算 | ✅（#96 已合并）`buildHistoryMessages()`：新→旧累积，`MAX_HISTORY_TOKENS`(默认 8000)/`HISTORY_TURNS`(默认 20)，超限硬裁剪 + system 提示 | 同上 + `chat.router.ts` |
| 双重注入 | ⚠️ projection layer1（最近轮次）与 messages 原始历史重叠 | `memory-projection.ts` vs `chat.router.ts` |
| 真实 token 核算 | ❌ 字符估算（英文 4 chars/token，中文 1.5） | `estimateTokens` |
| 按需检索 | ❌ 无历史检索工具 | — |
| 用量可视化 | ❌ 仅 context_info 文本行 | — |

---

## 2. 目标

1. **有界**：任意长度会话的输入 token 有明确上限（相对模型窗口的百分比，而非绝对值）；
2. **无损（语义上）**：被裁剪的早期对话以结构化摘要保留，不静默丢失临床关键信息；
3. **按需**：模型可主动检索更早的对话（RLM 第一步）；
4. **可观测**：UI 显示上下文用量，管理员可审计压缩事件。

非目标：不改变链上锚定（chain anchor 保持确定性 manifest，见 ROADMAP Phase P 的 DPM 拆分决策）。

---

## 3. 参考：opencode 的实现

| opencode 机制 | 说明 | 对 Heurion 的映射 |
|---|---|---|
| **compaction agent**（隐藏系统代理） | 上下文接近阈值时自动触发，用一次 LLM 调用把较早对话压缩为摘要，替换原文；**最近 N 轮逐字保留**；摘要包含任务状态/TODO/决策 | 本项目核心借鉴：`chat-compactor` |
| **summary / title agent** | 自动生成会话摘要与标题 | 升级 EpisodesStore：每轮结束异步更新 |
| **子代理（explore）按需检索** | 主代理不背全量上下文，需要时调用子代理/工具检索 | `search_conversation` 工具（语义检索历史 turns） |
| **permanent / pin 上下文** | 关键消息标记保留，压缩不丢弃 | 高价值对话自动提升为 facts（已有 layer3 注入） |
| **真实 token 用量** | 按模型实际窗口核算并展示 | tiktoken 风格估算 + UI 用量条 |

---

## 4. 总体架构

```
┌────────────────────────── 一次 chat turn ──────────────────────────┐
│                                                                     │
│  eventLog ──► buildHistoryMessages(#96) ──► [最近 N 轮原文]          │
│                   │                                                 │
│                   ▼                                                 │
│           超过阈值？ ──否──► 直接组装 messages                        │
│                   │是                                                │
│                   ▼                                                 │
│         chat-compactor（自动压缩代理，异步）                          │
│         ├─ 生成结构化摘要（flash 模型，专门 prompt）                  │
│         ├─ 摘要落库为 episode（supports 后续轮次）                   │
│         └─ 替换被裁剪的早期轮次为摘要块                              │
│                                                                     │
│  systemPrompt = persona + patient + episodes + facts + skills       │
│  messages     = [摘要块] + [最近 N 轮原文] + 当前提问                 │
│  + search_conversation 工具（按需回溯更早历史）                      │
└─────────────────────────────────────────────────────────────────────┘
```

职责划分（消除双重注入）：
- **systemPrompt = 记忆层**：persona / 患者上下文 / episode 摘要 / 注意力事实 / 技能（现 projection 的 layer2/3/4）
- **messages = 对话层**：最近 N 轮原文 + 压缩摘要块 + 当前提问（projection layer1 移入 messages 预算体系）
- **工具层**：`search_conversation` 按需回溯

---

## 5. 详细设计

### 5.1 自动压缩代理（chat-compactor）—— P0

**触发**：`buildHistoryMessages` 返回 `omittedTurns > 0`，或预估历史 token 超过 `CONTEXT_COMPACT_THRESHOLD`（默认模型窗口的 70%，窗口按 `MODEL_CONTEXT_WINDOW` env，默认 32768）。

**流程**（异步，不阻塞当前轮次；当前轮先用硬裁剪的提示占位）：

```
1. 取被裁剪的早期轮次（原文，最多 COMPACT_INPUT_TURNS=80 轮）
2. 用专门 prompt + flash 模型生成结构化摘要（见 5.1.1）
3. 摘要写回 eventLog（新事件类型 compact_summary，metadata: {sourceTurnRange, model, tokens}）
4. 更新该会话的 episode（EpisodesStore.upsert）供后续轮次注入
```

**当前轮行为**：压缩是异步的，因此当前轮 messages 中仍插入占位提示（#96 已实现），提示模型"更早上下文见会话摘要"；压缩完成后**后续轮次**自动使用新摘要（episode 已更新，且 `compact_summary` 事件参与 `buildHistoryMessages` 的输入——见 5.1.3）。

**5.1.1 压缩 prompt（临床专用）**

```
你是临床对话摘要器。把以下对话压缩为结构化摘要，保留：
- 患者标识与诊断结论（含鉴别诊断）
- 已做出的治疗决策与理由
- 用药/剂量变更
- 关键检查数值与趋势
- 未解决问题与待办（含时间节点）
- 用户偏好与约束
要求：中文输出；≤300 tokens；JSON 格式 {summary, decisions[], pending[], values[]}；
不要杜撰原文没有的信息。
```

**5.1.2 并发与幂等**

- 同一会话同时只允许一个压缩任务（内存 Map 或事件表唯一约束）；
- 压缩基于 eventLog idx 范围，重复触发时覆盖旧摘要（episode upsert）；
- 失败重试 1 次，再失败记录 `compaction_failed` 事件，保留硬裁剪兜底。

**5.1.3 摘要进入 messages**

`buildHistoryMessages` 输入扩展到两种事件：
- `user_message` / `assistant_response` → 原始轮次（预算内保留）
- `compact_summary` → 作为 system 角色块注入（预算外固定分配 `COMPACT_SUMMARY_TOKENS`=400）

即压缩后，后续轮次的 messages 结构变为：

```
[system: persona + patient + episodes + facts + skills]
[system: 📌 早期对话摘要（第 1–120 轮）：{...}]
[user/assistant: 最近 N 轮原文]
[user: 当前提问]
```

**5.1.4 数据模型**

eventLog 新增事件类型（eventType 字符串，无 schema 变更）：

```ts
{
  eventType: 'compact_summary',
  content: '{"summary": "...", "decisions": [...], "pending": [...], "values": [...]}',
  metadata: {
    sourceFromIdx: number,   // 覆盖的事件范围
    sourceToIdx: number,
    model: 'deepseek-v4-flash',
    estimatedTokens: number,
  },
}
```

EpisodesStore 复用：`upsert(sessionId, { summary, createdAt: now })`。

### 5.2 search_conversation 工具—— P1

**目的**：模型按需回溯被压缩/未注入的更早对话（opencode explore 模式），也是 Phase P（RLM）的第一步。

**注册**：`tools/` 新增 `SearchConversationTool`，加入 ToolRegistry。

```
参数：
  query: string          // 语义查询
  session_id?: string    // 缺省当前会话
  before_idx?: number    // 只搜该事件之前的（配合压缩范围）
  top_k: number = 5

实现：
  1. 取该会话全部事件（或 before_idx 之前）
  2. 用 embedding（LocalEmbeddingProvider）对事件内容向量化，余弦相似度排序
  3. 返回 top_k 条 {idx, eventType, content(截断 400 字符), timestamp}
```

**工具描述**（给模型看）：

```
Search older conversation turns. Use when the user references something from
earlier in this session that may have been compacted or is not in the recent
context. Returns the most semantically relevant turns.
```

**前端**：复用现有 tool_call 事件流（`chat.tsx` 已渲染 tool_call + 结果注入），无前端改动。

**评估**：压缩摘要 + search_conversation 的召回质量用一组预置临床问答评测（见 §9）。

### 5.3 永久上下文（pin → facts）—— P1

- 聊天中模型输出/用户明确的高价值内容（`记住`、`诊断结论`、`治疗方案变更`）已走 knowledge command 写入 facts；
- 新增：压缩时对**最近 3 轮内**出现的关键信号（`记住`、`诊断`、`确认`、`方案`）做轻量正则提示，压缩 prompt 中强制要求这些内容进入 `values`/`decisions` 字段（5.1.1 已含），保证不丢失；
- 用户可在前端对单条消息点"固定"（pin），后端写 metadata `pinned: true`；`buildHistoryMessages` 对 pinned 消息**永不裁剪**（预算内强制保留，超预算时优先裁剪非 pinned）。

### 5.4 真实 token 核算—— P1

`estimateTokens` 升级为 tiktoken 风格近似（纯 JS，无新依赖）：

```ts
// BPE 近似：ASCII 按 GPT-4 cl100k_base 的字节对编码思路无法完全复刻，
// 采用两段式：
//  - ASCII：cl100k 词表近似（常用英文单词查表 + 未命中按 4 chars/token）
//  - CJK：按 1 token/字符（cl100k 中 CJK 大多为单 token，部分双 token，取 1.2 保守系数）
```
- 保留现有接口签名，`estimateTokens` 内部实现替换；
- 新增 `MODEL_CONTEXT_WINDOW` env（默认 32768），预算=窗口×`CONTEXT_COMPACT_THRESHOLD`(默认 0.7)；
- 误差校验：抽样 20 条真实对话与 DeepSeek API 返回的 usage.completion_tokens/prompt_tokens 对比，误差 >15% 则调系数（§7 加回归测试）。

### 5.5 上下文用量 UI—— P2

- SSE 新增 `context_usage` chunk：`{usedTokens, maxTokens, compactedRounds, pinnedCount}`；
- 前端 chat 顶部进度条（used/max），超过阈值变黄，压缩触发后显示"已自动压缩 N 轮，点击查看摘要"；
- 会话列表显示摘要（来自 episodes）；
- Admin 观测页：压缩事件列表（时间、覆盖范围、模型、token 数）。

### 5.6 会话摘要自动生成—— P2

- 每轮结束异步调用 summary agent（flash 模型）更新 episode（复用 5.1 的压缩结果，避免重复调用：压缩摘要即会话摘要的输入）；
- 会话列表展示摘要文本（现有 `GET /api/v1/sessions` 增加 `summary` 字段）。

---

## 6. API 与配置变更

### 6.1 配置项（env，全部有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_HISTORY_TOKENS` | 8000 | 历史原文预算（#96 已有） |
| `HISTORY_TURNS` | 20 | 保留原文的最大轮数（#96 已有） |
| `MODEL_CONTEXT_WINDOW` | 32768 | 模型窗口，压缩阈值基数 |
| `CONTEXT_COMPACT_THRESHOLD` | 0.7 | 触发压缩的历史占比阈值 |
| `COMPACT_INPUT_TURNS` | 80 | 单次压缩输入的轮数上限 |
| `COMPACT_SUMMARY_TOKENS` | 400 | 摘要块固定预算 |
| `COMPACTION_ENABLED` | true | 总开关（故障时快速降级为硬裁剪） |

### 6.2 新事件类型 / 端点

- eventLog 事件：`compact_summary`、`compaction_failed`
- 工具：`search_conversation`
- SSE chunk：`context_usage`
- `GET /api/v1/sessions` 增加 `summary` 字段
- Admin：`GET /api/v1/admin/compactions`（分页）

---

## 7. 实施计划

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **C.1** | `estimateTokens` 真实化 + `MODEL_CONTEXT_WINDOW`/阈值接入；回归测试 | — | 2d |
| **C.2** | chat-compactor：压缩 prompt、异步执行器、事件落库、episode upsert、幂等 | C.1 | 4d |
| **C.3** | `buildHistoryMessages` 支持 `compact_summary` 注入 + pinned 保留；消除 projection layer1 重复注入 | C.2 | 2d |
| **C.4** | `search_conversation` 工具 + 评测集 | C.1 | 3d |
| **C.5** | `context_usage` SSE + 前端用量条 + 会话摘要展示 | C.2 | 2d |
| **C.6** | admin 压缩事件页 + pin 前端交互 | C.3 | 2d |

总计约 15 个工作日，C.1–C.3 为 P0（先上线自动压缩），C.4 可与 C.2 并行。

---

## 8. 测试计划

| 层 | 用例 |
|---|---|
| 单测 | `estimateTokens` 中英混合精度；`buildHistoryMessages` + compact_summary 注入顺序与预算；pinned 永不裁剪；压缩幂等（同范围重复触发只产生一次）；并发防抖 |
| 集成 | 模拟 60 轮对话 → 触发压缩 → 断言 episode 更新、`compact_summary` 事件存在、后续轮 messages 结构正确 |
| 评测（临床召回） | 20 条预置 QA（跨压缩边界提问，如"第 3 轮提到的剂量是多少"），压缩+search_conversation 组合召回率 ≥ 80% |
| 回归 | 现有 364 用例不回归；`/api/v1/agent/chat` SSE 增加 context_usage 后前端兼容（旧前端忽略未知 chunk） |

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 摘要丢失关键临床信息 | 结构化字段（decisions/pending/values）+ pin 机制 + 评测集把关；压缩失败保留硬裁剪兜底 |
| 压缩成本（额外 LLM 调用） | flash 模型 + 每会话并发 1 + `COMPACTION_ENABLED` 开关；压缩频率受阈值控制 |
| 异步时序（摘要未完成用户已追问） | 当前轮用占位提示（已有），压缩完成即生效于下一轮 |
| 双重注入回归 | C.3 明确职责：systemPrompt=记忆层，messages=对话层，删 projection layer1 |
| token 估算偏差 | 真实 usage 对比回归测试，系数可调 |
| 前端兼容 | 新 chunk 未知字段，旧前端忽略（现有代码已按 type switch，default 分支返回原消息） |

---

## 10. 与既有路线图的衔接

- **ROADMAP Phase P（RLM）**：C.4 的 `search_conversation` 是 RLM 运行时导航的雏形；Phase P 落地时替换为 `RLMRunner`，工具与摘要机制可直接复用；
- **Phase O（Falsifiable Evolution）**：压缩摘要可写入 evolution 提案/验证链路（摘要质量作为可观测指标）；
- **#96**：C.3 建立在其 `buildHistoryMessages` 之上，保持向后兼容（env 默认值不变）。
