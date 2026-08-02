# Heurion

[![Deploy](https://github.com/0xaicrypto/heurion/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/0xaicrypto/heurion/actions/workflows/deploy-server.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-000000.svg?logo=fastify&logoColor=white)](https://fastify.dev/)
[![React](https://img.shields.io/badge/React-61DAFB.svg?logo=react&logoColor=black)](https://react.dev/)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek-4B6BFB.svg)](https://deepseek.com/)
[![Status](https://img.shields.io/badge/status-active-blue.svg)](ROADMAP.md)

> **An AI for clinical research should accumulate, not reset.**
> *Runtime is temporary. Evolution is eternal.*

---

## What is Heurion?

Heurion is a **self-evolving clinical AI workstation** for oncology researchers.
It combines persistent agent memory, weighted-attention context projection, and
typed SDK to create an AI that grows smarter with every interaction.

Unlike stateless chatbots, Heurion's agent:
- **Remembers** across sessions — every conversation builds accumulated knowledge
- **Evolves** autonomously — automatically extracts facts, preferences, and insights
- **Projects relevant context** — semantic retrieval + graph traversal inject only the most relevant memory
- **Accumulates clinical expertise** — facts, articles, and skills are versioned, auditable, and exportable
- **Propagates changes** — editing or deleting a fact automatically marks dependent knowledge as stale

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Client Layer                              │
├─────────────────────────────────────────────────────────────────────┤
│   Web UI (packages/web)                                             │
│   React + Vite + Tailwind + i18n (zh-CN/en), light/dark mode        │
├─────────────────────────────────────────────────────────────────────┤
│   @heurion/sdk (packages/sdk-client)                                │
│   Typed client — browser + CLI ready                                │
│   AsyncGenerator-based SSE streaming                                │
└──────────────────────────────────┬──────────────────────────────────┘
                                    │ HTTPS / SSE
┌──────────────────────────────────▼──────────────────────────────────┐
│                       Control Plane (Production VPS)                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Server (TS) — packages/server-ts                             │  │
│  │   Fastify + Prisma + SQLite                                    │  │
│  │   Auth, Chat SSE, Research, Docs, Skills, Admin, Plugin Mgmt   │  │
│  │   Enqueues Sidecar jobs, proxies file downloads                │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Embedding Server (Python) — nexus_server.embedding_server    │  │
│  │   Local bge-m3 (1024-dim) + OpenAI fallback                    │  │
│  │   Powers GraphRAG / semantic retrieval                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────┘
                                    │ enqueue job (Redis)
┌──────────────────────────────────▼──────────────────────────────────┐
│                      Execution Plane (Sandbox VPS)                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Worker Image (packages/server + Dockerfile.worker)           │  │
│  │   FastAPI + Redis consumer + heurion_worker package            │  │
│  │   ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │  │
│  │   │ Connector   │ │ Execution   │ │ UI Plugin               │ │  │
│  │   │ (Slack...)  │ │ (MedSci-   │ │ (React dynamic load)    │ │  │
│  │   │             │ │  Sidecar...)│ │                         │ │  │
│  │   └─────────────┘ └──────┬──────┘ └─────────────────────────┘ │  │
│  │                          │ upload output                       │  │
│  └──────────────────────────┼────────────────────────────────────┘  │
│                             │                                         │
│  ┌──────────────────────────▼────────────────────────────────────┐  │
│  │   Object Storage (S3 / DigitalOcean Spaces / MinIO)            │  │
│  │   Generated DOCX/PPTX/PNG, tenant-isolated                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Why separate the Execution Plane?

- **Security**: plugin code and document rendering run in a restricted sandbox; a compromised plugin cannot access the main production database.
- **Resource isolation**: rendering PPTX / PDF / plots can spike CPU and memory; the main API server stays responsive.
- **Compliance**: egress, PHI access, and code execution are auditable on a dedicated worker host.
- **Scalability**: worker nodes can scale independently based on queue depth.

### Plugin & Sidecar Architecture

Heurion now has two extension mechanisms:

- **Skills Market**: prompt-based abilities injected into the system prompt (existing).
- **Plugin Market**: runtime plugins that register tools, connectors, and UI extensions.

The first official plugin is **MedSci-Sidecar** — it generates DOCX, PPTX, tables, and plots from templates and structured data. Jobs are enqueued on Redis, rendered in the Execution Plane, and uploaded to tenant-isolated object storage.

- [`docs/design/PLUGIN_MARKETPLACE.md`](docs/design/PLUGIN_MARKETPLACE.md)
- [`docs/design/PLUGIN_MANIFEST_SPEC.md`](docs/design/PLUGIN_MANIFEST_SPEC.md)
- [`docs/design/MEDSCI_SIDECAR.md`](docs/design/MEDSCI_SIDECAR.md)
- Memory lifecycle (context, extraction, compaction, approval): [`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md)
- Worker implementation: `packages/server/heurion_worker/`
- System templates: `packages/server/heurion_worker/templates/`
- Render API: `POST /api/v1/execution/render` · Job status: `GET /api/v1/execution/jobs/:id` · Download: `GET /api/v1/execution/files/:fileId/download`

---

## Evolution & Knowledge Base

Heurion is a self-evolving clinical AI. Every interaction is ingested as an
immutable event, projected into a unified **Memory Graph**, and asynchronously
distilled into facts, articles, and gaps by the **Evolution Engine**.

### Memory Graph: one model for all memory

All memory entities live in a single graph:

| Node type | What it is | Example |
|---|---|---|
| **Fact** | Structured snippet with importance, confidence, and source | "ZQ is intolerant to osimertinib" |
| **Article** | Synthesized knowledge linked to source fact versions | "ZQ's EGFR treatment experience" |
| **Gap** | Unanswered question waiting for a fact/article answer | "Best first-line for EGFR ex20ins?" |
| **Skill** | Learned strategy for recurring tasks | "This doctor checks CT before treatment" |
| **Entity** | Canonical patient/medication/biomarker/study concept | "Osimertinib" |
| **Document** | Uploaded file with extracted fact provenance | "CT_7-15.pdf" |

Relations connect them: `derives_from`, `depends_on`, `answers`, `mentions`,
`supersedes`, `related_to`.

### EventLog is the source of truth

All memory writes flow through:

```
Runtime handlers  →  MemoryService  →  EventLog.append()
                                          ↓
                                Memory Graph (projection)
                                          ↓
                              Evolution Engine (async)
```

- The EventLog is append-only and migration-immutable.
- The Memory Graph is a projection that can be rebuilt from the EventLog.
- User edits, imports, and system extractions are all events.

### Versioning & curation

Facts and articles are versioned:

- Editing a fact creates **v2**; v1 is kept with `status='superseded'` and a
  `supersedes` relation.
- Articles record the exact fact versions they were generated from.
- When a fact is edited or deleted, dependent articles are automatically marked
  `stale` with `staleBecause`.
- Deleting a document superseded facts derived from it; articles depending on
  those facts become stale.

This makes the knowledge base auditable and self-correcting.

### Asynchronous Evolution Engine

The Evolution Engine runs outside the chat hot path (BullMQ + Redis, with an
in-memory fallback):

1. **Extract** — LLM extracts facts from chat turns and documents.
2. **Deduplicate & Link** — merges duplicates and links facts to
   documents/entities.
3. **Auto-resolve gaps** — checks whether a new fact answers an open gap.
4. **Synthesize** — when enough related facts accumulate, generates an article.
5. **Curate** — propagates user edits and deletions to dependents.

Benefits: retries, dead-letter queues, independent scaling, and no blocking chat
latency.

### Semantic retrieval

For accumulated-memory queries, retrieval is now hybrid:

1. **Query Router** decides intent (`sql`, `vector`, `graph`,
   `knowledge_command`, `mixed`).
2. **Embedding recall** retrieves top-K facts/articles/gaps.
3. **Graph expansion** follows 1–2 hops of relations.
4. **RRF rerank** fuses semantic and graph signals.
5. **Context compressor** truncates to the token budget.

Embedding is currently provided by DeepSeek embedding, with `contentHash`
caching and batching to keep costs low.

### Heurion Memory Archive (.hma)

Users can export and import their entire memory:

- `.hma` is a self-contained ZIP/TAR with EventLog, Memory Graph, projections,
  and files.
- Export: `POST /api/v1/memory/export`
- Import: `POST /api/v1/memory/import` with `mode=merge` or `mode=replace`
- UI located in **Settings → Data**.

### Memory API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/memory/export` | Start memory export job |
| GET | `/api/v1/memory/export/:jobId` | Export progress / download |
| POST | `/api/v1/memory/import` | Start memory import job |
| GET | `/api/v1/memory/import/:jobId` | Import report |
| GET | `/api/v1/memory/nodes/:id/versions` | Version history |
| GET | `/api/v1/memory/articles/:id/impact` | Downstream fact impact |
| POST | `/api/v1/memory/articles/:id/regenerate` | Regenerate stale article |
| POST | `/api/v1/memory/curation/replay` | Replay EventLog (admin) |

Design: [`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md)  
Tests: [`docs/design/KB_EVOLUTION_TESTS.md`](docs/design/KB_EVOLUTION_TESTS.md)

---

## Quickstart

```bash
# Terminal 1 — Control Plane (TypeScript backend)
cd packages/server-ts
cp .env.example .env
# Edit .env: set DEEPSEEK_API_KEY and, if you have a worker, EXECUTION_PLANE_URL.
npx prisma db push
npx tsx src/main.ts
# → http://localhost:8001

# Terminal 2 — Web UI
cd packages/web
pnpm install
pnpm exec vite --host
# → http://localhost:5173

# Optional Terminal 3 — Execution Plane (Sidecar worker) on a separate port
# Requires Redis and S3-compatible object storage (e.g. DigitalOcean Spaces).
cd packages/server
cp .env.example .env
# Edit .env: set REDIS_URL, WORKER_API_TOKEN, S3_*.
uvicorn nexus_server.main:create_app --host 0.0.0.0 --port 8002 --factory
# In another process:
# REDIS_URL=redis://localhost:6379/0 python -m heurion_worker.consumer
```

---

## Module Map

| Layer | Package | Stack | Responsibility |
|-------|---------|-------|----------------|
| **Web UI** | `packages/web` | React 18 + Vite 5 + Tailwind | Browser app, i18n (zh-CN/en), dark mode |
| **SDK** | `packages/sdk-client` | TypeScript | Typed client for browser/CLI |
| **Control Plane** | `packages/server-ts` | Fastify 4 + Prisma 5 + SQLite | Auth, Chat SSE, Research, Docs, Skills, Admin, Plugin/Execution mgmt |
| **Execution Plane** | `packages/server` | FastAPI + Python | DICOM/inference worker, MedSci-Sidecar rendering, Redis consumer |
| **Core SDK** | `packages/sdk` + `packages/nexus` | Python | DigitalTwin, identity, event sourcing |

### Control Plane modules (10+ feature domains)

```
modules/
├── auth/          Register, login, JWT, profile
├── chat/          SSE streaming (DeepSeek), sessions, context projection
├── patients/      Patient CRUD, DICOM, memory graph
├── research/      Studies, roster, eligibility, safety analysis
├── documents/     Writing studio, AI polish, PHI scanner
├── skills/        Skill marketplace with pagination
├── settings/      LLM provider configuration
├── files/         Upload, clipboard paste support
├── admin/         User management
├── execution/     Sidecar job enqueue/status/download proxy
└── stubs/         Fallback endpoints

memory/            Unified Memory Graph, versioning, curation, archive export/import
evolution/         Async BullMQ worker + queue metrics; extract/synthesize/gap stages
```

### Execution Plane (`packages/server/heurion_worker/`)

```
heurion_worker/
├── consumer.py    Redis job consumer
├── sidecar.py     DOCX/PPTX/table/plot renderers
├── storage.py     S3/Spaces upload + presigned download URLs
└── templates/     Bundled system templates (DOCX/PPTX)
```

### SDK modules (10 typed clients)

```
heurion.auth.login(username, password)
heurion.chat.sendMessage({ text })    → AsyncGenerator<SSE chunks>
heurion.patients.list()
heurion.research.createStudy(name, code)
heurion.documents.create(title)
heurion.skills.search(query, source)
heurion.settings.getLlmStatus()
heurion.files.upload(file)
heurion.admin.listUsers()
heurion.memory.getProjection(patientHash)
heurion.memory.export(options)
heurion.memory.import(file, mode)
heurion.memory.getNodeVersions(nodeId)
heurion.memory.regenerateArticle(articleId)
```

---

## SDK Usage

```typescript
import { HeurionClient, memoryStore } from '@heurion/sdk'

const h = new HeurionClient({
  baseUrl: 'http://localhost:8001',
  tokenStore: memoryStore,  // localStorage for browser, file for CLI
})

await h.auth.login('doctor', 'password')

// SSE streaming chat
for await (const chunk of h.chat.sendMessage({ text: 'analyze the case' })) {
  if (chunk.type === 'final_answer_chunk') console.log(chunk.text)
}
```

---

## API

All responses use `snake_case` field names. Key endpoints:

| Method | Path | Module |
|--------|------|--------|
| POST | `/api/v1/auth/login` | Auth |
| POST | `/api/v1/agent/chat` | Chat (SSE) |
| GET | `/api/v1/dicom/patients/full` | Patients |
| POST | `/api/v1/research/studies` | Research |
| GET | `/api/v1/docs` | Documents |
| GET | `/api/v1/skills/search?source=all&page=1` | Skills |
| GET | `/api/v1/admin/users` | Admin |
| GET | `/api/v1/memory/export` | Memory — start export job |
| POST | `/api/v1/memory/import` | Memory — start import job (merge/replace) |
| GET | `/api/v1/memory/nodes/:id/versions` | Memory — version history |
| GET | `/api/v1/memory/articles/:id/impact` | Memory — downstream impact |
| POST | `/api/v1/memory/articles/:id/regenerate` | Memory — regenerate stale article |
| POST | `/api/v1/execution/render` | Execution — enqueue Sidecar render job |
| GET | `/api/v1/execution/jobs/:id` | Execution — poll job status |
| GET | `/api/v1/execution/files/:fileId/download` | Execution — get presigned file URL |

---

## CI/CD Pipeline

Every push to `main` triggers:

```
TypeCheck → Unit Tests → Staging + Regression → Cloudflare SSL → Deploy Control Plane → Deploy Execution Plane
```

- **Staging gate**: deploys to `localhost:8002` on the Control Plane VPS, then runs
  **regression tests**. Production deploy is blocked on failure.
- **Two-plane deploy**: Control Plane (`packages/server-ts`) and Execution Plane
  (`Dockerfile.worker` built from `packages/server`) are deployed in sequence.
  The worker image is pushed to GHCR and rolled out via `docker-compose.worker.yml`.
- **Secrets**: CI secrets (`SERVER_SECRET`, `EXECUTION_PLANE_URL`, `WORKER_API_TOKEN`,
  `S3_*`, LLM keys) are transferred to each VPS via a temporary env file that is
  removed immediately after sourcing.
- **Playwright E2E**: browser tests simulating full user workflows
  (login → patient → chat → knowledge → settings → plugin tools).

---

## Test Plan

- **61 regression tests** — every API module, auth guard, edge case
- **30+ unit tests** — vitest for FactsStore, KnowledgeStore, query-router,
  context-compressor, graph-extractor, semantic-search, RRF-fusion
- **20+ E2E tests** — Playwright browser tests with CI integration

Run locally:
```bash
cd packages/server-ts
npx vitest run               # unit tests
npx playwright test          # E2E browser tests

# Worker-specific tests (no DB/conftest side effects):
PYTHONPATH=../server pytest ../server/tests_worker/test_heurion_worker.py

# Or via CI scripts:
bash scripts/regression-test.sh http://localhost:8002
```

---

## Deployment Topology

Production runs on at least two DigitalOcean Droplets (or equivalent VMs):

| Node | Role | Example spec |
|---|---|---|
| **Control Plane** | Main API, Web UI, SQLite DB, Plugin Manager, Job Queue, **local bge-m3 Embedding Server** | 2–4 vCPU / **8 GB RAM** (4 GB minimum with swap) |
| **Execution Plane** | Plugin Worker, Sandbox, MedSci-Sidecar | 2 vCPU / 4 GB RAM (horizontally scalable) |

The Control Plane runs the `nexus-embedding-server` container (or process) alongside
`nexus-server`. `bge-m3` needs ~2.2 GB disk and several gigabytes of RAM; budget
accordingly or point `EMBEDDING_SERVICE_URL` at an external embedding endpoint to
offload it.

The two planes communicate over a private network (VPC / WireGuard). The Execution Plane
is not exposed to the public internet; only the Control Plane can reach it on port `8001`.

```
Internet
   │
   ▼
┌──────────────┐     VPC / private network     ┌──────────────────┐
│   Nginx      │◄─────────────────────────────►│  Control Plane   │
│  (HTTPS)     │                               │  :8001 main API  │
└──────┬───────┘                               │  Plugin Manager  │
       │                                       │  Job Queue       │
       ▼                                       └────────┬─────────┘
┌──────────────┐                                        │ enqueue
│   Web UI     │                                        │
└──────────────┘                                        ▼
                                               ┌──────────────────┐
                                               │  Execution Plane │
                                               │  :8001 worker    │
                                               │  sandbox plugins │
                                               └──────────────────┘
```

---

## Secret Management

- **CI**: GitHub Actions secrets (`SERVER_SECRET`, `EXECUTION_PLANE_URL`,
  `WORKER_API_TOKEN`, `S3_*`, LLM keys, SSH keys).
- **VPS runtime**: each deploy writes a per-service `.env` file on the host
  (`packages/server-ts/.env` for Control Plane, `/root/heurion/.env` for the worker).
  These files are host-only and never committed.
- **Worker stack**: Docker Compose mounts secrets under `/run/secrets/` for
  `SERVER_SECRET`, LLM keys, and plugin tokens.
- **Future**: migrate to DigitalOcean App Platform Secrets or HashiCorp Vault
  without changing the service interfaces.

---

## References

- AHE: *Active Handover Evaluation for self-evolving agents* — arXiv:2604.25850
- RLM: *Recursive Language Models* — arXiv:2512.24601
- ABC: *Agent Behaviour Contract* — arXiv:2602.22302

---

<br>
<hr>
<br>

# Heurion 中文说明

## 什么是 Heurion？

Heurion 是一个面向肿瘤研究者的**自我进化型临床 AI 工作站**。
它结合了持久化智能体记忆、加权注意力上下文投影和类型化 SDK，
让 AI 随着每一次交互变得更智能。

与传统无状态聊天机器人不同，Heurion 的智能体：
- **跨会话记忆** — 每次对话都积累知识
- **自主进化** — 自动提取事实、偏好和洞察
- **语义 + 图检索** — 只把最相关的记忆注入上下文
- **积累临床经验** — 事实、文章和技能均版本化管理、可审计、可导出
- **变化自动传播** — 编辑或删除 Fact 会自动标记依赖的知识为 stale

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                           客户端层                                   │
├─────────────────────────────────────────────────────────────────────┤
│   Web UI (packages/web)                                             │
│   React + Vite + Tailwind + i18n（中英文/明暗主题）                  │
├─────────────────────────────────────────────────────────────────────┤
│   @heurion/sdk (packages/sdk-client)                                │
│   类型化客户端 — 浏览器/CLI 通用                                    │
│   AsyncGenerator 流式 SSE                                           │
└──────────────────────────────────┬──────────────────────────────────┘
                                    │ HTTPS / SSE
┌──────────────────────────────────▼──────────────────────────────────┐
│                       控制面 (Production VPS)                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Server (TS) — packages/server-ts                             │  │
│  │   Fastify + Prisma + SQLite                                    │  │
│  │   认证、Chat SSE、研究、文档、技能、管理员、插件/执行管理      │  │
│  │   入队 Sidecar 任务、代理文件下载                              │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────┘
                                    │ 入队任务（Redis）
┌──────────────────────────────────▼──────────────────────────────────┐
│                       执行面 (Sandbox VPS)                          │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Worker 镜像（packages/server + Dockerfile.worker）            │  │
│  │   FastAPI + Redis 消费者 + heurion_worker 包                   │  │
│  │   ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │  │
│  │   │ Connector   │ │ Execution   │ │ UI Plugin               │ │  │
│  │   │ (Slack...)  │ │ (MedSci-   │ │ (React 动态加载)        │ │  │
│  │   │             │ │  Sidecar...)│ │                         │ │  │
│  │   └─────────────┘ └──────┬──────┘ └─────────────────────────┘ │  │
│  │                          │ 上传输出                           │  │
│  └──────────────────────────┼────────────────────────────────────┘  │
│                             │                                         │
│  ┌──────────────────────────▼────────────────────────────────────┐  │
│  │   对象存储（S3 / DigitalOcean Spaces / MinIO）                 │  │
│  │   生成的 DOCX/PPTX/PNG，按租户隔离                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 为什么执行面要独立？

- **安全**：插件代码和文档渲染在受限沙箱中运行；被攻破的插件无法访问主生产数据库。
- **资源隔离**：渲染 PPTX / PDF / 图表会突发占用 CPU 和内存；主 API 服务器保持响应。
- **合规**：出站网络、PHI 访问、代码执行都在独立 worker 主机上可审计。
- **可扩展**：worker 节点可按队列深度独立扩容。

### 插件与 Sidecar 架构

Heurion 现在有两种扩展机制：

- **Skills 市场**：基于 prompt 的能力，注入到 system prompt（已有）。
- **Plugin 市场**：运行时插件，可注册 tools、connectors 和 UI 扩展。

第一个官方插件是 **MedSci-Sidecar** —— 基于模板和结构化数据生成 DOCX、PPTX、表格和图表。任务通过 Redis 入队，在执行面渲染，并上传到按租户隔离的对象存储。

- [`docs/design/PLUGIN_MARKETPLACE.md`](docs/design/PLUGIN_MARKETPLACE.md)
- [`docs/design/PLUGIN_MANIFEST_SPEC.md`](docs/design/PLUGIN_MANIFEST_SPEC.md)
- [`docs/design/MEDSCI_SIDECAR.md`](docs/design/MEDSCI_SIDECAR.md)
- 工作器实现：`packages/server/heurion_worker/`
- 系统模板：`packages/server/heurion_worker/templates/`
- 渲染 API：`POST /api/v1/execution/render` · 任务状态：`GET /api/v1/execution/jobs/:id` · 下载：`GET /api/v1/execution/files/:fileId/download`

---

## 进化与知识库

Heurion 是一个自进化的临床 AI。每一次交互都会被摄取为不可变事件，投影到统一的 **Memory Graph**，再由 **Evolution Engine** 异步提炼为 Facts、Articles 与 Gaps。

### Memory Graph：统一的记忆模型

所有记忆实体都存在于同一张图：

| 节点类型 | 说明 | 示例 |
|---|---|---|
| **Fact** | 带重要性、置信度与来源的结构化片段 | “ZQ 对 osimertinib 不耐受” |
| **Article** | 链接到来源 Fact 版本的综述 | “ZQ 的 EGFR 治疗经验” |
| **Gap** | 等待 Fact/Article 回答的未解问题 | “EGFR ex20ins 最佳一线方案？” |
| **Skill** | 对重复任务习得的策略 | “该医生习惯先看 CT 再谈方案” |
| **Entity** | 患者/药物/生物标志物/研究等规范概念 | “Osimertinib” |
| **Document** | 上传文件及其提取出的 Fact 来源 | “CT_7-15.pdf” |

关系：`derives_from`、`depends_on`、`answers`、`mentions`、`supersedes`、`related_to`。

### EventLog 是唯一真相源

所有记忆写入都经过：

```
运行时处理器 → MemoryService → EventLog.append()
                                      ↓
                            Memory Graph（投影）
                                      ↓
                          Evolution Engine（异步）
```

- EventLog 只追加、不可变。
- Memory Graph 是可以从 EventLog 重建的投影。
- 用户编辑、导入、系统提取都是事件。

### 版本化与级联传播

Fact 与 Article 均支持版本：

- 编辑 Fact 会生成 **v2**，v1 保留为 `superseded`，并建立 `supersedes` 关系。
- Article 记录生成时所依赖的 Fact 版本快照。
- 当 Fact 被编辑或删除时，依赖它的 Article 自动标记为 `stale`，并记录 `staleBecause`。
- 删除 Document 会使从它提取的 Fact 被 `superseded`，进而使相关 Article stale。

这让知识库可审计、可自愈。

### 异步 Evolution Engine

进化逻辑从聊天热路径中解耦，运行在 BullMQ + Redis 队列上（本地无 Redis 时回退到同进程）：

1. **Extract** — 从聊天轮次与文件中提取 Fact。
2. **Deduplicate & Link** — 合并重复项，链接 Document/Entity。
3. **Auto-resolve gaps** — 检查新 Fact 是否回答了某个 Open Gap。
4. **Synthesize** — 相关 Fact 足够多时生成 Article。
5. **Curate** — 将用户的编辑/删除传播到依赖项。

好处：支持重试、死信队列、独立扩缩容，且不阻塞聊天响应。

### 语义检索

针对需要引用记忆的问题，检索改为混合式：

1. **Query Router** 判定意图：`sql`、`vector`、`graph`、`knowledge_command`、`mixed`。
2. **Embedding 召回** 取 Top-K Facts/Articles/Gaps。
3. **图扩展** 沿关系走 1–2 跳。
4. **RRF 重排** 融合语义与图信号。
5. **Context Compressor** 截断到 token 预算。

Embedding 当前由 DeepSeek embedding 提供，并通过 `contentHash` 缓存与批量调用控制成本。

### Heurion Memory Archive（.hma）

用户可以整体导出/导入记忆：

- `.hma` 是自包含的 ZIP/TAR，含 EventLog、Memory Graph、投影表与原始文件。
- 导出：`POST /api/v1/memory/export`
- 导入：`POST /api/v1/memory/import`，支持 `mode=merge` 或 `mode=replace`
- UI 入口：**设置 → 数据**。

### 记忆 API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/memory/export` | 发起导出任务 |
| GET | `/api/v1/memory/export/:jobId` | 查询进度/下载 |
| POST | `/api/v1/memory/import` | 发起导入任务 |
| GET | `/api/v1/memory/import/:jobId` | 导入报告 |
| GET | `/api/v1/memory/nodes/:id/versions` | 节点版本历史 |
| GET | `/api/v1/memory/articles/:id/impact` | 下游影响分析 |
| POST | `/api/v1/memory/articles/:id/regenerate` | 重新生成 stale article |
| POST | `/api/v1/memory/curation/replay` | 重放 EventLog（管理员） |

设计文档：[`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md)  
测试文档：[`docs/design/KB_EVOLUTION_TESTS.md`](docs/design/KB_EVOLUTION_TESTS.md)

---

## 快速开始

```bash
# Terminal 1 — 控制面（TypeScript 后端）
cd packages/server-ts
cp .env.example .env
# 编辑 .env：设置 DEEPSEEK_API_KEY；如有 worker，再设置 EXECUTION_PLANE_URL。
npx prisma db push
npx tsx src/main.ts

# Terminal 2 — Web 前端
cd packages/web
pnpm install
pnpm exec vite --host

# 可选 Terminal 3 — 执行面（Sidecar worker），跑在另一个端口
# 需要 Redis 和 S3 兼容对象存储（如 DigitalOcean Spaces）。
cd packages/server
cp .env.example .env
# 编辑 .env：设置 REDIS_URL、WORKER_API_TOKEN、S3_*。
uvicorn nexus_server.main:create_app --host 0.0.0.0 --port 8002 --factory
# 另一个进程启动消费者：
# REDIS_URL=redis://localhost:6379/0 python -m heurion_worker.consumer
```

---

## SDK 用法

```typescript
import { HeurionClient, memoryStore } from '@heurion/sdk'

const h = new HeurionClient({
  baseUrl: 'http://localhost:8001',
  tokenStore: memoryStore,
})

await h.auth.login('doctor', 'password')

for await (const chunk of h.chat.sendMessage({ text: '分析这个病例' })) {
  if (chunk.type === 'final_answer_chunk') console.log(chunk.text)
}
```

---

## API 速查

所有响应字段均为 `snake_case`。常用接口：

| 方法 | 路径 | 模块 |
|------|------|------|
| POST | `/api/v1/auth/login` | 认证 |
| POST | `/api/v1/agent/chat` | 聊天（SSE） |
| GET | `/api/v1/dicom/patients/full` | 患者 |
| POST | `/api/v1/research/studies` | 研究 |
| GET | `/api/v1/docs` | 文档 |
| GET | `/api/v1/skills/search?source=all&page=1` | 技能 |
| GET | `/api/v1/admin/users` | 管理员 |
| GET | `/api/v1/memory/export` | 记忆 — 发起导出任务 |
| POST | `/api/v1/memory/import` | 记忆 — 发起导入任务（merge/replace） |
| GET | `/api/v1/memory/nodes/:id/versions` | 记忆 — 版本历史 |
| GET | `/api/v1/memory/articles/:id/impact` | 记忆 — 下游影响分析 |
| POST | `/api/v1/memory/articles/:id/regenerate` | 记忆 — 重新生成 stale article |
| POST | `/api/v1/execution/render` | 执行 — 入队 Sidecar 渲染任务 |
| GET | `/api/v1/execution/jobs/:id` | 执行 — 查询任务状态 |
| GET | `/api/v1/execution/files/:fileId/download` | 执行 — 获取文件预签名下载链接 |

---

## CI/CD 流水线

推送到 `main` 触发：类型检查 → 单元测试 → 预发 + 回归 → Cloudflare SSL → 部署控制面 → 部署执行面。

- **预发关口**: 部署到 Control Plane VPS 的 `localhost:8002`，运行回归测试，全部通过后方可部署生产环境。
- **双平面部署**: Control Plane（`packages/server-ts`）与 Execution Plane（`Dockerfile.worker` 构建自 `packages/server`）按顺序独立部署。worker 镜像推送到 GHCR，再通过 `docker-compose.worker.yml` 滚动更新。
- **Secrets**: CI secrets（`SERVER_SECRET`、`EXECUTION_PLANE_URL`、`WORKER_API_TOKEN`、`S3_*`、LLM keys）通过临时 env 文件传到各 VPS，source 后立即删除。
- **Playwright E2E**: 浏览器测试，模拟完整用户流程（登录 → 患者 → 聊天 → 知识库 → 设置 → 插件工具）。

---

## 部署拓扑

生产环境建议至少 **两台 DigitalOcean Droplets**（或等价 VM）：

| 节点 | 职责 | 示例规格 |
|---|---|---|
| **Control Plane** | 主 API、Web UI、数据库、Plugin Manager、Job Queue | 2 vCPU / 4 GB RAM |
| **Execution Plane** | Plugin Worker、Sandbox、MedSci-Sidecar | 2 vCPU / 4 GB RAM（可弹性扩容） |

两者通过内部网络（VPC / WireGuard）通信，Execution Plane **不直接暴露公网**。

```
Internet
   │
   ▼
┌──────────────┐     VPC / private network     ┌──────────────────┐
│   Nginx      │◄─────────────────────────────►│  Control Plane   │
│  (HTTPS)     │                               │  :8001 main API  │
└──────┬───────┘                               │  Plugin Manager  │
       │                                       │  Job Queue       │
       ▼                                       └────────┬─────────┘
┌──────────────┐                                        │ enqueue
│   Web UI     │                                        │
└──────────────┘                                        ▼
                                               ┌──────────────────┐
                                               │  Execution Plane │
                                               │  :8001 worker    │
                                               │  sandbox plugins │
                                               └──────────────────┘
```

## Secret 管理

- **CI**: GitHub Actions secrets（`SERVER_SECRET`、`EXECUTION_PLANE_URL`、`WORKER_API_TOKEN`、`S3_*`、LLM keys、SSH keys）。
- **VPS 运行时**: 每次部署在宿主机写入服务级 `.env` 文件（控制面为 `packages/server-ts/.env`，worker 为 `/root/heurion/.env`）。这些文件仅存在于宿主机，不进入仓库。
- **Worker stack**: Docker Compose 将 `SERVER_SECRET`、LLM keys、插件 token 以 secrets 形式挂载到 `/run/secrets/`。
- **未来**: 可迁移到 DigitalOcean App Platform Secrets 或 HashiCorp Vault，服务接口保持不变。

手动部署命令：

```bash
# Control Plane
ssh root@<control-vps-ip> "bash -s" < scripts/deploy.sh

# Execution Plane
ssh root@<worker-vps-ip> "cd ~/heurion && docker compose -f docker-compose.worker.yml pull && docker compose -f docker-compose.worker.yml up -d"
```

> `docker-compose.worker.yml` 是 Execution Plane 的独立编排文件，与 Control Plane 解耦。
