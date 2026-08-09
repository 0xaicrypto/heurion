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
| `contracts` | **Single source of truth**: render-content schemas (zod), SSE chat event union, wire message shapes, retrieval tool names (#438) |
| `server-ts` | Control plane: chat pipeline, tools (BaseTool + registry), plugins (catalog/install/capability/audit), memory (graph/facts/proposals), files, execution-plane client |
| `worker` | Execution plane: document/office rendering (docx/pptx/pdf/table/plot), job store (persistent JSONL, #446), honest download URLs (#447), completion webhook (#449) |
| `python-stats-worker` | Authoritative statistics (scipy/statsmodels/lifelines) behind the `StatsEngine` strategy (#445) |
| `embedding-server` | Local ONNX embeddings (bge-m3 default, #442) |
| `web` | React frontend: zustand stores, SSE via shared parser (#457), ChatMessages component shared by all chat surfaces (#456), composed ApiClient (#458) |
| `sdk-client` | Typed client surface shared with the web app |

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
