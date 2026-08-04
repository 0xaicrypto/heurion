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
Every conversation becomes durable, auditable memory — nothing is written to
the long-term memory without human review, and nothing important is lost when
a long session overflows its context budget.

Key ideas:

- **Human-reviewed memory lifecycle** — AI extraction *proposes* facts; only
  approved proposals enter the memory graph (versioned, supersede-aware, audited).
- **Three-tier extraction** — real-time extraction triggers only on explicit
  memory instructions or safety-critical signals (allergy/contraindication);
  the bulk of fact extraction happens at **compaction time** and on **session
  close**, where full context allows proper aggregation.
- **Anchored compaction** — long sessions are compacted into structured
  summaries that stay injectable for continuity; compaction is delayed-sync
  (a turn arriving mid-compaction waits for it, so the summary is always
  available) and surfaced to the UI with a progress banner.
- **Contradiction handling** — facts carry scope identity (patient/study);
  extraction flags contradictions against same-scope confirmed facts, and
  approving a contradictory proposal supersedes the old fact (history kept).
- **Context budget transparency** — the chat header shows history-token usage
  as a percentage, so the next compaction is always predictable.
- **Tool-call persistence** — every tool call is persisted as a state machine
  (pending → running → completed/error) with replay API; outputs are bounded
  (head+tail truncation with full content saved to disk); doom-loops are
  detected and warned about.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Client Layer                             │
│  Web UI (packages/web) — React + Vite + Tailwind + i18n      │
│  SSE streaming chat, session manager, Brain inbox, Today     │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTPS / SSE
┌──────────────────────────────▼───────────────────────────────┐
│                   Production (Docker Compose)                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  nexus-server (packages/server-ts) — Fastify + Prisma  │  │
│  │  + SQLite                                              │  │
│  │  Auth · Chat SSE · Memory lifecycle · Sessions ·       │  │
│  │  Patients · Research · Docs · Skills · Approvals ·     │  │
│  │  Ingestion · Tools · Admin                             │  │
│  │  Serves the web UI (dist) with no-cache HTML           │  │
│  └───────────────────────────┬────────────────────────────┘  │
│  ┌───────────────────────────▼────────────────────────────┐  │
│  │  nexus-embedding-server — local bge-m3 + per-user      │  │
│  │  brute-force semantic index (JSONL)                    │  │
│  └────────────────────────────────────────────────────────┘  │
│  Caddy reverse proxy (automatic HTTPS) in front            │
└──────────────────────────────┬───────────────────────────────┘
                               │ Cloudflare (purged on deploy)
                               ▼
                            heurion.org
```

### Memory lifecycle (Brain 2.0)

```
Chat turns / ingestion / session close
        │
        ▼
EventLog (append-only, source of truth)
        │
        ▼
Extraction (three tiers)
  Tier 1  real-time: explicit instructions (记住/保存…) + allergy/contraindication
  Tier 2  compaction: dropped segments → aggregated facts + anchored summary
  Tier 3  session close: flush any segment never extracted
        │
        ▼
MemoryProposal (pending review queue)  ◄── NO direct write path
        │  approve (human)              │  reject
        ▼                               ▼
Memory graph (versioned)            dropped (audited)
   └─ approving a conflicting proposal supersedes the old fact
```

### Chat runtime

- **Intent router**: `sql` / `vector` / `file` / `knowledge_command` /
  `sidecar` / `mixed` — LLM fallback with a safety net (a misclassified
  `knowledge_command` that doesn't parse degrades to `mixed`).
- **Context projection**: persona (cached by facts/knowledge versions, K5),
  patient context, episodes, filtered facts, active skills.
- **History budget**: 8000 tokens / 20 turns (env-configurable), surfaced to
  the UI as a usage bar (U3); overflow triggers anchored compaction.
- **Tool loop**: up to 5 rounds; every call persisted (R3) with per-session
  seq; outputs bounded (T1, head+tail + full file on disk); doom-loop guard.
- **Gap detection (K6)**: question-shaped messages not covered by any fact
  create a knowledge gap (7-day dedup).

---

## Quickstart

```bash
# Terminal 1 — backend
cd packages/server-ts
cp .env.example .env
# Edit .env: set DEEPSEEK_API_KEY
npx prisma db push
npx tsx src/main.ts
# → http://localhost:8001 (serves web dist if present)

# Terminal 2 — web UI (dev)
cd packages/web
pnpm install
pnpm exec vite --host
# → http://localhost:5173
```

Tests:

```bash
cd packages/server-ts && pnpm vitest run   # 60 files / 430+ tests
cd packages/web && pnpm test               # 10 files / 73 tests
bash scripts/regression-test.sh http://localhost:8002
```

---

## Module map (server-ts)

```
src/
├── modules/
│   ├── auth/            JWT auth, register/login, roles (first user = admin)
│   ├── chat/            SSE chat, sessions (multi-session), orchestrator,
│   │                    user-context (per-user memory), tool loop
│   ├── approvals/       MemoryProposal & MedicalRecordEntry approvals, audit
│   ├── ingestion/       File upload → AI analysis → pending review entries
│   ├── medical-records/ Patient record entries (pending_review flow)
│   ├── patients/        Patient CRUD + DICOM
│   ├── research/        Studies, roster, eligibility
│   ├── documents/       Writing studio, AI polish, PHI scanner
│   ├── knowledge/       KB commands, knowledge gaps (K6), telemetry
│   ├── practitioner/    Takeaways, narratives
│   └── ...              skills, settings, files, admin, calendar, execution
├── memory/
│   ├── memory-gateway.ts     single facade: propose/applyApproved/reject/read
│   ├── compaction.ts         R2 anchored compaction (Tier 2) + delayed-sync
│   ├── extraction-cursor.ts  K1/K2 per-scope incremental cursor + triggers
│   ├── knowledge-synthesis.ts K3/K4 episode summaries + article synthesis
│   ├── embedding-index.ts    per-user semantic index (reviewed memories only)
│   └── memory.service.ts     versioned graph (supersede + audit)
├── tools/
│   ├── tool-registry.ts      registry + uniform output bounding (T1)
│   ├── tool-output-store.ts  head+tail truncation + disk persistence
│   ├── doom-loop.ts          same tool+args 3x guard
│   └── clinical-graph-tools.ts / calendar / memory / ocr / subagent / async
└── retrieval/
    ├── query-router.ts       intent classification (rules + LLM fallback)
    └── context-compressor.ts history budget + omitted-turn accounting
```

---

## Key APIs

All responses use `snake_case`. Key endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/auth/register` · `/login` | Auth |
| POST | `/api/v1/agent/chat` | Chat (SSE) |
| GET/POST | `/api/v1/sessions` · `POST /api/v1/sessions/:id/close` | Session management |
| GET | `/api/v1/agent/messages?session_id=` | Message replay (tool events filtered) |
| GET | `/api/v1/agent/tool-events?session_id=` | Tool-call state machine replay (R3) |
| GET | `/api/v1/approvals/pending` · POST `/api/v1/approvals/:id/confirm|reject` | Memory review inbox |
| GET | `/api/v1/knowledge/gaps` · POST | Knowledge gaps (K6) |
| GET/POST | `/api/v1/dicom/patients/...` | Patients + DICOM |
| POST | `/api/v1/files/upload` | File upload (paste/clipboard) |
| GET | `/api/v1/skills/search` | Skills |
| GET | `/api/v1/admin/users` | Admin |
| POST | `/api/v1/execution/render` · GET `/api/v1/execution/jobs/:id` | Sidecar jobs |

Design docs: [`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md) ·
[`docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md`](docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md)

---

## CI/CD

Every push to `main`:

```
TypeCheck → Unit Tests → Build Web → Staging + Regression → Cloudflare SSL
→ Deploy Production (Docker Compose) → Purge Cloudflare cache
```

- `main` is protected — changes land via PRs with required checks
  ("Build + Phase 0 regression", "Build + lint").
- The deploy wipes stale web assets so a cached HTML can never load an
  old bundle; the SPA HTML is served `no-cache`; hashed assets are immutable.
- Production: single VPS, Docker Compose (Caddy + nexus-server +
  nexus-embedding-server), SQLite, Cloudflare in front (purged post-deploy).

Deployment details: [`DEPLOY.md`](DEPLOY.md)

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

面向肿瘤研究者的**自我进化型临床 AI 工作站**。每一段对话都会沉淀为可审计的长期记忆——记忆写入必须经过**人工审核**，长会话溢出预算时也不会丢失关键信息。

核心设计：

- **人工审核的记忆闭环** — AI 提取只生成"待审核提案"（pending），批准后才进入版本化记忆图谱；无任何直写路径
- **三级提取策略** — 实时提取仅在显式记忆指令（记住/保存）或安全关键信号（过敏/禁忌）时触发；批量提取集中在**压缩时**与**会话关闭时**（上下文完整，可聚合）
- **锚定压缩** — 长会话被压缩为结构化摘要持续注入；压缩采用 delayed-sync（压缩期间的新消息等待压缩完成再回复），前端有"压缩中"横幅提示
- **矛盾检测与取代** — 事实携带患者/范围标识；提取时标注与同范围已确认事实的矛盾，批准矛盾提案时旧事实自动退位（版本保留可审计）
- **上下文预算透明** — 聊天头部显示历史 token 用量百分比，压缩时机可预期
- **工具调用可观测** — 每次工具调用落库为状态机（pending → running → completed/error）可回放；输出超限自动截断并落盘；检测死循环调用

## 架构

生产为单机 Docker Compose：**Caddy**（自动 HTTPS）→ **nexus-server**（Fastify + Prisma + SQLite，服务后端与前端静态资源，HTML no-cache）→ **nexus-embedding-server**（本地 bge-m3 + 按用户隔离的语义索引）。前置 Cloudflare，部署后自动 purge 缓存。

## 记忆生命周期（Brain 2.0）

```
聊天/文件导入/会话关闭
        │
        ▼
EventLog（只追加，唯一真相源）
        │
        ▼
三级提取
  一级 实时：显式指令（记住/保存…）+ 过敏/禁忌
  二级 压缩：被挤出段 → 聚合事实 + 锚定摘要
  三级 关闭：冲刷从未提取过的段
        │
        ▼
MemoryProposal（待审核队列）◄── 无直写路径
   │ 批准（人工）                  │ 拒绝
   ▼                              ▼
版本化记忆图谱             丢弃（审计留痕）
   └─ 批准矛盾提案 → 旧事实自动 supersede
```

## 聊天运行时

- **意图路由**：`sql` / `vector` / `file` / `knowledge_command` / `sidecar` / `mixed`（LLM 兜底 + 安全网：误判的命令自动降级为混合）
- **上下文投影**：Persona（按 facts/knowledge 版本缓存，K5）、患者上下文、会话摘要、过滤后的事实、技能
- **历史预算**：8000 tokens / 20 轮（env 可调），头部进度条可视化（U3），溢出触发锚定压缩
- **工具循环**：最多 5 轮；每次调用持久化（R3，per-session 序号）；输出限量（T1，head+tail + 完整落盘）；死循环守卫
- **Gap 检测（K6）**：问题形态且未被任何事实覆盖的消息 → 创建知识缺口（7 天去重）

## 快速开始

```bash
cd packages/server-ts && cp .env.example .env   # 设置 DEEPSEEK_API_KEY
npx prisma db push && npx tsx src/main.ts       # → http://localhost:8001
cd ../web && pnpm install && pnpm exec vite --host   # → http://localhost:5173
```

测试：`packages/server-ts`（60 文件 / 430+ 用例）、`packages/web`（10 文件 / 73 用例）、`scripts/regression-test.sh`。

## CI/CD

推送 `main`：类型检查 → 单测 → 构建 Web → 预发 + 回归 → Cloudflare SSL → 生产部署（Docker Compose）→ 清理 Cloudflare 缓存。`main` 受保护，变更走 PR + 必检项。

设计文档：[`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md) ·
[`docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md`](docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md)
