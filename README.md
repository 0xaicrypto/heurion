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
│   Typed client — 10 modules, browser + CLI ready                    │
│   AsyncGenerator-based SSE streaming                                │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ HTTPS / SSE
┌──────────────────────────────────┼──────────────────────────────────┐
│                       Control Plane (Production VPS)                │
│  ┌───────────────────────────────┴───────────────────────────────┐  │
│  │   Server (TS) — packages/server-ts                             │  │
│  │   Fastify + Prisma + SQLite                                    │  │
│  │   Auth, Chat SSE, Research, Docs, Skills, Admin, Plugin Mgmt   │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ enqueue job
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   Async Job Queue (Redis / RabbitMQ / SQLite queue)            │  │
│  │   - Plugin tool invocations                                    │  │
│  │   - Sidecar document rendering                                 │  │
│  │   - File format conversion                                     │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │ poll / push result
┌──────────────────────────────────▼──────────────────────────────────┐
│                      Execution Plane (Sandbox VPS)                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Plugin Worker Pool                                          │  │
│  │   ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │  │
│  │   │ Connector   │ │ Execution   │ │ UI Plugin               │ │  │
│  │   │ (Slack...)  │ │ (Sidecar...)│ │ (React dynamic load)    │ │  │
│  │   └─────────────┘ └─────────────┘ └─────────────────────────┘ │  │
│  │   - Docker containers / WASM runtime                          │  │
│  │   - Restricted network egress                                 │  │
│  │   - Per-tenant file system isolation                          │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ upload output
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   Object Storage (S3 / DigitalOcean Spaces / MinIO)           │  │
│  │   Generated files, tenant-isolated                            │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
├─────────────────────────────────────────────────────────────────────┤
│   Python Worker (packages/server)                                   │
│   FastAPI + pydicom + MONAI — DICOM parsing, inference, OCR,        │
│   clinical graph, vector search, event sourcing                     │
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

The first official plugin is **MedSci-Sidecar** — it generates DOCX, PPTX, tables, and plots from templates and structured data. See:

- [`docs/design/PLUGIN_MARKETPLACE.md`](docs/design/PLUGIN_MARKETPLACE.md)
- [`docs/design/PLUGIN_MANIFEST_SPEC.md`](docs/design/PLUGIN_MANIFEST_SPEC.md)
- [`docs/design/MEDSCI_SIDECAR.md`](docs/design/MEDSCI_SIDECAR.md)

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
# Terminal 1 — TypeScript backend
cd packages/server-ts
cp .env.example .env
npx prisma db push
npx tsx src/main.ts
# → http://localhost:8001

# Terminal 2 — Web UI
cd packages/web
pnpm install
pnpm exec vite --host
# → http://localhost:5173
```

---

## Module Map

| Layer | Package | Stack | Responsibility |
|-------|---------|-------|----------------|
| **Web UI** | `packages/web` | React 18 + Vite 5 + Tailwind | 25+ routes, i18n (zh-CN/en), dark mode |
| **SDK** | `packages/sdk-client` | TypeScript | 10 typed modules for browser/CLI |
| **Server** | `packages/server-ts` | Fastify 4 + Prisma 5 + SQLite | Auth, Chat SSE, Research, Docs, Skills, Admin |
| **Python** | `packages/server` + `sdk` | FastAPI + pydicom + MONAI | DICOM rendering, inference, event sourcing |

### Server modules (10 feature domains)

```
modules/
├── auth/          Register, login, JWT, profile
├── chat/          SSE streaming (DeepSeek), sessions, context projection
├── patients/      Patient CRUD, DICOM, memory graph
├── research/      Studies, roster, eligibility, safety analysis
├── documents/     Writing studio, AI polish, PHI scanner
├── skills/        28-skill marketplace with pagination
├── settings/      LLM provider configuration
├── files/         Upload, clipboard paste support
├── admin/         User management
└── stubs/         Fallback endpoints
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

---


## Knowledge Base

The self-evolving knowledge pipeline (P0–P10) enables Heurion to build a
personal knowledge base and clinical memory from every interaction:

| Phase | Component | Purpose |
|-------|-----------|---------|
| P0 | File Dedup + FactsStore | SHA-256 files; fact-level deduplication |
| P1 | KnowledgeStore | Activate entries; track stale/inactive knowledge |
| P2 | Dynamic Persona | Inject file context + accumulated facts into chat |
| P3 | Query Router | Rule-based classifier — route queries to best source |
| P4 | Context Compressor | 3-level pipeline (extract → rank → truncate) |
| P5 | Graph Extractor | Dual-track entity extraction (NLP + LLM) |
| P6 | Semantic Search | TF-IDF vector search across knowledge base |
| P7 | RRF Fusion | Reciprocal rank fusion across multiple sources |
| P8 | Knowledge Cascade | Stale marking + propagation across entries |
| P9 | Knowledge Gap | Queue unanswered questions as Pending Facts |
| P10 | ToolStore | Auto-create tools from accumulated knowledge patterns |

API: `GET /api/v1/knowledge`, `GET /api/v1/facts`, `POST /api/v1/facts`

---

## CI/CD Pipeline

Every push to `main` triggers:

```
TypeCheck → Unit Tests → Staging + Regression → Cloudflare SSL → Deploy
                    │                          │
                    └── 30+ vitest unit tests  └── Control Plane + Execution Plane
```

- **Staging gate**: deploys to `localhost:8002` on VPS, then runs
  **regression tests**. Production deploy blocked on failure.
- **Two-plane deploy**: Control Plane (main API) and Execution Plane (plugin/sandbox worker)
  are built and deployed independently. The Execution Plane image is rebuilt when
  `packages/plugin-worker` or plugin manifests change.
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

# Or via CI scripts:
bash scripts/regression-test.sh http://localhost:8002
```

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
│   类型化客户端 — 10 个模块，浏览器/CLI 通用                          │
│   AsyncGenerator 流式 SSE                                           │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ HTTPS / SSE
┌──────────────────────────────────┼──────────────────────────────────┐
│                       控制面 (Production VPS)                       │
│  ┌───────────────────────────────┴───────────────────────────────┐  │
│  │   Server (TS) — packages/server-ts                             │  │
│  │   Fastify + Prisma + SQLite                                    │  │
│  │   认证、Chat SSE、研究、文档、技能、管理员、插件管理            │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ 入队任务
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   异步任务队列（Redis / RabbitMQ / SQLite queue）                │  │
│  │   - 插件 tool 调用                                             │  │
│  │   - Sidecar 文档渲染                                           │  │
│  │   - 文件格式转换                                               │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │ 轮询/推送结果
┌──────────────────────────────────▼──────────────────────────────────┐
│                       执行面 (Sandbox VPS)                          │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Plugin Worker 池                                            │  │
│  │   ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │  │
│  │   │ Connector   │ │ Execution   │ │ UI Plugin               │ │  │
│  │   │ (Slack...)  │ │ (Sidecar...)│ │ (React 动态加载)        │ │  │
│  │   └─────────────┘ └─────────────┘ └─────────────────────────┘ │  │
│  │   - Docker 容器 / WASM runtime                                │  │
│  │   - 受限的出站网络                                           │  │
│  │   - 按租户隔离的文件系统                                     │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ 上传输出
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   对象存储（S3 / DigitalOcean Spaces / MinIO）                 │  │
│  │   生成的文件，按租户隔离                                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
├─────────────────────────────────────────────────────────────────────┤
│   Python Worker (packages/server)                                   │
│   FastAPI + pydicom + MONAI — DICOM 解析、推理、OCR、               │
│   临床图谱、向量搜索、事件溯源                                      │
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

第一个官方插件是 **MedSci-Sidecar** —— 基于模板和结构化数据生成 DOCX、PPTX、表格和图表。详见：

- [`docs/design/PLUGIN_MARKETPLACE.md`](docs/design/PLUGIN_MARKETPLACE.md)
- [`docs/design/PLUGIN_MANIFEST_SPEC.md`](docs/design/PLUGIN_MANIFEST_SPEC.md)
- [`docs/design/MEDSCI_SIDECAR.md`](docs/design/MEDSCI_SIDECAR.md)

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
# Terminal 1 — TypeScript 后端
cd packages/server-ts
cp .env.example .env
npx prisma db push
npx tsx src/main.ts

# Terminal 2 — Web 前端
cd packages/web
pnpm install
pnpm exec vite --host
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

推送到 `main` 触发 5 阶段流水线：类型检查 → 单元测试 → 预发 + 回归 → Cloudflare SSL → 部署。

- **预发关口**: 部署到 VPS 的 `localhost:8002`，运行回归测试，全部通过后方可部署生产环境。
- **双平面部署**: Control Plane（主 API）与 Execution Plane（插件/sandbox worker）独立构建、独立部署。当 `packages/plugin-worker` 或插件 manifest 变更时，重新构建 Execution Plane 镜像。
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
│   Caddy      │◄─────────────────────────────►│  Control Plane   │
│  (HTTPS)     │                               │  :8001 main API  │
└──────┬───────┘                               │  Plugin Manager  │
       │                                       │  Job Queue       │
       ▼                                       └────────┬─────────┘
┌──────────────┐                                        │ enqueue
│   Web UI     │                                        │
└──────────────┘                                        ▼
                                               ┌──────────────────┐
                                               │  Execution Plane │
                                               │  :8002 worker    │
                                               │  sandbox plugins │
                                               └──────────────────┘
```

## Secret 管理

DigitalOcean 目前没有独立的托管 Secrets Manager（对应 AWS Secrets Manager）。推荐方案按优先级：

1. **Docker Secrets + Docker Swarm**（VPS 方案，推荐）
   - 将插件 API token、JWT secret、LLM key 存为 Docker secrets。
   - secrets 挂载为 `/run/secrets/<name>`，不进入镜像或 env。
   - 适合当前 Droplet + Docker Compose / Swarm 部署。

2. **DigitalOcean App Platform Secrets**（Serverless 方案）
   - 若将 Execution Plane 部署到 App Platform，可直接使用其环境变量/Secrets 功能。
   - 适合未来把插件 worker 拆分为 serverless functions。

3. **自托管 HashiCorp Vault**（企业方案）
   - 在 DigitalOcean Droplet 上部署 Vault。
   - 动态凭证、审计、细粒度访问控制。
   - 运维成本较高，建议用户量/插件量大时引入。

**当前推荐**：Docker Secrets on DigitalOcean Droplets。迁移到 App Platform 或 Vault 时，接口层保持不变。

## CI/CD

GitHub Actions 自动部署到 DigitalOcean：

```
TypeCheck → Unit Tests → Staging + Regression → Cloudflare SSL → Deploy
```

- **Staging**: 部署到 `localhost:8002` 在 VPS 上运行回归测试。
- **Production**: `scripts/deploy.sh` 部署 Control Plane；Execution Plane 通过独立的 worker 部署脚本或 Docker Swarm stack 更新。

```bash
# 手动部署 Control Plane
ssh root@<control-vps-ip> "bash -s" < scripts/deploy.sh

# 手动部署 Execution Plane（当前通过 Docker Compose/Swarm 部署 worker stack）
ssh root@<worker-vps-ip> "cd ~/heurion && docker compose -f docker-compose.worker.yml pull && docker compose -f docker-compose.worker.yml up -d"
```

> `docker-compose.worker.yml` 是 Execution Plane 的独立编排文件，与 Control Plane 解耦。
