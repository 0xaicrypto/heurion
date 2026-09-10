# Heurion Architecture

> #443 — rewritten for the TypeScript era. The Python-era architecture
> (packages/server, SDK, relay, desktop-v2) was removed in 2026-07.

## Services

```
web (React/Vite, :5173) ──HTTP/SSE──▶ server-ts (:8001)   control plane
server-ts ──HTTP(x-worker-token)──▶ worker (:8002)        execution plane
server-ts ──HTTP──▶ embedding-server (:8003)              local ONNX embeddings
server-ts ──HTTP──▶ python-stats-worker (:8005)           scipy statistics (#445)
server-ts ──BullMQ/Redis──▶ evolution worker              memory evolution
server-ts ──Prisma──▶ SQLite                               relational state
server-ts ──files──▶ TWIN_BASE_DIR/{user}/                 facts/graph/embeddings/events
worker ──S3/MinIO──▶ rendered files                        presigned URLs (#447)
```

## Packages

| Package | Role |
|---|---|
| `contracts` | **Single source of truth**: render-content schemas (zod), SSE chat event union, wire message shapes (incl. `UserProfile`, #668), retrieval tool names (#438) |
| `server-ts` | Control plane: chat pipeline, tools (BaseTool + registry), plugins (catalog/install/capability/audit), memory (graph/facts/proposals), files, execution-plane client |
| `worker` | Execution plane: document/office rendering (docx/pptx/pdf/table/plot), job store (persistent JSONL, #446), honest download URLs (#447), completion webhook (#449) |
| `python-stats-worker` | Authoritative statistics (scipy/statsmodels/lifelines) behind the `StatsEngine` strategy (#445) |
| `embedding-server` | Local ONNX embeddings (bge-m3 default, #442) |
| `web` | React frontend: zustand stores, SSE via shared parser (#457), ChatMessages component shared by all chat surfaces (#456), composed ApiClient (#458). Shared wire types come from `contracts` (#668) |

## server-ts 分层与依赖规则 (#672)

```
common/  core/          leaf — zero imports from modules/tools/memory/retrieval
   │
memory/  retrieval/    cross-cutting domains — may import common/core, never modules/*
   │
tools/                 may import common/core/memory/retrieval, never modules/*
   │                     (plugin ports injected via ToolContext — #666)
   ▼
modules/*              may import common/core/memory/retrieval/tools;
                       peers may cross-import ONLY in one direction where the
                       orchestrator needs it (chat → knowledge, #666) — keep the
                       cross-module edge list to a minimum and documented
```

Enforcement so far (manual greps, #666/#672):
- `common/` → zero imports from `modules/`, `tools/`, `memory/`, `retrieval/`
- `tools/` → zero imports from `modules/` (port injection: `isPluginInstalled` /
  `getPluginConfig` in `ToolContext`; pure crypto in `common/chart-token.ts` +
  `common/settings-encryption.ts`)
- `memory/` → zero imports from `modules/*` (side effects inverted via the
  registry hooks in `memory/registry.ts`: context resolver, proposal applier,
  proposal-created handler)
- **`modules/shared/`（#679 上提的事实共享层）**: `user-context.ts` /
  `chat-context.ts` / `chat.dto.ts` / `chat-orchestrator.ts` — 被
  auth/approvals/knowledge/memorization/patients/skills/files/documents 等
  8+ 模块消费,任何模块可直接 import shared;shared 自身仅依赖
  core/common/memory 与 knowledge/approvals 的 service 接口。
- `modules/*` → peer cross-imports are orchestration-heavy today (#679): the
  chat module is the hub. The only known import *cycle*
  (user-context ↔ approvals) was broken in #679 — approvals now resolves
  memory via `getContextResolver()` (registry) instead of importing the chat
  module. 剩余已声明边（机器可执行版 =
  `tests/unit/arch-layers.test.ts` 的 peerEdges,新增边必须先改表再改代码）:
  auth→chat, calendar→research, chat→knowledge/plugins/evolution/patients/
  execution/skills/figures (#913: 会话内技能激活/遵循度/捕捉建议, 动态 import;
  #939: figures 为 figure 渲染管线 port 注入, 动态 import),
  documents→chat/figures (#913: 文档图片扫描/渲染回填, 动态 import),
  evolution→chat/memorization/practitioner,
  external→plugins/execution, figures→execution (#820 学术渲染编排),
  files→ingestion/knowledge/execution/patients (#913: DICOM 快扫, 动态 import),
  ingestion→medical-records,
  medical-records→approvals/research (#913: 病历入库自动筛查入队, 动态 import),
  memorization→chat, patients→chat/research (#913: 患者入库自动筛查入队,
  动态 import),
  plugins→chat/execution, research→knowledge, skills→chat/knowledge
  (#841 环⑤: skills→knowledge 为 follow-through 复用 telemetry.service)
- Pure crypto/util helpers used by both tools and modules live in `common/`
  (never import a `.router.ts` for non-HTTP functions — #666)
- **leaf 层反向依赖（#939 修复）**: `common/persona.ts → memory/fact-provider`
  曾构成 common↔memory 真实循环（persona graph 投影已下移
  `memory/persona-source.ts`，persona 只收已渲染 PersonaSource）；
  `common/skill-node-migration` 已下移 `memory/`（user-context 依赖经
  registry 钩子反转）；`tools/insert-asset-export` 的 figures 依赖改为
  ToolContext 端口注入（#672 同款）。leaf→上层检测已入机读回归锁
  `tests/unit/arch-layers.test.ts`（#940）。

## 会话后提取器与触发时机 (#645)

| 提取器 | 触发 | 产物 |
|---|---|---|
| `memory/compaction/runner.ts` | 会话预算超限压缩、会话关闭 Tier-3 flush | facts 入库 |
| `modules/memorization/chat-ingester.service.ts` | 聊天回合后异步 | 记忆提案 |
| `modules/memorization/clinical-extractor.service.ts` | evolution worker 回合后 | 临床实体 |
| `modules/patients/clinical-analysis.ts` | 聊天回合内 | 病历更新 |
| `modules/practitioner/session-takeaway.service.ts` | 会话关闭 | 要点摘要 |
| `modules/knowledge/sidecar-feedback.service.ts` | sidecar 反馈 | 知识库文章 |

gap 检测仅存一处：`knowledge-gap.service.ts`（含 `detectFromChat`，纯逻辑在
`modules/knowledge/gap-detect.ts`）— 由 chat.orchestrator.postTurn 调用。

## Key designs

- **LLM**: single `LlmGateway` (Strategy + DIP, #436) — provider registry
  (deepseek/opencode/gemini/kimi/openai/anthropic) via `DEFAULT_LLM_PROVIDER`,
  unified retry/telemetry/pricing. `common/llm.ts` is a thin facade.
- **Tools**: `BaseTool` + `ToolRegistry` with versioning, output truncation,
  doom-loop guard, `<tool_call>` text protocol.
- **Plugins**: manifest → catalog → per-user install/enable/configure →
  intent matching (IntentRouter chain, #452) → payload with content
  guarantee (schema validation + retry + fallback, #451) → execution plane.
  Uninstall cascades audit log (#454).
- **Chat**: pipeline stages in chat-handler (routed/plugin/direct intents),
  shared context helpers (chat-context.ts, #437), SSE events from contracts.
- **Rendering**: render boundary documented in `docs/design/RENDER_BOUNDARY.md`
  (#450) — binary documents in the worker, deterministic SVG in server-ts.
- **Files**: `<img>`-friendly downloads via HMAC-signed stateless tokens
  (90-day default, survives restarts — #440), chart tokens issued by
  render_chart / render_scene.

## Config & ports

See `docs/design/CONFIG_AND_PORTS.md` (#441). Control plane owns 8001;
worker defaults to 8002; env is read lazily, never frozen at import time.

## Known debt (tracked)

- Storage dual-write (graph JSONL + legacy facts) has compensation-based
  atomicity (`commitGraphLast`) but no real transaction — #439 keeps
  derived indexes (embeddings) synced via `onNodeRemoved` hook.
- `stubs.router.ts` is now genuine stubs only (#440); real business
  endpoints live in knowledge-stores.router / report.router / files.router.
- Polling remains the default completion path; worker supports
  `callback_url` webhooks (#449).
