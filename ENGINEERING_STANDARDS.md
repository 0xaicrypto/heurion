# Engineering Standards

These are non-negotiable rules. A change that violates one of them is
NOT considered "done" — it ships as red, not green.

If you're an AI assistant working on this codebase: when in doubt,
default to the strict interpretation. The cost of one extra test / one
extra guard line is far smaller than the cost of debugging a "works on
my machine" bug surfaced by a user.

> 本文档 2026-09-10 重写（#943）：旧版三条规则全部指向已删除的
> `packages/server`（Python/Alembic）、`packages/desktop-v2`（Tauri）、
> `scripts/build-macos.sh`（.dmg 打包）——那套技术栈已于 2026-07 删除。
> 现行栈：`packages/server-ts`（Fastify/Prisma/SQLite）· `packages/web`
> (React) · `packages/worker`（执行面）· `packages/contracts`（渲染契约）
> · `packages/python-stats-worker`。

---

## Rule 1 — 产出内容必须过契约校验，生成器永不产半截文件

**Statement**: AI 产出的 render content（docx/pptx/pdf/图表）必须先过
`@heurion/contracts` 的 `validateRenderContent`；校验失败直接返回可读
错误给模型重试，禁止把未校验 JSON 送进 worker。

**Why**: 契约是 AI 侧与渲染侧的唯一形状来源。#773/#790 曾实际漂移一次
（schemaVersion）；#966 空标题节事件证明：生产者不保证不变量时，契约
校验是最后一道防线（它当时拦住了，但根因在生产者）。

**Concretely:**

- 生产者保证契约不变量（如 `documentSectionSchema.paragraphs.min(1)`），
  不依赖校验器兜底（#966 修复模式：生产者补占位段）。
- 契约演进用**加性 optional 字段** + golden fixture 锁
  （`tests/unit/deck-v2-contract.test.ts` 模式），旧载荷必须永远可解析。
- contracts 是手写双份镜像的 zod（TS）× pydantic（Python）——改形状必须
  两端同步 + 跑 golden cross-check（#941 升级至机读形状对齐中）。

## Rule 2 — 分层规则（#672/#939/#940）

**Statement**（与根 `ARCHITECTURE.md` 的机器可执行版一致）：

```
common/  core/          leaf — 零 import 自 modules/tools/memory/retrieval
memory/  retrieval/     可依赖 common/core，禁止 import modules/*
tools/                  可依赖 common/core/memory/retrieval，禁止 import modules/*
modules/*               横向仅限 peerEdges 已声明边
```

**Enforcement**: `tests/unit/arch-layers.test.ts`（#913 跨模块边 + #940
leaf 反向依赖）机读锁定。新边先改表再改代码；跨层依赖用端口注入
（ToolContext #666 模式）或 registry 钩子反转（#939 persona 模式），
不破层。

## Rule 3 — 每个变更带回归测试

**Statement**: 每个行为变更带一个"修复前必挂、修复后必过"的测试。
事故修复额外加防复发锁（静态扫描/守门测试），参照
`no-prisma-as-any.test.ts`、`arch-layers.test.ts`、
`patient-record-ownership.test.ts` 的模式。

**Definition of done**:

```
cd packages/server-ts && pnpm test   # 控制面
cd packages/worker && npx vitest run # 执行面
cd packages/web && pnpm test         # 前端（eslint 0 warning 同门槛）
```

全绿才算完成；渲染产物类改动另附 golden（deck→pptx：`worker/tests/pptx-golden.test.ts`）。

## Rule 4 — 安全底线

**Statement**:

- 跨用户资源读写一律带 `userId` 归属过滤；`patientRecord` 查询有静态
  扫描锁（#936 模式），新增同类模型照做。
- 密钥/配置 fail-closed：默认值不得是可用的明文（GRAFANA_ADMIN_PASSWORD
  事故模式）；`.env.production` 不入库。
- 文件路径：worker/execFile 全数组参数、`asset://` bare name 校验
  （#900 已修口径）、uploads 解析取 basename 防目录穿越。
- 容器 non-root（`nexus` UID 1000）为默认；例外必须文档注明理由
  （worker root = chromium sandbox 限制，见 `packages/worker/Dockerfile`）。

## Rule 5 — 文档与实现同步

**Statement**: 写进文档的能力（部署行为/安全声明/标准规则）必须与
实现一致，且文档引用的仓库路径必须存在。能力失效而文档未改 = 体检
高优先级缺陷（#938 vps_deploy.sh 孤儿脚本模式）。

**Concretely:**

- 改部署链路必须同步 `DEPLOY.md` / `docs/CICD.md`；改分层必须同步
  根 `ARCHITECTURE.md` 边表。
- 顶层 `ENGINEERING_STANDARDS.md` / `ROADMAP.md` 只描述当前真实栈与
  当前计划；技术栈删除时文档同批更新。

---

## TypeScript 编译器现状（#953 核实记录）

- `packages/server-ts`: `typescript ^7.0.2` — 微软原生 Go 移植（tsgo）
  预览版编译器，非经典 tsc。**当前构建/tsc 实跑正常**；注意它是
  preview，IDE（经典 tsserver）与 CI（tsgo）诊断可能不一致，出现
  "IDE 不报错、CI 报错"以此为准。
- `packages/web`: 固定 `5.4.5`。两套实现并存为**现状事实**；统一升级
  待 tsgo 稳定后另行评估。

## Living document

Add a rule when you spot a repeating failure mode that this doc would
have prevented. Remove a rule only when its violation history has been
zero for 90 days.
