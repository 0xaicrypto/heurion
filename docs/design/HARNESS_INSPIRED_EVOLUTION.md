# Heurion 演进设计：会话事件化 + 能力化边界

**Status:** Design proposal (v1.0)  
**更新:** 2026-08-20  
**Deciders:** JZ (architect), backend team  
**关联:** 以 DeepSeek Harness（`dsh`，MIT）为参考，结合 Heurion 医疗临床场景推导的后续架构方向。

---

## 1. 背景与动机

### 1.1 现状

Heurion 已形成「控制面 + 执行面」的分层：

- **控制面（server-ts）**：chat 管线、工具注册表、插件生命周期、意图判定（veto → 语义路由 → 单次 LLM 裁决）、记忆/知识检索、场景一致性校验。
- **执行面（worker / python-stats-worker / embedding-server）**：文档/办公渲染、权威统计、本地 embedding。
- **契约层（contracts）**：SSE 事件 union、wire 消息形状、渲染内容 schema 的单一来源。

近期已完成意图识别与上下文管理优化：#557/#549/#558（强否决 + 单次 LLM 裁决 + 保守降级）、#562（语义路由三分类 + 真值集）、#561（uncertain 反问 + 标签回写）、#546（scene 一致性校验）、#545（docs 解耦）。

### 1.2 问题清单

| # | 问题 | 现状根因 |
|---|---|---|
| P1 | `chat-handler.ts` 仍 1049 行（#544），SSE 事件在管线内直接 `send`  | 无事件抽象，归属/订阅/重放无结构可依 |
| P1 | 工具面为编译期静态注册（`tool-registry.ts` 集中 import 全部工具），插件只门控少数工具；插件卸载级联为手写 | 无 effect 化生命周期，运行态注册不可表达（#454 遗留） |
| P2 | 上下文/压缩是函数式硬编码（`chat-context.ts` 预算裁剪、`context-compressor.ts` 锚定压缩），不可替换、不可组合 | 无 capability seam；策略换不掉 |
| P2 | 判定埋点（#560 已产出 `SidecarDecisionDetail`）但行为信号/语料沉淀仍是「要做的下一步」 | 内部通道未建立，埋点只能靠回调 |
| P2 | 「进入模型的输入」无法结构化重建（无 Model-visible ⟺ logged 不变量） | 会话事件日志缺失，回归只能靠 LLM mock + 真值矩阵 |
| P3 | LLM 网关为启动期 registry（Strategy + DIP），模型路由策略（意图裁定 / summarizer / 主对话走不同配置）无统一协议 | 无 adapter 级流式协议与稳定错误码 |

---

## 2. DeepSeek Harness 的参考价值与取舍

Harness 的设计要点（详见 `docs/` 与仓库 `packages/`）：

1. **一切皆插件 + 自研 Cordis 框架**：Fiber 状态机生命周期、`inject` 依赖驱动加载、`ctx.effect()/ctx.on()/ctx.tools.register()` 注册即 effect（卸载自动清理）、HMR 热替换。
2. **类型化事件系统**：`namespace/action` 命名 + TS 声明合并，四种模式 `emit / bail / serial / waterfall`。
3. **能力三层拆分**：Service Definition（契约与类型）/ Provider（可替换实现）/ Consumer（模型可调工具），三者经 definition 解耦，`cordis.yml` 声明式组网。
4. **会话事件日志**：`SessionEventMap`（`turn/*`、`step/*`、`tool/*`、`compaction/*`）为持久化事件；**Model-visible ⟺ logged** 为不可违反的不变量。
5. **Compaction 是 capability seam**：base 契约 + 多 provider（LLM summarizer / 规则 pruner），带锁定与 shadow-price 协议。
6. **Tool DSL**：`defineTool(parameters + output.schema/render + execute)`，执行值（canonical）与模型可见内容（render）分离。
7. **LLM Adapter**：`stream()` 输出统一 `StreamChunk` 协议（block-start/text-delta/tool-call-delta/block-end/usage/finish），`registerAdapter` 热注册、`resolveModel`/`listModels`、稳定 `LlmError` 错误码。
8. **回归基建**：基于真实组合的 snapshot 转录回放（keyless），模型可见行为被固化回放。

### 2.1 适用性判定

| Harness 设计 | 对 Heurion 的适用性 | 说明 |
|---|---|---|
| 会话事件日志 + Model-visible ⟺ logged | ✅ 直接适用 | 医疗场景对可重溯/审计是刚需，且直接支撑 #544 拆分 |
| 类型化事件总线（emit/serial/waterfall） | ✅ 高价值 | 解决埋点、UI 投影、审计的侵入式现状 |
| Compaction/Context 能力化（seam + provider） | ✅ 高价值 | 预算/压缩策略需要可替换、可组合、可灰度 |
| 能力三层拆分（Definition/Provider/Consumer） | ✅ 选择性采纳 | 用于执行面与 LLM 网关，不用于业务细节 |
| 注册即 effect（自动清理生命周期） | ✅ 采纳（局部） | 简化插件/工具生命周期维护 |
| 全盘 Cordis 框架 / `@deepseek-ai/dsh-*` 包网 | ⚠️ 不引入 | 单业务应用无 OS 级插件生态诉求；引入即重写 |
| JSONL 会话持久化 / 源码热替换 HMR | ❌ 不适用 | 医疗数据需 DB 事务、审计与加密；热替换源码带来审计漏洞 |
| 多 provider 通用 LLM 生态 | ❌ 降级 | Heurion 是单一 SaaS，provider 面有限，做 adapter 协议即可 |

取舍原则：**抽取模式与抽象形态，不搬运框架与实现**。

---

## 3. 设计目标与医疗域约束

### 3.1 目标

1. 会话/判定/工具调用成为**可重建、可审计、可回放**的一等日志流。
2. 意图判定由「规则 veto → 语义路由 → LLM 裁决」的**固定管道**演进为**可组合能力**（语义正式化、反馈闭环、影子灰度）。
3. 上下文与压缩从硬编码函数演化为**可替换 provider**。
4. 工具与插件生命周期**运行时化、卸载自动清理**。
5. 执行面与 LLM 网关具备**统一服务边界（Definition）**，支持沙箱化与策略路由。

### 3.2 医疗域硬约束（不可妥协）

- **PHI 不出控制面**：事件日志中的查询、判定、工具参数必须脱敏或匿名化（沿用 `query_hash`/`patient_hash`）。
- **确定性优先**：意图判定「on doubt 不生成」的保守原则不得被语义路由回退削弱。
- **审计完整性**：任何用户可见输出（文件、消息）必须能回溯到生成它的事件序列。
- **成本可预期**：每用户/每会话的 LLM 调用次数有界，语义路由收益（免 LLM）必须可度量。
- **无网络 egress 的执行边界**：执行插件渲染内容时不得外泄数据（沿用 MEDSCI_SIDECAR 沙箱原则）。

---

## 4. 核心设计

### 4.1 会话事件日志（地基，阶段 1）

把「当前手写流程」收敛为 append-only 事件流。

```
事件流（每个会话一条有序日志）：
  session/created → user/message → step/start → tools/executed
  → step/end → compaction/start → compaction/summary → compaction/end
  → user/message ... → session/closed
```

- **存量接入**：`contracts` 的 SSE chat union 与 `core/event-log.ts` 合一——SSE 事件成为日志事件的**投影**（前端只订阅投影，不再直接消费管线内部形态）。
- **持久化**：`session_events` 表（SQLite，沿用 Prisma），`seq` 单调递增，事件不可变；写入与业务操作同事务（发布状态只在提交点）。
- **不变量**：`Model-visible ⟺ logged`——凡进入模型请求的消息、工具 schema、压缩摘要、意图判定生效路径，必须能由事件日志逐条重构；违反即 CI 失败。
- **收益**：chat-handler 拆分（#544）下沉为「编排进程 + 事件投影」，SSE/审计/telemetry 均为事件消费者；回归可做会话级回放。

### 4.2 类型化内部事件总线（阶段 1）

在控制面进程内引入类型化事件总线（TS 声明合并 + `emit / serial / waterfall` 语义），替代回调式埋点：

- **埋点即订阅**：`sidecar_judge`（#560 产出）、`plugin_invoked`（#455）、`tool/result` 均改为事件；`telemetry.record`、审计、前端弹层（`intent_clarify`）都是独立订阅者。
- **Waterfall 用于意图治理**：`intent/decide` 采用 waterfall 语义（必须 `next()`）——veto 规则、语义路由、LLM 裁决、用户反馈确认按序链式执行，任一环节可短路。
- **边界**：事件总线仅进程内使用；跨进程（worker）保持 HTTP/webhook 现状（#447/#449），不引入事件 MQ 复杂度。

### 4.3 上下文与压缩能力化（阶段 2）

参考 Harness 的「请求上下文插件 + Compaction seam」：

- **ContextProfile 定义**：`ContextProfileService.define(profile, sources?)`，profile 为声明式资源清单（persona / scene / 患者事实 / 文件引用 / 附件）。
  - `resolveScene`（#546）回归为 profile 解析的显式步骤（`resolve(request): Spec`，不在 `run()` 内隐藏默认值）。
  - 记忆/事实注入（`chat-context.ts` 的 `isolateFactsByScope`）成为 profile 的一个 provider。
- **CompactionService 契约：**
  ```
  interface CompactionService {
    conclude(session): Promise<CompactionResult>   // 锚定/总结
    prune(session): Promise<CompactionResult>      // 规则裁剪（tool-result pruner）
  }
  ```
  内置 provider 沿用现有 `context-compressor.ts`；新 provider（如按章节总结、PHI 哨兵裁剪）可插拔、可按会话/场景灰度。
- **预算校验（#194/#553）**上移为 pipeline（waterfall）的一环：任何 provider 的注入结果都过同一预算闸门；超限时回到裁剪 provider。

### 4.4 工具与插件运行时化（阶段 2）

- **ToolRegistry 增加运行时 `register/unregister`**：注册返回 disposer（仿 effect 语义），插件卸载时自动注销，替换手写级联（#454 尾清算）。
- **工具 DSL 对齐 `output.schema + render` 分离**：执行返回值（canonical）与模型可见内容分离，前端渲染 shell 独立为 render 函数，为「诚实输出」与 UI 卡片提供统一点。
- **插件能力面扩展**：`PLUGIN_GATED_TOOLS`（`render_chart/render_scene/browser_task`）维持门控语义，但门控判断改为「能力注册表查询」而非硬编码映射；新官方插件可声明自己的门控工具集。

### 4.5 意图判定分层管道正式化（阶段 2）

将 #557/#562 的管道从「函数内 if-else」上移为**显式管道对象**（沿用事件总线 waterfall）。完整业务流（意图判定 → 工具路由 → 回答落定，含场景感知）、`TurnIntent` 模型与路由决策表见
[`TURN_INTENT_DESIGN.md`](./TURN_INTENT_DESIGN.md)：

```
user/message
  → intent/veto      （DISCUSSION/EDIT markers，0 LLM，不可覆盖）
  → intent/semantic  （embedding 三分类，缺 embedding 服务时自动跳过）
       ├─ 高置信 generate/veto → 直接落定
       └─ uncertain → intent/llm （单次裁决，50 token）
  → intent/clarify   （仅 uncertain：intent_clarify 事件 + 标签回写）
  → intent/commit    （落事件、写 #560 语料）
```

- **语义路由正式化**：`INTENT_SEMANTIC_ROUTER=shadow → on` 灰度；前置门槛为 #559 真值集 recall ≥ 0.9 与影子期分歧率 < 5%。
- **反馈闭环**：#561 的显式选择、#560 的行为信号（下载=正、纠正=负）回流为语义路由 seed 集（数据飞轮），seed 管理脚本化（沿用 `scripts/semantic-router-eval.ts`）。
- **不变式**：任何路径都不得在 `uncertain` 时触发生成；语义/LLM 失败一律降级普通对话。

### 4.6 执行面能力边界 + 沙箱化（阶段 3）

- **定义渲染/执行服务契约（Definition）**：`RenderService.execute(job) → job_id` 与 `StatsService.execute(...)` 接口化，`ExecutionPlaneService`、`python-stats-worker`、未来容器化 worker 均为 Provider；控制面只依赖契约（#450 边界规则不变）。
- **沙箱能力边界**：沿用 MEDSCI_SIDECAR 的「容器执行、无网络 egress、按工具 timeout、事后销毁」约束，落实为 worker 的标准化 job 沙箱；`StubExecutionPlaneService` 显式降级（#448）保持。
- **下载与审计**：诚实下载 URL（#447）与审计日志保持现状，事件日志记录 `job`/`file` 关联，实现端到端回溯。

### 4.7 LLM 网关 adapter 化（阶段 3）

- **借鉴 `LlmAdapter` 形态（不引入框架）**：定义 `stream()` 协议与稳定错误码（`LlmError`），现有 `LlmGateway` 各 provider 实现为 adapter；`resolveModel` 独立用于「意图裁定 / summarizer / 主对话」的策略路由。
- **成本治理**：意图裁定、压缩总结等子任务与主对话共享同一网关但有独立配额/预算记录，全部落 `sidecar_judge`/`compaction/*` 事件。

### 4.8 回归基建：快照回放 + 真值集门禁（持续）

- **真值集门禁**（已落地 #559）成为意图路由改动的必跑项；prompt 变更必须附运行结果（写入 CONTRIBUTING/PR 模板）。
- **会话级快照回放**（阶段 3）：录制真实会话的「事件日志 + 模型输出」，keyless 回放比对；承接「Model-visible ⟺ logged」不变量，从单元级回归升级为组装级回归。

---

## 5. 与现有 issue / 工作项的映射

| 设计项 | 承接 / 收尾 | 依赖 |
|---|---|---|
| 4.1 会话事件日志 | #544（chat-handler 拆分）、#102（工具调用持久化）、#449（webhook） | 无 |
| 4.2 事件总线 | #560（判定埋点/信号采集）、#455（插件调用可视化） | 4.1 |
| 4.3 上下文/压缩能力化 | #98（系统上下文增量）、#194/#553（预算）、#546（scene） | 4.1 |
| 4.4 工具/插件运行时化 | #454（卸载级联）、#451（Strangler 收尾） | 4.2 |
| 4.5 意图管道正式化 | #557/#558/#559/#562（语义路由 on）、#561（澄清闭环） | 4.1、4.2 |
| 4.6 执行面能力边界 | #450、#448、MEDSCI_SIDECAR 沙箱原则 | 无 |
| 4.7 LLM adapter | #436（LLM 网关收敛） | 无 |
| 4.8 快照回放 | #559 扩展 | 4.1、4.5 |

---

## 6. 阶段路线图

### 阶段 1 — 事件化地基（基础性重构）

- [ ] 会话事件日志表与时序写入（发布在提交点）
- [ ] SSE 事件改为日志投影；chat-handler 编排与投影解耦（#544 达成）
- [ ] 进程内类型化事件总线（emit/serial/waterfall）+ 类型化声明
- [ ] `sidecar_judge` / `plugin_invoked` / `tool/result` 改为订阅式埋点
- [ ] `Model-visible ⟺ logged` 静态/测试校验钩子

**出口条件**：全量测试通过；现有行为（意图判定、插件流程、SSE）零回归；无新依赖。

### 阶段 2 — 能力化（语义路由正式化 + 上下文/压缩 seam）

- [ ] 意图管道对象化 + 语义路由 shadow → 灰度 → on（门槛：#559 recall ≥ 0.9、分歧率 < 5%）
- [ ] 行为信号采集（下载/纠正/澄清选择）回流 seed 集
- [ ] CompactionService / ContextProfile 契约 + provider 重组（保留现 provider 为默认）
- [ ] ToolRegistry 运行时 register/unregister（effect 语义）

**出口条件**：语义路由介入后意图判定成本可度量下降；压缩策略可经配置替换；插件生命周期免手工级联。

### 阶段 3 — 边界与回归（执行面沙箱 + 快照）

- [ ] 渲染/统计服务契约化，worker/provider 化
- [ ] 执行面标准沙箱（无 egress、按工具 timeout、事后销毁）
- [ ] 会话级快照回放基建 + 首组组装级快照
- [ ] 意图路由/上下文改动强制执行真值集门禁（文档化）

---

## 7. 明确不做（排除项）

- **不引入 Cordis / 全量插件 OS 框架**：Heurion 是单业务应用，抽取模式而非搬运框架。
- **不引入 JSONL 会话存储**：医疗数据保持 DB 事务与审计。
- **不做插件源码级 HMR 热替换**：审计完整性与可回溯优先。
- **不做多租户通用插件市场生态**：插件仍是官方渲染/工具能力，保持可审计的最小面。
- **不引入事件 MQ/Kafka**：跨进程保持 HTTP/webhook（除已存在的 BullMQ Redis 队列）。

---

## 8. 验收标准（全局）

- [ ] 任何用户可见输出可回溯到会话事件序列（抽样审计 + 自动化测试）。
- [ ] 意图判定五类路径（generate/discuss/uncertain/LLM 失败/强否决）在事件日志中均可复现。
- [ ] 预算/压缩策略可经配置切换 provider 而不改调用方。
- [ ] 卸载任意插件后，其门控工具与相关注册自动消失（自动化断言）。
- [ ] 语义路由开启后：判定 p50 延迟下降、LLM 调用次数可度量下降、#559 recall 达标。
- [ ] 全量测试基线不劣化（当前 780 passed / 3 skipped；tsc --noEmit 无错误）。

---

## 附：术语对照

| DeepSeek Harness | Heurion 对应/演化 |
|---|---|
| Fiber（插件生命周期） | 插件安装/启用/卸载（阶段 2 效果化） |
| ctx.effect() / ctx.on()（注册即 effect） | 事件订阅 / 工具 disposer（4.4） |
| SessionEventMap（持久化 session 事件） | session_events 表 + 日志投影（4.1） |
| Capability seam（Definition/Provider/Consumer） | Compaction / 执行面 / LLM 网关契约（4.3/4.6/4.7） |
| StreamChunk 协议 + LlmError | LlmGateway adapter 化（4.7） |
| 真值矩阵/promptfoo | intent-regression 真值集（#559，已落地） |