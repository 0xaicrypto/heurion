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
- **Projects relevant context** — three-layer attention decay ensures the right information is available
- **Accumulates clinical expertise** — facts, episodes, and skills version controlled and auditable

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
- Worker implementation: `packages/server/heurion_worker/`
- System templates: `packages/server/heurion_worker/templates/`
- Render API: `POST /api/v1/execution/render` · Job status: `GET /api/v1/execution/jobs/:id` · Download: `GET /api/v1/execution/files/:fileId/download`

---

## Evolution Pipeline

Every conversation flows through a 6-stage loop:

```
  ┌──────────────────────────────────────────┐
  │                                          │
  ▼                                          │
1. INGEST  ──  Append to immutable event log │
2. EXTRACT ──  LLM extracts facts & insights │
3. GRAPH   ──  Accumulate clinical findings  │
4. DISTILL ──  Cross-patient patterns        │
5. EVOLVE  ──  Autonomous self-improvement   │
6. RETRIEVE ── Weighted attention projection │
  │                                          │
  └─────────── Feed back to next turn ───────┘
```

**Weighted attention**: recent interactions get full detail; older ones are
compressed into summaries; facts are ranked by importance × recency decay.

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
| **Core SDK** | `packages/sdk` + `packages/nexus` | Python | DigitalTwin, on-chain identity, event sourcing |

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
| GET | `/api/v1/memory/export` | Memory |
| POST | `/api/v1/execution/render` | Execution — enqueue Sidecar render job |
| GET | `/api/v1/execution/jobs/:id` | Execution — poll job status |
| GET | `/api/v1/execution/files/:fileId/download` | Execution — get presigned file URL |

---


## Knowledge Base

The self-evolving knowledge pipeline (P0–P10) enables Heurion to build a
personal knowledge base and clinical memory from every interaction.

### Pipeline

| Phase | Component | Purpose |
|-------|-----------|---------|
| P0 | File Dedup + FactsStore | SHA-256 files; fact-level deduplication |
| P1 | KnowledgeStore | Activate entries; track stale/inactive knowledge |
| P2 | Dynamic Persona | Inject file context + accumulated facts into chat |
| P3 | Query Router | Rule-first classifier — route queries to best source |
| P4 | Context Compressor | 3-level pipeline (extract → rank → truncate) |
| P5 | Graph Extractor | Dual-track entity extraction (NLP + LLM) |
| P6 | Semantic Search | TF-IDF vector search across knowledge base |
| P7 | RRF Fusion | Reciprocal rank fusion across multiple sources |
| P8 | Knowledge Cascade | Stale marking + propagation across entries |
| P9 | Knowledge Gap | Queue unanswered questions as Pending Facts |
| P10 | ToolStore | Auto-create tools from accumulated knowledge patterns |

### Cost-controlled retrieval (P3)

To keep inference costs low, the Query Router uses a **rule-first, LLM-fallback**
strategy:

- **Rule layer** (`< 5ms`, zero LLM cost): keyword/pattern routing for factual,
  file, and guideline queries.
- **LLM layer**: only for ambiguous or mixed-intent questions; uses a cheap
  classifier model.
- **Source whitelist**: each route opens only the sources it needs, avoiding the
  expensive "dump everything into context" approach.

This usually *reduces* average per-turn cost because fewer tokens are injected
into the LLM context.

### Explicit knowledge commands

Users can trigger knowledge-base operations directly from chat. These commands
are **opt-in** and do not increase baseline conversation cost:

| Command | Example | Behavior |
|---------|---------|----------|
| `kb_search` | "搜索我的知识库关于 NSCLC" | Semantic search across Knowledge + Facts |
| `kb_remember` | "记住：ZQ 对 osimertinib 不耐受" | Extract and save a fact immediately |
| `kb_summarize` | "根据我的知识库总结 EGFR 经验" | Retrieve relevant facts and synthesize |
| `kb_gaps` | "查看我的未解问题" | List auto-detected Knowledge Gaps |
| `kb_resolve_gap` | "回答这个 gap" | Convert a user answer into a fact |

### Knowledge Gap UI

Knowledge Gaps are user-visible "unanswered questions" automatically detected
from chat or marked by the user. They surface in:

- **Today Dashboard**: a quick list of open gaps with answer/ignore actions.
- **Knowledge → Gaps tab**: full gap management page.
- **Chat**: inline prompts when a new gap is detected.

Making gaps visible turns passive memory accumulation into an active,
user-guided evolution loop.

### Sidecar output feedback

MedSci-Sidecar reports can contain high-value clinical findings, but they are
**not automatically extracted** into the knowledge base. Instead:

- The user can say "save this to the knowledge base" in chat.
- The UI can offer a ☑️ "Save key findings" checkbox after a Sidecar run.
- Only user-authorized outputs are run through the fact extractor.

This keeps Sidecar execution costs predictable and avoids noisy auto-ingestion.

API: `GET /api/v1/knowledge`, `GET /api/v1/facts`, `POST /api/v1/facts`,
`GET /api/v1/knowledge/gaps`

Design: [`docs/design/knowledge-base-design.md`](docs/design/knowledge-base-design.md)  
Tests: [`docs/design/KB_EVOLUTION_TESTS.md`](docs/design/KB_EVOLUTION_TESTS.md)

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
| **Control Plane** | Main API, Web UI, SQLite DB, Plugin Manager, Job Queue | 2 vCPU / 4 GB RAM |
| **Execution Plane** | Plugin Worker, Sandbox, MedSci-Sidecar | 2 vCPU / 4 GB RAM (horizontally scalable) |

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
- **加权注意力投影** — 三层衰减确保正确信息在上下文中
- **积累临床经验** — 事实、会话和技能均版本化管理、可审计

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

## 进化回路

每次对话走完整六步闭环：

1. **INGEST** — 事件追加到不可变日志
2. **EXTRACT** — LLM 提取事实和洞察  
3. **GRAPH** — 积累患者临床数据
4. **DISTILL** — 跨患者模式蒸馏
5. **EVOLVE** — 自主自我改进
6. **RETRIEVE** — 加权注意力上下文投影，输入下一轮对话

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
| GET | `/api/v1/memory/export` | 记忆 |
| POST | `/api/v1/execution/render` | 执行 — 入队 Sidecar 渲染任务 |
| GET | `/api/v1/execution/jobs/:id` | 执行 — 查询任务状态 |
| GET | `/api/v1/execution/files/:fileId/download` | 执行 — 获取文件预签名下载链接 |

---

## 知识库

自进化知识管线 (P0–P10) 从每次交互中积累个人知识库：

| 阶段 | 组件 | 用途 |
|------|------|------|
| P0 | 文件去重 + FactsStore | SHA-256 文件去重 + 事实级去重 |
| P1 | KnowledgeStore | 激活记录；追踪陈旧/不活跃知识 |
| P2 | 动态 Persona | 将文件上下文 + 已积累事实注入对话 |
| P3 | Query Router | 规则分类器 — 将查询路由到最佳数据源 |
| P4 | Context Compressor | 三级压缩管线 (提取 → 排序 → 截断) |
| P5 | Graph Extractor | 双轨实体提取 (NLP + LLM) |
| P6 | Semantic Search | TF-IDF 向量搜索知识库 |
| P7 | RRF Fusion | 多源倒数排序融合 |
| P8 | Knowledge Cascade | 陈旧标记 + 级联传播 |
| P9 | Knowledge Gap | 未解问题排队为 Pending Facts |
| P10 | ToolStore | 从知识模式自动创建工具 |

API: `GET /api/v1/knowledge`, `GET /api/v1/facts`, `POST /api/v1/facts`

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
