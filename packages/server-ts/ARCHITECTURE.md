# Heurion Backend (server-ts) — Architecture

> **注意**：本文档 2026-08 重写。旧版本描述的是 Python 时代的"进化回路"
> 设计（EventLog → EXTRACT → GRAPH → DISTILL → EVOLVE → RETRIEVE 六步
> 回路），其中的模块映射（modules/extraction、modules/graph、
> modules/practitioner、evolvers、VerdictRunner 等）从未在 TypeScript
> 侧落地，已废弃。当前真实结构见下方；仓库级总览见根 `ARCHITECTURE.md`。

## 目录结构与职责

```
src/
├── main.ts                 # 启动入口（prisma sync、队列、worker、优雅停机）
├── app.ts                  # Fastify 应用装配（路由注册、中间件）
├── config.ts               # 进程级配置（env 读取）
├── common/                 # LLM 网关（LlmGateway 策略 + 门面）、logger、prisma
├── core/                   # 原语层：event-log（不可变追加）、versioned-store
├── evolution/              # 记忆进化 stores（facts/episodes/skills/knowledge）
│                           #   + cascade-gaps（工具存储，gap 检测已迁 Prisma）
├── memory/                 # MemoryService + MemoryGraphGateway 门面
│   ├── embedding/          #   本地 ONNX 嵌入
│   ├── proposal/           #   proposal → 审批 → 应用
│   ├── summary/            #   会话摘要
│   ├── compaction/         #   记忆压缩/提取
│   └── legacy-projection.ts#   legacy 事实双写投影（#439 已知债务）
├── modules/                # 业务模块（每个模块 = service + router）
│   ├── auth/  patients/  chat/  ingestion/  knowledge/  documents/
│   ├── research/  submission/  skills/  plugins/  approvals/
│   ├── memorization/  practitioner/  external/  evolution/  stubs/  report/
│   └── brain/  files/  settings/  admin/  ...
├── patients/ → 已并入 modules/patients（graph-extractor 已删）
├── retrieval/              # 检索层：query-router、intent-router（#557/#562）、
│                           #   unified-search（#637）、memory-projection
├── tools/                  # BaseTool + ToolRegistry、stats-engine（#445 策略）、
│                           #   bioscene、mcp-tools、data-table-tool
└── lib/                    # 共享工具（document-extractor、data-table 等）
```

## 关键设计（对应根 ARCHITECTURE.md 的 #编号）

| 设计 | 位置 |
|---|---|
| LlmGateway 策略 + DIP（#436） | `common/llm-gateway.ts`（`common/llm.ts` 薄门面） |
| BaseTool + ToolRegistry（#107/#454/#510） | `tools/base-tool.ts`、`tools/tool-registry.ts` |
| StatsEngine 策略（#445） | `tools/stats-engine.ts`（Python worker 权威 + TS 回退） |
| IntentRouter 收敛（#557）+ 语义路由（#562） | `retrieval/intent-router.ts`、`semantic-intent-router.ts` |
| 插件系统（manifest→catalog→install→intent→payload） | `modules/plugins/` |
| 聊天管线（routed/plugin/direct，SSE 事件） | `modules/chat/chat-handler.ts`、`conversation-turn.ts` |
| 上下文组装（#630/#637/#635 预算分层） | `modules/chat/context-assembler.ts`、`chat-context.ts` |
| 记忆（graph + legacy 双写，补偿式原子性 #439） | `memory/memory.service.ts`、`memory-gateway.ts` |
| 异步进化任务（BullMQ/Redis） | `modules/evolution/` |

## 已知债务（详见根 ARCHITECTURE.md）

- Storage 双写（graph JSONL + legacy facts）无真事务（#439）
- `stubs.router.ts` 为纯占位（#440）
- Polling 仍是 worker 完成路径的默认方式（#449）
- 包级测试面：`tests/{unit,integration,e2e}`，见 `package.json` scripts
