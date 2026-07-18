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
┌──────────────────────┐
│   Web UI             │  React + Vite + Tailwind + i18n
│   packages/web        │  Light/dark mode; Chinese/English
├──────────────────────┤
│   @heurion/sdk       │  Typed client — 10 modules, browser + CLI ready
│   packages/sdk-client │  AsyncGenerator-based SSE streaming
├──────────────────────┤
│   Server (TS)        │  Fastify + Prisma + SQLite
│   packages/server-ts  │  10 feature modules; SSR chat with DeepSeek
├──────────────────────┤
│   Python Worker       │  DICOM parsing, MONAI inference, event sourcing
│   packages/server      │  Clinical graph, vector search, OCR
└──────────────────────┘
```

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
| **Web UI** | `packages/web` | React 18 + Vite 5 + Tailwind | 22 routes, i18n, dark mode |
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

## Test Plan

44 test cases covering all modules — see [`packages/server-ts/TEST_PLAN.md`](packages/server-ts/TEST_PLAN.md).

Run the test suite:
```bash
pnpm test                    # SDK tests
pnpm test                    # Server integration tests
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
┌──────────────────────┐
│   Web UI             │  React + Vite + Tailwind + i18n
│   packages/web        │  明暗主题；中英文切换
├──────────────────────┤
│   @heurion/sdk       │  类型化客户端 — 10 个模块，浏览器/CLI 通用
│   packages/sdk-client │  AsyncGenerator 流式 SSE
├──────────────────────┤
│   Server (TS)        │  Fastify + Prisma + SQLite
│   packages/server-ts  │  10 个功能模块；DeepSeek 实时对话
├──────────────────────┤
│   Python Worker       │  DICOM 解析、MONAI 推理、事件溯源
│   packages/server      │  临床图谱、向量搜索、OCR
└──────────────────────┘
```

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

## 部署

CI/CD 通过 GitHub Actions 自动部署到 Digital Ocean。
推送到 `main` 分支即触发 `scripts/deploy.sh`。

```bash
# 手动部署
ssh root@<vps-ip> "bash -s" < scripts/deploy.sh
```
