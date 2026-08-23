# 消息模型 Info/Parts 分离评估（#664）

> 对齐 opencode 的 `WithParts = { info: Info, parts: Part[] }` 模型。本文件
> 是评估先行文档：结论是**短期不做完整迁移**，先完成 #653（store 瘦身）+
> #660（SSE 批处理）+ #661（流式渲染），这三项已解决 80% 的渲染性能问题。

## 目标模型（opencode 参照）

```
Message (Info)                    Parts[] (内容, 有序)
┌───────────────────┐    ┌────────────────────────────────────┐
│ id / role         │    │ Part: Text "先检索文献…"           │
│ tokens / cost     │    │ Part: Tool "search_kb" (pending→    │
│ finish / agent    │    │        running → completed)         │
└───────────────────┘    │ Part: Text "检索到3篇…"            │
                         │ Part: Tool "stats_engine" (error)   │
                         │ Part: Reasoning "考虑入组标准…"      │
                         └────────────────────────────────────┘
```

- 元数据（Info）低频更新，内容（parts）独立更新、独立折叠
- 12 种 part 类型（Text/Reasoning/Tool/File/StepStart/Compaction…），
  Tool part 带 4 态状态机（pending→running→completed/error）
- DB 双表（MessageTable + PartTable），part 按 id 升序，id 单调递增
- UI 双索引 store：`message{sesID:[]}` + `part{msgID:[]}`

## heurion 现状

`web/src/stores/chat.ts` 的 `ChatMessage` 是单层扁平模型：

```ts
interface ChatMessage {
  id; role; text; reasoning?; toolCalls?; chart?; citations?;
  memoryHits?; imageUrl?; download?; knowledgePayload?; ...
}
```

- 一条 assistant 消息 = 回答 + 多次工具调用 + 图表 + 引用，全部在一个对象
- 任何一小段文本更新 → 整条消息组件重渲染（配合 #653/#660 已缓解）
- 工具状态、思考过程、附件没有独立生命周期
- 元数据（token/耗时/成本）与内容耦合

## 改造涉及面（跨三层，这是成本高的原因）

| 层 | 改动 |
|---|---|
| `contracts/src/chat.ts` | SSE 事件形状：`message.part.delta`（partID + field + delta）、tool.input.delta 等新事件类型 |
| `server-ts` 聊天管线 | 消息落库改为 info + parts 两段；流式推送改增量事件（text-delta / tool 状态机）；compaction 的 tail_start_id 边界标记（#657）依赖此模型 |
| `web` store + 组件 | `chat.store` 改双索引 map；ChatMessages / ToolCalls 全部按 part 分发渲染（#662 依赖此模型） |

## 收益 vs 成本

| 收益 | 成本 |
|---|---|
| 流式渲染只更新活动 part（性能） | 契约层事件类型重构（大） |
| 工具/思考/附件独立折叠（UX） | server-ts 持久化与事件流重构（大） |
| 压缩可逆标记（#657）的天然载体 | web store + 全部组件重构（大） |
| 会话恢复合并（#663）更精确 | 回归风险高（聊天是核心路径） |

## 结论与建议路径

1. **短期（本体检周期）**：不迁移。用 #653 选择器 + #660 批处理 + #661
   流式渲染解决性能问题；#662 的工具 4 态可在现有单层模型上实现
   （工具状态字段从 `toolCalls` 扩为带状态的对象数组即可）。
2. **中期**：若 #662 状态机 + #657 可逆压缩落地后仍遇模型瓶颈，再启动
   迁移。迁移时按「contracts 事件 → server-ts 落库 → web store → 组件」
   顺序分 4 个 PR 推进，每个 PR 保持双写兼容（旧事件类型继续消费）。
3. **前置条件**：#660 的 delta 合并器、#663 的 touch-tracker 均可复用为
   迁移后的基础设施，先做不浪费。

关联：epic #639
