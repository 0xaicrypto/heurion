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
  There is **no direct write path** — the review queue is the single gate.
- **Two memory forms, one extraction path** — *Session Memory* (episodes:
  per-session draft layer, only injected into the current session) and
  *Facts* (approved, cross-session archive). A single `extractSegment` path
  runs at **compaction time** and on **session close**; real-time extraction
  only fires on explicit memory instructions (`kb_remember`) or
  safety-critical signals (allergy/contraindication).
- **Anchored compaction** — long sessions are compacted into structured
  summaries that stay injectable for continuity; compaction is delayed-sync
  (a turn arriving mid-compaction waits for it, so the summary is always
  available) and surfaced to the UI with a progress banner.
- **Contradiction handling** — facts carry scope identity (patient/study);
  extraction flags contradictions against same-scope confirmed facts, and
  approving a contradictory proposal supersedes the old fact (history kept).
- **Pending-review governance** — proposals are grouped by category with an
  extraction-quality feedback loop; low-importance items auto-archive after 7
  days (high-importance ones stay pinned) so the inbox never piles up.
- **Context budget transparency** — the chat UI shows history-token usage as a
  percentage, so the next compaction is always predictable.
- **Tool-call persistence** — every tool call is persisted as a state machine
  (pending → running → completed/error) with replay API; outputs are bounded
  (head+tail truncation with full content saved to disk); doom-loops are
  detected and warned about.
- **Conversational writing** — a TipTap document canvas edits in place via
  `edit_document`; chat can insert generated SVG charts (`render_chart`) and
  inline images through the writing pipeline.
- **Reliability** — LLM calls have timeouts + 429/5xx retries with friendly
  errors; SSE aborts on client disconnect with messages persisted upfront;
  dual-store writes are atomic (graph commits last, failures roll back).

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
extractSegment — single path, runs at
  compaction (Tier 2) and session close (Tier 3);
  explicit instructions (记住/保存…) handled by kb_remember
        │
        ▼
MemoryProposal (pending review queue)  ◄── NO direct write path
        │  approve (human)              │  reject
        ▼                               ▼
Memory graph (versioned, Facts)     dropped (audited)
   └─ approving a conflicting proposal supersedes the old fact
Session Memory (episodes) — draft layer injected into the current
session only; never leaks across sessions before approval
```

### Chat runtime

- **Intent router**: `sql` / `vector` / `file` / `knowledge_command` /
  `sidecar` / `mixed` — LLM fallback with a safety net (a misclassified
  `knowledge_command` that doesn't parse degrades to `mixed`).
- **Context projection**: persona (cached by facts/knowledge versions, K5,
  patient-scope isolated), patient context, episodes (Session Memory),
  filtered facts, active skills.
- **History budget**: 8000 tokens / 20 turns (env-configurable), surfaced to
  the UI as a usage bar (U3); overflow triggers anchored compaction.
- **Tool loop**: up to 5 rounds; every call persisted (R3) with per-session
  seq; outputs bounded (T1, head+tail + full file on disk); doom-loop guard.
- **Gap detection (K6)**: question-shaped messages not covered by any fact
  create a knowledge gap (7-day dedup).
- **LLM reliability**: 60s timeout, 429/5xx exponential retry honoring
  Retry-After, friendly error text (never raw provider errors).
- **SSE safety**: client disconnect aborts the LLM request; the user message
  is persisted before streaming starts (a failed turn is never lost).

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
cd packages/server-ts && pnpm vitest run   # 72 files / 474 tests (AI mocked, hermetic)
cd packages/web && pnpm test               # 14 files / 93 tests
bash scripts/regression-test.sh http://localhost:8002   # 96 checks, LLM-dependent ones retried
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
│   ├── documents/       Writing studio (TipTap canvas), AI polish, PHI scanner
│   ├── files/           Upload + tokenized download (chart/image rendering)
│   ├── knowledge/       KB commands, knowledge gaps (K6), telemetry
│   ├── memorization/    Memory health panel (/api/v1/memory/health)
│   └── ...              skills, settings, admin, calendar, execution, plugins
├── memory/
│   ├── memory-gateway.ts     single facade: propose/applyApproved/reject/read
│   ├── memory.service.ts     versioned graph (supersede + audit, dual-store
│   │                         atomic writes with rollback)
│   ├── compaction.ts         R2 anchored compaction (extractSegment) + delayed-sync
│   ├── extraction-cursor.ts  per-session incremental cursor (K1/K2)
│   ├── extraction-quality.ts category quality feedback + prompt guidance
│   ├── knowledge-synthesis.ts K3/K4 episode summaries + article synthesis
│   ├── context-sources.ts    typed context sources (R1, docs/current)
│   ├── curation/             propagation engine (stale/supersede cascade)
│   └── embedding-index.ts    per-user semantic index (reviewed memories only)
├── tools/
│   ├── tool-registry.ts      registry + uniform output bounding (T1)
│   ├── tool-output-store.ts  head+tail truncation + disk persistence
│   ├── doom-loop.ts          same tool+args 3x guard
│   ├── edit-document-tool.ts conversational writing (write-back + snapshots)
│   ├── chart-renderer.ts     SVG chart generation (line/bar/dose_curve)
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
| GET | `/api/v1/memory/health` | Memory health panel (13.5G) |
| GET | `/api/v1/dicom/patients/...` | Patients + DICOM |
| POST | `/api/v1/files/upload` | File upload (paste/clipboard) |
| GET | `/api/v1/files/download/:fileId` | File/chart download (tokenized, <img>-friendly) |
| POST | `/api/v1/docs/:docId/chat` | Deprecated (410) — writing chat runs via `/agent/chat` with `session_id: doc-<docId>` |
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
- The deploy also prunes Docker/containerd disk usage first (manual
  `vps-disk-diagnose` / `vps-disk-clean` workflows exist for emergencies).
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
- **两形态 + 一条提取路径** — *Session Memory*（episodes：会话内草稿层，仅注入当前会话）与 *Facts*（批准后的跨会话档案）；统一 `extractSegment` 在**压缩时**与**会话关闭时**运行；实时提取仅响应显式记忆指令（kb_remember）或安全关键信号（过敏/禁忌）
- **锚定压缩** — 长会话被压缩为结构化摘要持续注入；压缩采用 delayed-sync（压缩期间的新消息等待压缩完成再回复），前端有"压缩中"横幅提示
- **矛盾检测与取代** — 事实携带患者/范围标识；提取时标注与同范围已确认事实的矛盾，批准矛盾提案时旧事实自动退位（版本保留可审计）
- **待审治理** — 提案按类别分组并带提取质量反馈；低重要性项 7 天后自动归档（高重要性置顶），收件箱不堆积
- **上下文预算透明** — 聊天界面显示历史 token 用量百分比，压缩时机可预期
- **工具调用可观测** — 每次工具调用落库为状态机（pending → running → completed/error）可回放；输出超限自动截断并落盘；检测死循环调用
- **对话驱动写作** — TipTap 文档画布通过 `edit_document` 就地编辑；聊天可生成 SVG 图表（`render_chart`）并内联渲染图片
- **可靠性** — LLM 调用带超时 + 429/5xx 重试与友好错误文案；SSE 断开即中止请求且消息先落库；双存储写入原子化（graph 最后提交，失败回滚）

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
extractSegment — 单一提取路径，运行于
  压缩时（二级）与会话关闭时（三级）；
  显式指令（记住/保存…）由 kb_remember 处理
        │
        ▼
MemoryProposal（待审核队列）◄── 无直写路径
   │ 批准（人工）                  │ 拒绝
   ▼                              ▼
版本化记忆图谱（Facts）      丢弃（审计留痕）
   └─ 批准矛盾提案 → 旧事实自动 supersede
Session Memory（episodes）— 会话内草稿层，
  仅注入当前会话，批准前不跨会话泄漏
```

## 聊天运行时

- **意图路由**：`sql` / `vector` / `file` / `knowledge_command` / `sidecar` / `mixed`（LLM 兜底 + 安全网：误判的命令自动降级为混合）
- **上下文投影**：Persona（按 facts/knowledge 版本缓存，K5，患者范围隔离）、患者上下文、episodes（Session Memory）、过滤后的事实、技能
- **历史预算**：8000 tokens / 20 轮（env 可调），用量条可视化（U3），溢出触发锚定压缩
- **工具循环**：最多 5 轮；每次调用持久化（R3，per-session 序号）；输出限量（T1，head+tail + 完整落盘）；死循环守卫
- **Gap 检测（K6）**：问题形态且未被任何事实覆盖的消息 → 创建知识缺口（7 天去重）
- **LLM 可靠性**：60s 超时、429/5xx 指数退避重试（遵循 Retry-After）、友好错误文案（不暴露原始错误）
- **SSE 安全**：客户端断开即中止 LLM 请求；用户消息在流式开始前落库（失败不丢轮）

## 快速开始

```bash
cd packages/server-ts && cp .env.example .env   # 设置 DEEPSEEK_API_KEY
npx prisma db push && npx tsx src/main.ts       # → http://localhost:8001
cd ../web && pnpm install && pnpm exec vite --host   # → http://localhost:5173
```

测试：`packages/server-ts`（72 文件 / 474 用例，AI 全 mock 无网络依赖）、`packages/web`（14 文件 / 93 用例）、`scripts/regression-test.sh`（96 项，LLM 依赖项自动重试）。

## CI/CD

推送 `main`：类型检查 → 单测 → 构建 Web → 预发 + 回归 → Cloudflare SSL → 生产部署（Docker Compose）→ 清理 Cloudflare 缓存。`main` 受保护，变更走 PR + 必检项。

设计文档：[`docs/design/BRAIN2_MEMORY_LIFECYCLE.md`](docs/design/BRAIN2_MEMORY_LIFECYCLE.md) ·
[`docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md`](docs/design/PRODUCT_DESIGN_REVIEW_OPENCODE.md)
