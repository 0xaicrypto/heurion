# Heurion 架构与质量优化建议

> 状态：建议稿（2026-08）
> 范围：基于两轮代码审查（memory/retrieval/chat/evolution/patients 模块）的全面优化建议
> 原则：所有建议按"对医生用户的影响"排序；结构优化以"单一职责 + 单一真相源 + 显式依赖"为核心

---

## 一、总体结论

Heurion 的架构骨架是健康的（事件溯源、双平面隔离、测试覆盖 424 项），核心问题集中在三类：

1. **数据一致性**：双存储（graph/legacy）无事务、curation 传播不落盘、embedding 索引不同步 —— 临床记忆可能丢失或"复活"
2. **运行时可靠性**：LLM 主链路无超时重试、SSE 无断开清理、工具异常冒泡 —— 医生会遇到莫名报错
3. **结构债务**：上帝类（gateway 539 行 / orchestrator 601 行 / chat.router 650+ 行）、双管线并存、全局可变注册表 —— 修改成本高、回归风险大

建议按"先修数据一致性 → 再补运行时可靠性 → 最后做结构重构"的顺序推进。

---

## 二、P0：数据一致性（临床记忆不可丢失、不可复活）

### 2.1 Curation 传播结果不落盘（高）

**现状**：`memory.service.ts` 中 editFact/deleteFact 均先 `graph.commit()`，之后才调用 `propagateFactChange`；传播产生的 stale/superseded 标记、gap 重开等图修改**没有再次 commit**。进程重启后，磁盘上的图恢复为"文章仍 current、gap 仍 closed"，已删除/已修正的临床知识"复活"。

**建议**：统一写入顺序为 `修改 → 传播 → 一次 commit`。将三处（editFact/deleteFact/deleteDocument）收敛为一个私有方法：

```ts
private commitWithPropagation(mutate: () => PropagationResult): PropagationResult {
  const propagation = mutate()          // 图修改 + 传播
  this.graph.commit()                    // 一次持久化
  this.applyPropagationToLegacy(propagation)
  this.legacyFacts.commit()
  return propagation
}
```

### 2.2 Embedding 索引不随编辑/删除更新（高）

**现状**：editFact/deleteFact 后，embedding 索引仍保留旧向量与旧内容；`getLatestByStableId` 会返回 superseded 节点，`retrieve()` 仍把已撤销事实作为上下文喂给 LLM。

**建议**：
1. MemoryService 的 edit/delete 路径回调 gateway 更新/删除索引记录（`index.remove(stableId)` 已有，接上即可）
2. `getLatestByStableId` 对 `status === 'superseded'` 返回 undefined 或由调用方显式处理
3. `retrieve()` 结果过滤 `status === 'superseded'`
4. 增加回归测试：删除事实 → 检索 → 不再命中

### 2.3 双存储写入无事务，部分失败即分叉（高）

**现状**：graph 与 legacy 各自独立 commit，任一步失败后两个视图不一致；`readContext` 读 legacy、`SearchNodeTool` 读 graph，同一患者在两个入口看到不同事实集。

**建议（三选一，按投入递增）**：
1. **最小改动**：在每次双写外层加 try/catch，失败时抛带阶段名的结构化错误，并记录指标；重试前先校验两个存储的一致性
2. **推荐**：将 legacy 改为 graph 的**派生投影**（投影函数 + 一次性全量重建/对账任务），单一写路径保证收敛
3. **长期**：迁移到真实数据库（SQLite 事务或 Postgres），消除文件双写

### 2.4 多用户 Proposal 静默丢失（已修复，保持回归覆盖）

**现状**：commit `d92e4d7` 已修复 `registerContextResolver` 全局覆盖问题（改为模块加载时注册一次 + 按 userId 动态查找），并新增 3 个隔离测试。

**保持项**：继续保留 `memory-isolation.test.ts`；后续新增任何"注册表/单例"类机制时，遵守同样模式（注册一次 + 按 key 查找），避免回退。

### 2.5 摄取游标跨会话漏提（高）

**现状**：游标 key 为 `userId:scopeType:patientHash`（全局），但增量查询按 `sessionId` 过滤、`toIdx` 取全局 count。多会话交叉写入时，会话 B 的事件因 `idx ≤ cursor` 被永久跳过。

**建议**：
1. 游标唯一键加入 `sessionId`
2. `advanceExtractedUptoIdx` 改为条件更新（`updateMany where extractedUptoIdx < idx`，命中 0 则跳过），避免并发回退
3. 补充测试：两会话交叉写入 → 双方事件均被提取

### 2.6 提取 LLM 返回无括号文本时游标照常推进（中）

**现状**：`result.match(/\[[\s\S]*\]/)` 为 null 时不抛错不记日志，直接推进游标——该段对话内容静默丢失。

**建议**：解析失败时给 LLM 一次带修正提示的重试；仍失败则记结构化告警，且**仅推进游标到成功解析的位置**。

---

## 三、P1：运行时可靠性（医生视角的稳定性）

### 3.1 LLM 主链路无超时、无重试（高）

**现状**：`llm.ts` 的 `deepseekChat`/`deepseekStream` 为裸 fetch，无 AbortSignal 超时、无 429/5xx/网络重试。带重试的 `DeepSeekChatProvider` 只在旁路使用，主对话链路享受不到。LLM 挂起时用户请求无限挂起，失败时直接暴露原始错误串。

**建议**：
1. `llm.ts` 统一加 60s 超时（AbortSignal）+ 429/5xx 重试（读取 Retry-After，最多 2 次，指数退避）
2. 主链路改用 `DeepSeekChatProvider`（已有重试实现）
3. 错误分类映射：429/超时/网络 → 友好文案（"服务暂时不可用，请重试"），不暴露原始错误
4. 流式中途失败：补发一条可读的 fallback 完成消息

### 3.2 SSE 无断开清理、事件时序风险（高）

**现状**：SSE 处理无 `request.raw.on('close')` 监听，客户端断开后 LLM 请求继续运行（浪费 token）；`send()` 对已销毁 socket 写入可能触发异步 error；用户消息事件在流结束后才 append，流中途失败则该轮对话从 event log 永久丢失。

**建议**：
1. 注册 `reply.raw.on('close')` → `abortController.abort()`，把 signal 传入 fetch
2. 写前检查 `reply.raw.destroyed/writableEnded`
3. **用户消息事件在进入流式前就 append**（先落库再发请求），保证失败不丢轮
4. 长思考场景加 SSE 心跳（每 15s `: ping`）

### 3.3 工具执行异常冒泡、畸形 JSON 崩链路（中）

**现状**：`toolRegistry.execute` 无 try/catch，工具异常冒泡导致整轮对话失败；`JSON.parse(tc.function.arguments)` 无保护，LLM 输出畸形 JSON 直接崩；解析失败时可能把 `<tool_call>` 原始标记发给用户。

**建议**：
1. `execute` 内 `try { return await tool.execute(args) } catch (e) { return { success:false, error } }`，让 LLM 换策略
2. `JSON.parse` 失败时以字符串形式传回给模型（"参数解析失败，请重新输出"）
3. 最终兜底内容不得泄漏 `<tool_call>` 标记
4. 工具参数校验（`top_k` 非数字 → 默认值而非 NaN）

### 3.4 上下文预算：全局缺失 + 时间单位 bug（高）

**现状**：
1. **已修复**：`daysAgo` 秒/毫秒单位 bug（`chat.orchestrator.ts:44` 已改为毫秒制）——此前所有记忆被算作"两万天前"导致过滤失效、上下文无界增长
2. **仍存在**：system prompt、历史、roster、patient context 各自独立限流，无总预算校验；工具循环每轮追加消息不检查总长度

**建议**：
1. 组装 `messages` 后做一次总 token 估算，超限按优先级裁剪
2. 工具输出截断（如 2000 字符）
3. `filterFacts`/`filterKnowledge` 加硬性 token 上限（如事实总数上限 50 条）

### 3.5 硬编码 API Key 兜底（高-安全）

**现状**：`llm.ts:250` `getApiKey()` 在环境变量缺失时返回写死的 `sk-edc3839a...`。

**建议**：删除 fallback；缺 key 时抛 `config_missing` 并给友好错误。密钥入源码是安全风险，且掩盖部署配置错误。

---

## 四、P2：临床可靠性（领域正确性）

### 4.1 Quick-scan 错挂患者 + AI 错误文本写入病历（高）

**现状**（`patients.router.ts`）：
1. `appendChiefComplaint` 无条件取"最新患者"（`orderBy createdAt desc take 1`），quick-scan 未绑定 `patientHash`——多患者时扫描结果写入错误患者档案
2. AI 超时/失败时 `'Vision analysis timeout'` 被持久化进 `chiefComplaint`——系统错误被当作临床发现

**建议**：
1. quick-scan 请求必须携带 `patientHash` 并做归属校验（属于当前 userId）
2. AI 失败文本只记 telemetry，不进病历字段
3. 超时用 AbortController（当前 `Promise.race` 超时后底层请求仍在跑）

### 4.2 事实提取缺"不确定"标记与校验（中）

**现状**：所有提案统一 `confidence: 'medium'`；category 只查 truthy 不校验白名单；无日期/数值校验；无长度上限。

**建议**：
1. FactNode 增加 `uncertain: boolean`（confidence < 0.6 自动标记）
2. category/sourceType 白名单校验
3. label 截断（300 字符）；对提取时间做格式校验

### 4.3 临床依据不可追溯（中）

**现状**：fact 的 confidence/source/provenance 在检索→上下文→回答链路中全部丢失；LLM 与用户无法区分"高置信有出处"与"AI 猜的"记忆。

**建议**：定义贯穿检索到回答的标准 `EvidenceItem { content, sourceKind, sourceRef, confidence, score }`，在 projection/compressor/tool 输出中保留，提示词要求 LLM 引用时带 `[confidence, source]`。

### 4.4 记忆合并丢失趋势数据（中）

**现状**：`deduplicateFindings` 按 key 合并时只保留第一条（如 "BP 140/90" 与 "BP 120/80" 合并后仅存其一）；`rrf-fusion` 以内容前 80 字符做去重键，不同事实可能被合并。

**建议**：
1. 合并仅针对同实体且保留所有数值（`key: v1 → v2`）
2. RRF 去重键改用 stableId/sourceId

### 4.5 ChatIngester 绕过审批队列直接写库（中）

**现状**：orchestrator 路径走 `gateway.propose()`（pending review + 去重），但 `/api/v1/memorization/ingest` 直接 `memory.addFact('system')`——绕过评审与去重，重复 ingest 累积重复事实。

**建议**：ChatIngester 也改走 `gateway.propose()`；`addFact` 增加 contentHash 查重。

---

## 五、P3：结构优化（设计模式）

### 5.1 MemoryGraphGateway 拆分（539 行）

**原则**：先拆内部，不动外部契约——调用方仍用 `gateway` 门面，接口不变。

**目标结构**：

```
memory/
├── gateway.ts                  ← 纯编排（~80 行）
├── proposal/
│   ├── proposal.service.ts     ← propose/listPending/applyApproved/reject/markApproved
│   └── proposal.dedup.ts       ← 语义去重（0.95 阈值、scope 过滤）
├── embedding/
│   ├── embedding.service.ts    ← 懒加载 + embedder + embedOrNull（顺带修并发覆盖）
│   └── embedding-index.ts      ← 现有类（不动）
├── context/
│   ├── context-assembler.ts    ← readContext / isolatePatientFacts
│   ├── persona.ts              ← buildPersona
│   └── patient-context.ts      ← buildPatientContext
├── summary/
│   └── session-summarizer.ts   ← summarize + LLM 降级
└── registry.ts                 ← 现有 registerContextResolver / ProposalApplier（已修好，保持）
```

**迁移顺序**：embedding（最独立）→ proposal（先补测试）→ context/persona（纯函数化）→ summary（带上降级修复）。每步跑 vitest 保持全绿。

**拆分收益**：embedding 并发覆盖、summarize 无降级、遥测缺失三个问题顺带消失；后续新功能变成新增文件而非修改大类的局部。

### 5.2 ChatOrchestrator 拆分 + 双管线收敛（601 行）

**现状**：
1. `orchestrator.turn()` 是死代码（无调用方），chat.router 里另有一套重复流程——双管线必然后续漂移
2. 单类职责过载：路由筛选、记忆过滤、fact 提案、增量提取调度（模块级 Map + 定时器，有内存泄漏风险）、gap 检测、summary、遥测

**建议**：
1. **删除 `turn()` 死代码**，知识命令处理收敛到 `knowledge-command-handler` 单一模块
2. 拆出：
   - `IncrementalExtractor`（调度 + 游标，pendingExtractions 挂到 UserContext 上并随 evict 清理）
   - `FactProposer`（proposal 构建）
   - `GapDetector`（gap 创建 + 去重）
3. `orchestrator.memory` 改为构造器注入，消除 `this.memory!` 与 `(this as any).memory`

### 5.3 依赖注入一致性

**现状**：混合了构造器注入（gateway）、模块级注册表（resolver/applier）、`null as any`（knowledge-synthesis.ts:120）。

**建议**：统一为构造器注入 + 按 userId 的注册表（Map），消除 `null as any`；注册表保持"注册一次 + 按 key 查找"模式。

### 5.4 重复代码收敛

**现状**：
- `estimateTokens` 在 context-compressor 与 memory-projection 重复实现
- 注意力排序两套基准不一致（createdAt vs lastSeenAt）
- persona 构建在 gateway 与 user-context 重复

**建议**：抽取 `common/attention.ts`、`common/token-estimate.ts`、`common/persona.ts`，统一基准并加单测。

### 5.5 可观测性

**现状**：全库 console.log 非结构化；embedding 调用零遥测；降级路径（embedding 不可用/摘要跳过）无指标。

**建议**：
1. 统一结构化 logger（JSON + 级别 + requestId）
2. 关键路径加 performance.now() 耗时与 success/failure 计数
3. 每个降级路径对应一个 counter（含原因维度），用于 SLO 告警

### 5.6 性能项（低优先级，规模上来后再做）

- 每次 commit 全量快照写盘 + 版本历史无界增长 → 分片/增量存储 + 定期 compact
- 同步 fs 写阻塞事件循环 → 异步写 + 队列化
- 循环内 O(N) 查找（`getLatestByStableId`）→ 按 stableId 建内存索引 Map
- `SearchNodeTool` fallback 全量 JSON.stringify 扫描 → 预构建 inverted index
- `routeCache` 无界增长 → LRU 或定期清扫

---

## 六、优先级路线图

| 阶段 | 内容 | 预期效果 |
|---|---|---|
| 第一阶段（发布前必做） | 3.5 删硬编码 key；4.1 quick-scan 患者绑定 + 错误文本隔离；3.1 LLM 超时重试 | 安全 + 临床数据正确性 + 医生可见稳定性 |
| 第二阶段（医生试用第一周） | 2.1 curation 落盘；2.2 superseded 过滤；2.5 游标修复；3.2 SSE 清理；3.4 总 token 预算 | 记忆不丢、不复活；对话不莫名失败 |
| 第三阶段（试用稳定后） | 4.2 不确定标记；4.3 临床溯源；5.1 gateway 拆分；5.2 双管线收敛 | 临床可信度 + 可维护性 |
| 第四阶段（长期） | 5.3-5.6 DI 统一、重复收敛、可观测性、性能 | 工程债清偿 |

---

## 七、验证方式

- 每个修复必须带测试：数据一致性类 → 模拟重启验证不复活；SSE 类 → 模拟客户端断开；并发类 → 双用户/双请求测试
- 医生试用期间：记录每个"异常现象"（报错、记忆不对、患者错乱），按本清单归类，反查根因
- 每 2-4 周做一次结构性审查，对照本文档更新状态

---

## 八、回归测试优化建议

### 8.1 当前测试体系评估

**现状**：66 个测试文件、424 个测试、59 个文件全绿。

**做得好的**：
- 覆盖广，文件按模块命名清晰（memory/retrieval/chat/evolution/patients 各有对应）
- 有真实集成测试（`e2e-full.spec.ts`、`approve-repro.test.ts` 走 HTTP）
- 关键修复都带测试（多用户隔离、矛盾检测、工具持久化）
- 测试命名反映用户故事（`session-close`、`episode-isolation`）

**结构性问题**：
1. **`full-coverage.test.ts` 与 `gap-coverage.test.ts` 是"补丁式"测试**——按"缺什么补什么"堆积，非按领域组织；新测试不知该放哪，失败时难定位
2. **测试依赖真实 LLM/embedding**——10+ 文件引用 `DEEPSEEK_API` 环境变量，CI 无 key 或网络波动时测试飘
3. **无单元/集成/E2E 分层**——全部混在一起跑，本地反馈慢，CI 慢
4. **setup 隔离策略不明**——`setup.ts`/`setup-cleanup.ts`/`globalSetup.ts` 三者关系与数据隔离方式无文档

### 8.2 建议的调整

**1. 补丁式测试重组（结构）**
- 把 `full-coverage.test.ts` / `gap-coverage.test.ts` 的用例按领域拆回对应模块文件
- 原则：**每个测试文件 = 一个模块的行为契约**，而非"覆盖率的碎布"
- 新代码进来时开发者知道测试放哪；失败时定位到模块

**2. 三层测试目录（最重要）**
```
tests/unit/        ← 纯逻辑：query-router、context-compressor、rrf-fusion、dedup（无 IO，秒级）
tests/integration/ ← 有 DB/文件 IO：memory、evolution、proposal 流程
tests/e2e/         ← 完整 HTTP：现有 e2e-full.spec.ts
```
- CI：unit 快速 job + integration/e2e 单独 job
- 本地：`vitest run tests/unit` 即时反馈

**3. 消除对真实 LLM/embedding 的依赖（可靠性）**
- 测试用注入的 mock provider（`ai-provider.ts` 已有抽象层，替换为固定返回的 mock）
- 保留 1-2 个真实调用测试，标 `it.skipIf(!process.env.DEEPSEEK_API_KEY)`，手动跑，不进 CI 必跑路径

**4. 补"数据一致性"回归测试（与 P0 对应）**
| 场景 | 对应问题 | 断言 |
|---|---|---|
| 重启不复活 | 2.1 curation 不落盘 | 编辑/删除 → 重载 store → stale 状态保留 |
| superseded 不进检索 | 2.2 索引不同步 | 删除事实 → retrieve → 不命中 |
| 双写一致性 | 2.3 无事务 | 双写注入失败 → 无部分写入 |
| 游标跨会话 | 2.5 漏提 | 两会话交叉事件 → 都提取 |
| quick-scan 患者绑定 | 4.1 错挂患者 | 两患者 → 扫描 → 写入正确的患者 |

建议新建单一文件 `tests/memory-consistency.test.ts` 覆盖上述场景。

**5. 医生真实路径 E2E（价值最高）**
现有 e2e 覆盖登录→聊天→知识库。补充一条**临床复诊路径**：
```
登录 → 建患者 A → 上传报告 → 对话 → 关闭会话 → 新会话 → 问"A 上次的情况"
断言：记忆正确恢复
```
这是医生留不留你的分水岭，值得一条专门的 E2E。

**6. 测试数据隔离**
- 确认是否每个测试文件独立临时目录（`TWIN_BASE_DIR` 隔离）
- 若共享，未来并行跑会互相污染——建议每测试独立 tmp dir + 结束清理

**7. 覆盖率门禁（可选）**
- vitest `--coverage` + thresholds（语句 >70%、分支 >60%）
- 更有意义的是"核心模块名单"（memory/retrieval 必须 100% 覆盖），而非全局阈值

### 8.3 优先级

| 优先级 | 事项 | 原因 |
|---|---|---|
| P0 | 数据一致性测试（8.2-4） | 对应代码最严重问题，先锁住 |
| P0 | mock LLM/embedding（8.2-3） | CI 稳定性，否则测试时好时坏 |
| P1 | 医生复诊 E2E（8.2-5） | 核心卖点的验证 |
| P1 | 三层目录重组（8.2-2） | 可维护性与开发效率 |
| P2 | 补丁测试拆回模块、隔离策略、覆盖率门禁 | 工程债 |

### 8.4 建议起点

先做 P0 两件事：
1. 新建 `tests/memory-consistency.test.ts`，覆盖 8.2-4 的 5 个场景
2. 在 `setup.ts` 加 `mockAiProvider()` 辅助函数，替换测试中的真实 provider 引用

---

## 九、领域抽象与通用化路径

> 目标：从"面向医生的临床 AI"演进为"面向知识工作者的通用记忆引擎"，临床成为第一个领域包。

### 9.1 现状盘点：哪些已通用、哪些绑死临床

**已通用（保留在 core）**：
- Memory Graph 核心（Fact/Article/Gap/Skill、版本化、级联传播）
- EventLog 事件溯源、per-user 记忆隔离、`.hma` 导出/导入
- 混合检索（语义 + 图 + RRF）、上下文压缩、审批流程
- 记忆生命周期（提取 → 待审 → 确认 → 演化）

**绑死临床（需要抽象到 domain pack）**：

| 绑定项 | 现状 | 抽象方向 |
|---|---|---|
| 领域模型 | `patientHash`、`studyId`、`MedicalRecordEntry` | 泛化为 `entityId` + 可扩展属性 |
| 内容类型 | DICOM、影像、化验报告、PHI | `ContentType` 注册表（已有 analyzer-registry 雏形） |
| 用户故事 | 肿瘤研究者 | 抽象为"知识工作者"角色 |
| Prompt | 临床提取/分析 prompt | `domain-pack/<industry>/prompts.ts` |
| 合规 | PHI、医疗数据保护 | 可配置的 `CompliancePolicy` 接口 |

### 9.2 抽象策略：领域插件化（推荐方案 A）

```
heurion-core/               ← 通用记忆引擎（零医疗知识）
  domain-packs/
    clinical/               ← 现有临床逻辑全部收进来（DICOM、影像、prompt、实体）
    legal/                  ← 未来：案卷、法条、当事人
    research/               ← 未来：文献、实验、数据
    enterprise-kb/          ← 未来：文档、项目、团队知识
```

- 核心引擎不含任何行业知识；行业只存在于 `domain-packs/*`
- 新行业 = 新增 pack，核心零改动
- **验证标准**："如果明天做个法律版，我要改哪几个文件？"——理想答案：只新增 `domain-packs/legal/`，核心不动

**不推荐**：先做通用版再做临床（脱离场景的抽象是空壳）；双产品线并行（资源不够）。

### 9.3 抽象步骤（按顺序）

1. **术语与模型抽象（最先做）**
   - `patientHash/studyId` → `scope: { entityId, entityType, meta }`
   - DB 加 `domain` 字段，现有表结构保持兼容
   - 提取器/检索器按 `entityType` 路由

2. **内容类型插件化**
   - 现有 `analyzer-registry.ts` 泛化为 `ContentTypeRegistry`
   - 新行业 = 注册新 analyzer + 新 domain prompt

3. **Prompt 包与领域配置**
   - 临床 prompt 抽成 `domain-packs/clinical/prompts.ts`
   - 核心只调 `domainPack.getExtractionPrompt(scope)` 类接口
   - 每 pack 独立配置（实体白名单、分类白名单、置信度阈值）

4. **UI 层按领域驱动（最贵，放最后）**
   - 现有"患者/病历/影像"硬编码页面抽象为"实体详情页"框架
   - 领域包提供字段定义与卡片组件
   - **先用后端 API 验证通用性，UI 等第二个客户再说**

5. **合规策略可配置**
   - 抽象 `CompliancePolicy` 接口：数据驻留、字段脱敏、审计级别、导出控制
   - 临床 = PHI 保护；法律 = 保密等级；企业 KB = 权限分级

### 9.4 战略原则

- **不需要"先做通用版"**——在临床里守住抽象边界即可
- 每次写新临床功能时问自己："这行代码换一个行业还需要吗？"——不需要进 domain-pack，需要进 core
- 每次重构把"临床特有"往 domain-pack 推一层
- 抽象工作让临床版更稳定（模块边界清晰），不与医生价值冲突

### 9.5 里程碑建议

| 阶段 | 动作 | 验证 |
|---|---|---|
| 近期 | 术语/模型抽象（scope 泛化） | 临床功能回归全绿 |
| 中期 | ContentTypeRegistry 泛化 + prompt 包化 | 抽出 1 个非临床 demo pack 跑通 |
| 后期 | CompliancePolicy 接口 | 第二个行业客户试点 |
| 远期 | UI 领域化 | 多行业共存 |

---

## 十、前端聊天渲染演进路径

> 目标：解决流式渲染稳定性与气泡外观交互，同时保留现有的产品级消息模型

### 10.1 当前实现盘点

**技术栈**：
- `stores/chat.ts`（307 行）：zustand 状态管理 + 手写 SSE 消费（`for await` + AbortController + 竞态比对）
- `routes/chat.tsx`（560 行）：消息列表、气泡、工具调用展示
- `MarkdownRenderer.tsx` + `LlmContent.tsx`：react-markdown 渲染（含表格恢复、流式 Markdown）
- `ToolCalls.tsx`：工具调用展示
- 附加：compaction 指示、上下文用量指示、下载按钮、知识库按钮、富文本粘贴处理

**消息模型已产品级**：`ChatMessage` 支持七种扩展字段——`reasoning / tier / citations / download / knowledgePayload / toolCalls / chart`。这不是普通聊天渲染，是完整产品功能面。

### 10.2 方案评估

| 方案 | 优势 | 劣势 | 改造成本 |
|---|---|---|---|
| **Vercel AI SDK `useChat`** | 成熟的流式状态机（中断/重试/竞态/错误）；不锁 UI，气泡与 Markdown 全自控 | 七种扩展字段需走 `data` 通道并做序列化映射 | 中（2-3 天） |
| @chatscope/chat-ui-kit-react | 气泡/头像/打字指示器开箱即用 | 消息模型封闭，扩展字段须塞 `CustomContent`，数据层重写；客服风与医疗气质不符 | 高 |
| shadcn/ui 风格自建气泡 | Tailwind 生态匹配，代码自持 | 只解决外观，流式状态管理仍要自己写 | 低-中 |
| 保持现状 + 局部增强 | 零成本，现有 80% 覆盖且有测试 | 流式稳定性痛点未根治 | 零 |

### 10.3 推荐路线（组合方案）

**方案 1（Vercel AI SDK）+ 方案 4（局部增强）**：

1. **流式稳定性** → `stores/chat.ts` 的 SSE 消费层替换为 `useChat`（`onFinish`/`onError`/`stop` 接管）
2. **数据模型适配** → 七种扩展字段走 `data` 通道，写 `parseCustomData` 映射层（唯一需要小心测试的部分）
3. **保留现有渲染** → `MarkdownRenderer`、`ToolCalls`、`LlmContent` 全部不动（已有测试覆盖）
4. **交互增强** → 重新生成按钮、错误重试、流式光标、气泡时间戳分组

**为什么不用 chatscope**：现有数据模型太丰富，chatscope 的封闭模型会逼着重写数据层，代价远大于收益。

### 10.4 重要前置条件

**前端换 AI SDK 前，必须先修后端 SSE 可靠性**（本文件 3.1/3.2）：
- 3.1 LLM 无超时重试 → 失败频繁发生，前端再优雅也是频繁报错
- 3.2 SSE 无 abort 清理 → 客户端断开后 LLM 继续烧 token

前端 AI SDK 是"更优雅地处理失败"，后端修复才是"失败本身不常发生"。顺序：先后端（几天）→ 再前端（2-3 天）。

### 10.5 实施里程碑

| 阶段 | 动作 | 验证 |
|---|---|---|
| 前置 | 后端 3.1（超时重试）+ 3.2（SSE 清理） | 断流不再烧 token；失败有友好文案 |
| 第一步 | `useChat` 替换 SSE 消费层 | 流中断/重试行为正确 |
| 第二步 | `data` 通道映射七种扩展字段 | 七字段往返序列化测试通过 |
| 第三步 | 交互增强（重生成/重试/光标/分组） | 医生试用反馈 |
| 保留项 | MarkdownRenderer/ToolCalls 不动 | 现有测试保持全绿 |

---

## 十一、UI 设计语言（Logo 驱动主题重构）

> 目标：以 Heurion logo 的视觉母题为锚点，重构 UI 主题。现有颜色已与 logo 同源，重构的本质是"把 logo 的母题贯彻成全站的设计语言"。

### 11.1 Logo 视觉母题拆解

| 元素 | 特征 | 设计语言含义 |
|---|---|---|
| H 图标（两根圆角竖条） | `rx=9` 圆角矩形 | 圆润、稳定、模块化 |
| 强调横条 + 左上圆点 | 天蓝 `#0EA5E9` | 连接 + 高亮 + 状态点 |
| 主色 | 深蓝灰 `#0F172A` | 稳重、专业、可信 |
| 强调色 | 天蓝 `#0EA5E9`（sky-500） | 科技、活力、聚焦 |
| 副文字 | 灰 `#475569` / `#CBD5E1` | 克制、次级信息 |
| 字体 | 系统无衬线 + 大字距（2-3px） | 现代、清晰、留白感 |
| 整体气质 | 圆角矩形 + 克制蓝 + 纯平面 | "专业但不冰冷"的临床科技感 |

### 11.2 五条设计原则

1. **蓝色稀缺**：蓝色只用于"当前状态、主行动、焦点、重要高亮"，其余保持中性。蓝色越少，聚焦越强
2. **圆角成语言**：全站统一圆角尺度（12-16px 的专业圆润），不用 `rounded-full` 的消费级胶囊
3. **纯平分层**：靠色阶区分层级，不靠阴影；阴影只留给浮层（对话框、下拉），卡片不用投影
4. **系统字体 + 字距**：不换字体，用字距（tracking）呼应 logo 排版气质，定义清晰字号层级
5. **状态点语言**：把 logo 左上角"亮起的圆点"变成全站状态语言（在线/思考/待审/进行中）

### 11.3 设计令牌层

**颜色**（现有已对齐 logo，扩展语义色板）：
```
新增临床语义色：
  --clinical-confirmed: 绿（保留 success）
  --clinical-pending:    琥珀（保留 warning）
  --clinical-low-conf:   灰蓝（新增——低置信度事实的呈现色）
  --clinical-alert:      红（保留 error）
  --data-accent:         sky（强调色复用）

新增圆角语言：
  --radius-sm: 8px    输入框、小按钮
  --radius-md: 12px   卡片、聊天气泡
  --radius-lg: 16px   大面板、对话框
  --radius-full: 999px 标签、状态点（仅小元素）

新增排版层级：
  --text-display / --text-title / --text-body / --text-caption
  --tracking-wide 用于标题（呼应 logo 字距）
```

### 11.4 组件层

**StatusDot（logo 圆点母题，最有识别度的组件）**
- AI 思考时的"呼吸圆点"、记忆待审的"待确认点"、导航当前页"指示点"、任务进行中"活动点"
- 静止时是 logo 圆点，活动时呼吸——把品牌变成交互语言

**聊天气泡（最高频组件）**
- 圆角 `--radius-md`（12px），用户/医生气泡分色但同圆角
- 消息内分层：主回答（Markdown）→ reasoning（折叠块，默认收起）→ citations（可点击跳转原文）→ toolCalls（时间线式呈现）→ 操作栏（下载/知识库/图表，hover 收纳）
- 流式光标：呼吸点 + 打字状态

**按钮/输入/卡片**
- 主行动蓝、次行动中性；按钮圆角 12px 不用 full 胶囊
- 卡片无阴影、1px 细边框、靠色阶分层

### 11.5 页面层

**今日工作台（默认着陆页，最重要的产品性改进）**
- 医生登录后第一屏不是聊天，而是聚合视图：今日待审记忆、待处理患者、最近知识更新、快捷入口
- "医生打开产品 5 秒内知道现在该做什么"——从"功能集合"到"产品"的分水岭
- 已有 `today.tsx`，强化为默认着陆页

**导航信息架构**（按医生工作流分组，非功能平铺）
- 今日概览 / 患者工作区（患者、病历、影像、化验）/ 记忆与知识（Brain、记忆图谱、知识库）/ 工具与设置（插件、文档、设置、日志）
- 当前页指示用 StatusDot 圆点

**空状态与加载（信任感关键）**
- 每个页面有引导式空状态（非空白）
- 加载用骨架屏而非 spinner
- 错误状态：图标 + 文案 + 重试按钮

**数据可视化**
- 记忆图谱（memory-graph-viz）是差异化亮点，评估换用成熟图库（reactflow 等）
- 报告页、影像页保持专业组件

### 11.6 实施路线

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 第一步 | 令牌层：圆角语言 + 语义色板 + 排版层级 | 1 天 |
| 第二步 | StatusDot 组件 + 全局替换圆角/阴影纪律 | 1-2 天 |
| 第三步 | 聊天页交互层级（reasoning 折叠、citations 可点、toolCalls 时间线） | 2-3 天 |
| 第四步 | 今日工作台强化为着陆页 + 导航分组 | 2 天 |
| 第五步 | 空状态/骨架屏/错误态统一 | 1-2 天 |
| 第六步 | 图谱可视化、可访问性打磨 | 持续 |

**核心原则**：主题颜色已与 logo 同源，重构本质是把 logo 的母题（圆角矩形、克制蓝、状态点、纯平面、字距）贯彻成全站设计语言，并完成从"功能集合"到"临床工作台"的信息架构升级。


---

---

## 十二、数据层演进（DB 与应用分离 → 可扩展数据库）

> 目标：当前 SQLite + 文件存储混在同一 `/data` 卷、与应用同机，逐步演进为"应用、数据库、文件存储"三者分离、可独立扩展、可迁移到自托管 Postgres 的架构。

### 12.1 当前数据存储全貌

| 存储 | 内容 | 位置 | 问题 |
|---|---|---|---|
| SQLite（Prisma） | 用户、会话、患者、文档、审批、插件等结构化数据 | `nexus-data` 卷（`/data/nexus_server.db`） | 单机、无扩展性 |
| 文件存储（TWIN_BASE_DIR=/data） | EventLog、Memory Graph（版本化 JSON）、legacy facts、embedding 索引、工具输出、上传文件 | 同一 `/data` 卷 | 与 SQLite 混在同一卷 |
| S3（worker） | 渲染产物（DOCX/PPTX/PNG）、插件输出 | 外部 S3 | 已是独立存储 ✅ |

**核心问题**：`nexus-data` 卷把 SQLite + 文件存储混在一起、与应用同机——无法独立扩展、无法故障隔离、备份是全卷拷贝。

### 12.2 目标架构（三阶段演进）

**阶段 1：数据库与应用分离（SQLite 独立卷）**：SQLite 移到独立卷 `nexus-db`；纯运维改动（docker-compose + 路径），不动代码。获得：备份粒度分开、故障隔离、为 Postgres 铺路。

**阶段 2：文件存储与 DB 分离**：`/data` 拆分：`/data/db`（SQLite，卷 `nexus-db`）+ `/data/twins`（EventLog/Memory Graph/embedding，卷 `nexus-files`）。备份：DB 每日，文件低频。

**阶段 3：迁移到自托管 PostgreSQL（长期）**：**决策：Postgres 自托管（Docker 独立机器/卷），不用托管服务**——避免与单一云厂商绑定，保持可迁移性。Prisma `provider = "sqlite"` → `"postgresql"`；Memory Graph 从 JSON 文件 → Postgres 表（EventLog 追加型保留文件）。

### 12.3 关键决策

1. **先阶段 1 再阶段 3**：Prisma schema 是 SQLite 写法，直接切 Postgres 需改 schema，风险大
2. **Postgres 自托管**：Docker Postgres + 独立卷 + 定期备份；不依赖托管服务，厂商中立
3. **EventLog 保留文件**：追加型 JSONL 天然适合文件；Memory Graph 规模上来后迁 Postgres（全量快照写盘有性能问题，见 #199）

### 12.4 迁移计划

**阶段 1（1-2 天，纯运维）**：停服务 → 建 nexus-db 卷 → 拷贝 DB → 改 docker-compose（DATABASE_URL=file:/data/db/...，TWIN_BASE_DIR=/data/twins）→ 启动验证

**阶段 2（1 天）**：/data/twins 独立卷 + 备份策略分化

**阶段 3（3-5 天，依赖重构完成）**：Prisma schema 改 postgresql → 数据迁移脚本（逐表）→ Memory Graph 迁移评估 → 切 DATABASE_URL → 灰度 → 回滚预案

### 12.5 风险与回滚

| 风险 | 缓解 |
|---|---|
| SQLite → Postgres 类型不兼容 | 小表先试迁移，逐表验证 |
| 迁移中数据丢失 | 迁移前全量备份 + 脚本可重放 |
| 文件存储路径变化 | 保留旧路径软链，灰度切换 |
| 双写不一致 | 阶段 1/2 不动 schema 只动路径，风险低 |

### 12.6 建议顺序

阶段 1（当前优先，纯运维 1 天）→ 阶段 2（1 天）→ 阶段 3（重构完成后，不与功能重构并行）

**关联 issues**：#280（阶段 1）、#281（阶段 2）、#282（阶段 3）

### 12.7 数据备份设计（定期备份到对象存储）

> 目标：DB 与文件存储定期备份到对象存储，实现异地冗余、可恢复。

#### 12.7.1 备份对象与频率

| 数据 | 内容 | 频率 | 保留 |
|---|---|---|---|
| SQLite DB | nexus_server.db | 每日 | 30 天 |
| EventLog | event_log.jsonl（追加型，记忆真相源） | 每日 | 30 天 |
| Memory Graph | 版本化 JSON（v*.json + _current.json） | 每日 | 30 天 |
| 用户文件 | uploads/（病历/影像/工具输出） | 每周 | 8 周 |
| embedding 索引 | embedding-index.jsonl | 可跳过（可由 EventLog 重建） | - |

**注意**：SQLite 备份用 `sqlite3 .backup` API（一致性），不用 cp 热拷贝（防 WAL 损坏）。

#### 12.7.2 目标存储（对象存储）

- **选型：DigitalOcean Spaces（当前）**——与 worker 已有 S3 配置一致，零新接入成本；S3 兼容接口，后续可加 MinIO/B2/AWS（换端点即可）
- **桶结构**：`heurion-backups/` → `db/`（每日）+ `files/`（每周）
- **生命周期策略**：S3 生命周期规则自动清理过期备份（DB 30 天、文件 8 周）

#### 12.7.3 备份执行（独立容器 + cron）

```
docker-compose 新增服务：nexus-backup
  image: 自建备份镜像（sqlite3 + rclone + cron）
  volumes: 只读挂载 nexus-db + nexus-files
  env: S3_ENDPOINT（DigitalOcean Spaces）/ S3_BUCKET / S3_ACCESS_KEY / S3_SECRET
  cron: 每日 02:00 备份 DB+EventLog+Graph；每周日 02:30 备份 files
```

每日脚本：`sqlite3 .backup` → gzip → rclone 上传 → 清理本地临时
每周脚本：uploads tar → rclone 上传

#### 12.7.4 恢复流程（RTO/RPO）

| 场景 | RPO | RTO | 恢复动作 |
|---|---|---|---|
| DB 损坏/误删 | 当日 | ~30 分钟 | 拉取最新 db 备份 → 解压 → 挂载 → 重启 |
| 全盘丢失（VPS 重建） | 当日 | ~2 小时 | 重建 VPS → 部署 compose → 拉取 db+files 备份 → 恢复 |
| 用户文件误删 | 周级 | ~1 小时 | 拉取对应周 files 备份 |

**恢复验证**：每月一次恢复演练（从备份重建临时环境，验证数据可用）

#### 12.7.5 关键决策

1. 备份容器独立于应用（应用故障不影响备份；只读挂载）
2. **对象存储：DigitalOcean Spaces 起步，S3 兼容接口保持厂商中立**（后续可换 MinIO/B2/AWS）
3. SQLite 用 `.backup` API 而非 cp
4. 本地临时备份落盘后上传、随即清理

#### 12.7.6 实施步骤

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | 备份镜像（sqlite3 + rclone + cron）+ docker-compose 服务 | 1 天 |
| 2 | 每日备份脚本（DB + EventLog + Graph） | 半天 |
| 3 | 每周备份脚本（files） | 半天 |
| 4 | DO Spaces 桶 + 生命周期策略（30 天/8 周） | 半天 |
| 5 | 恢复演练（月度）+ 恢复文档 | 半天 |

**总量级：3 天**

**关联 issues**：#290（备份实现，依赖 #280 DB 独立卷）；与 #282（Postgres）配套——迁移后备份改 pg_dump

---

## 十三、用户认证体系升级（邮箱验证 + 手机可选）

> 目标：支持用户用邮箱（验证码验证）或手机（仅存储字段）作为登录标识，支持找回密码；存量用户零破坏、渐进式绑定。**简化决策：手机不做验证码、不接 SMS 服务；只有邮箱发送一个外部依赖（Resend）。**

### 13.1 现状

- 注册：username + password（displayName 即用户名，DB 无 unique 约束）
- 登录：仅用户名+密码；无邮箱验证、无找回密码
- email 字段存在但注册时从不填写（存量全为 NULL）

### 13.2 数据模型

```prisma
model User {
  id              String    @id
  displayName     String    @map("display_name")
  passwordHash    String?   @map("password_hash")
  email           String?   @unique        // 新增 unique
  emailVerified   Boolean   @default(false) @map("email_verified")
  phone           String?   @unique        // 仅存储，无 verified 标记
}

model VerificationCode {           // 新表（仅邮箱用）
  id        String   @id
  userId    String?  @map("user_id")
  target    String                     // email
  code      String
  purpose   String                     // 'register' | 'bind' | 'reset_password'
  expiresAt String   @map("expires_at")
  usedAt    String?  @map("used_at")
  attempts  Int      @default(0)
  createdAt String   @map("created_at")
  @@index([target, purpose])
  @@map("verification_codes")
}
```

### 13.3 流程设计

**注册**：填写邮箱+密码（可选手机）→ send-code（邮箱）→ register（邮箱+code+密码，可带 phone）→ 校验 → 创建用户（emailVerified）→ jwt_token

**绑定**：bind-email（send-code → 校验 → verified）；bind-phone（直接保存，无验证）

**登录**：identifier = email OR phone OR displayName

**找回密码**（仅邮箱）：send-code（reset_password）→ reset-password（code + new_password）→ 旧 token 失效

### 13.4 验证码机制（仅邮箱）

6 位数字、10 分钟有效、60s 限流、5 次尝试、一次性、同 IP 注册限流（1 小时 5 次）

### 13.5 发送渠道

- 邮箱：**Resend**（送达率高、免费 3000 封/月、不绑云厂商；验证码邮件最怕进垃圾箱）
- 手机：无外部依赖（仅存储字段）

### 13.6 存量用户处理（零破坏、渐进式）

1. username 登录完全保留；identifier 查找是兼容扩展
2. 首次登录非阻塞提示"绑定邮箱？"——可跳过
3. 设置页常驻绑定入口
4. username 是邮箱格式（user@gmail.com）——identifier 查找天然覆盖
5. 迁移：清重复 displayName → 加 unique → email/phone unique（存量 NULL 不冲突）→ 建 verification_codes

### 13.7 API 汇总

| Method | Path | 说明 |
|---|---|---|
| POST | /api/v1/auth/send-code | 发送邮箱验证码 |
| POST | /api/v1/auth/register | 注册（邮箱+code+密码，可带 phone） |
| POST | /api/v1/auth/bind-email | 绑定邮箱（验证码） |
| POST | /api/v1/auth/bind-phone | 绑定手机（直接保存） |
| POST | /api/v1/auth/login | 登录（identifier 多标识） |
| POST | /api/v1/auth/reset-password | 找回密码（仅邮箱） |

### 13.8 实施顺序与风险

数据模型（半天）→ 验证码服务（半天）→ Resend 接入（半天）→ 注册改造（1 天）→ 绑定+登录兼容（半天）→ 找回密码（半天）。**总量级 3-4 天。建议排在医生试用稳定后**（auth 改造动核心用户表）。

**关联 issues**：#284（数据模型）→ #283（认证功能）→ #285（存量绑定）

---

## 十四、多 Agent 架构设计（参考 Cloudflare OS Spawner 模型）

> 目标：从"单 agent + delegate 工具"演进为"主 agent 按需派生子 agent（spawner 模式）"，子 agent 带受限工具集与独立上下文。参考 Cloudflare OS 的 spawnAgent/AgentSelfLoopback 实现（2026-08 开源）。

### 14.1 现状与差距

**当前 DelegateTool（subagent-tools.ts，46 行）**：本质是"调 LLM 的函数"——子 agent 无工具访问权、无独立上下文、无权限隔离、无状态、技能参数是摆设。

**Cloudflare OS Spawner 模型**：主 agent spawnAgent → 新 chat thread（独立 DO），env bindings = spawner 配置快照（权限隔离）、独立上下文、完整工具能力、callable stub（函数式调用）。

### 14.2 目标架构（适配 Heurion：Node.js + SQLite + 事件溯源）

```
主 agent（现有 chat 循环，chat.router）
  工具集：现有工具 + spawn_subagent（新）
    │ spawn_subagent({ task, context, tools, scope })
    ▼
SubAgentSession（新，基于 EventLog + 独立循环）
  ├─ 独立会话记录（sub_session）
  ├─ 受限工具集：只注册 spawner 指定的工具
  ├─ 独立上下文：从 EventLog 投影（可指定 scope）
  ├─ 运行循环：LLM → 工具 → 观察 → 继续（≤N 轮）
  └─ 结构化返回（含成本/token/轮数）
    │ 结果回到主 chat（作为工具输出）
```

### 14.3 数据模型

```prisma
model SubAgentSession {
  id           String   @id
  userId       String   @map("user_id")
  parentChatId String   @map("parent_chat_id")
  task         String
  context      String?
  scope        String?                          // 权限范围（如 patientHash）
  allowedTools String   @map("allowed_tools")   // JSON 数组
  status       String   @default("running")     // running | done | error | cancelled
  turns        Int      @default(0)
  result       String?
  cost         Float?
  createdAt    String   @map("created_at")
  completedAt  String?  @map("completed_at")
  @@map("sub_agent_sessions")
}
```

### 14.4 工具接口

```ts
spawn_subagent: {
  task: string,            // 必填
  context: string,         // 可选
  tools: string[],         // 可选（默认只读工具集）
  scope: { patientHash?, studyId? },  // 可选权限范围
  max_turns: number,       // 可选，默认 5
}
```

**默认允许（安全基线）**：search_node、search_past_chats、web_search（全部只读）
**默认拒绝**：所有写操作（edit/approve/bind）——子 agent 只读，除非显式允许

### 14.5 权限隔离（借鉴 Gatekeeper 思想）

1. scope 过滤：spawner 传 scope → 子 agent memory 工具只返回该范围 facts
2. 工具白名单：未列出的工具不注册
3. 禁止嵌套：max_depth=1（子 agent 内不允许再 spawn）
4. 成本上限：独立 token 预算（如 8000），超限强制结束

### 14.6 运行机制（借鉴 deliverAgentCallback）

- **方案 A（同步，推荐起步）**：spawn_subagent 工具内 await 子 agent 循环，返回结果（受主 tool loop 5 轮限制）
- **方案 B（异步，后续）**：spawn 后返回 sub_session_id，主 agent 轮询结果（对应 Cloudflare pending callbacks）

### 14.7 实施步骤

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | SubAgentSession 表 + CRUD | 半天 |
| 2 | SubAgentRunner（独立工具注册 + 循环，复用 tool loop 逻辑） | 1-2 天 |
| 3 | spawn_subagent 工具（同步方案 A） | 半天 |
| 4 | scope 过滤（memory 工具按 scope 限定） | 半天 |
| 5 | 成本/轮数上限 + 结构化结果 | 半天 |
| 6 | 测试：单子 agent、权限隔离、成本上限 | 1 天 |

**总量级：4-5 天**

### 14.8 使用场景（医生视角）

1. 文献综述：spawn 子 agent "搜索 PubMed 关于 X 的最近文献"（只读 web_search）
2. 患者深度分析：spawn 子 agent "只读患者 A 记忆图谱，总结治疗历程"（scope=patientHash A）
3. 并行调研（后续方案 B）：同时 spawn 2-3 个子 agent，聚合结果

### 14.9 与现有架构的关系

复用 ToolRegistry、EventLog、LLM 客户端（llm.ts 含超时重试 #184）、telemetry；不改变主 chat 循环和记忆审批流程（子 agent 只读）；与 #219（domain-pack）协同（子 agent 工具集可由 domain pack 定义）。

### 14.10 风险与限制

| 风险 | 缓解 |
|---|---|
| 子 agent 递归/失控 | max_depth=1 + token 上限 + 轮数上限 |
| 越权数据 | scope 过滤 + 工具白名单 + 只读默认 |
| 成本失控 | 独立 token 预算 + telemetry 归因 |
| 主 chat 等待阻塞 | 方案 A 受 tool loop 限制；方案 B（异步）后续 |

### 14.11 多 Agent 使用场景（何时用）

**判断标准：单 agent 做不到才用**——多 agent 解决"上下文隔离 + 并行 + 权限"，不是"模型能力"。

| 场景 | 为什么单 agent 不够 | 示例 |
|---|---|---|
| 深度任务（>3 步独立探索） | 主 chat 上下文被中间过程污染 | 文献综述（搜→读→总结→整合） |
| 隔离任务（需权限边界） | 主 agent 不该碰所有数据 | 只读患者 A 记忆做深度分析 |
| 并行任务（互不依赖） | 串行太慢 | 同时调研 3 个主题 |
| 专业分工（不同领域知识） | 一个 prompt 装不下所有领域 | 临床 + 统计 + 文献 |

**不该用**：日常问答、简单记忆查询、单步工具调用——单 agent 就够，多 agent 浪费 token 和延迟。

### 14.12 触发决策（谁调用）

**原则：默认主 agent 自动判断，用户不感知"多 agent"概念。**

- **调用方 = 主 agent**（通过 spawn_subagent 工具），用户手动触发是例外
- 主 agent system prompt 规则："任务满足以下条件时使用 spawn_subagent：>3 步独立探索、需数据隔离、可并行拆解"
- 用户显式要求（"详细调研，多角度"）→ 主 agent 识别为可并行，主动拆解

**决策矩阵（主 agent 内部）**：
```
复杂度低           → 单 agent 直接做
深度高（>3 步）    → spawn 1 个深度子 agent（scope 隔离）
可并行             → spawn 2-3 个子 agent（不同 scope/主题）
混合领域           → spawn 多个专业子 agent
```

**反滥用**：prompt 明确"如果单线程能做好就不要 spawn"（延迟和成本是代价）。

### 14.13 结果汇总（反馈给用户）

**方案 A（同步聚合，起步）**：spawn 多个子 agent（并行）→ 各自返回结构化结果 {summary, cost, turns} → 主 agent 汇总成综合回答（带引用）→ 用户看到综合回答 + 分项卡片。

**方案 B（流式进度，中期）**：用户看到"正在并行分析 3 个方面…"→ 每完成一个更新进度 → 全部完成汇总。

**汇总呈现（对医生）**：
```
综合回答（主 agent 整合，带引用）
  ├─ [文献] 来自 5 篇 RCT（子 agent 1 检索）
  ├─ [统计] 生存分析曲线（子 agent 2 分析）
  └─ [临床] 与 NCCN 指南一致（子 agent 3 对照）
```

**衔接**：
- 子 agent 结果**默认不直接写记忆**（只读，§14.5）；要写走 propose → 人工审核
- 成本按 sub_session 归因（telemetry），用户可见
- 某子 agent 失败不影响其他，汇总标注"文献部分失败，其余正常"

**关联**：#219（domain-pack）、#105（审批/权限，可借鉴 Gatekeeper 读写分级）、#288（实现）

---

## 十五、插件与 Skills 生态战略

> 目标：Skills 走"内容生态"（医生/研究者产出经验），Plugins 走"集成生态"（开发者连接系统）；两者共享安全/权限底座，不合并。参考 Cloudflare OS 的开源实现（skill 库 + Gatekeeper/MCP）。

### 15.1 现状与区分

| 机制 | 当前实现 | 本质 |
|---|---|---|
| Skills | prompt 级能力（注入 system prompt）+ github-skills + ClawHub 集成（#65-70） | "知识/技能"——教 AI 怎么做（轻量） |
| Plugins | 运行时插件（注册 tools/connectors/UI 扩展）+ 目录/安装/审计/加密 | "能力/扩展"——给 AI 新工具（重量） |

**核心区分（不合并）**：
- Skills 创作者 = 医生/研究者（非程序员）——内容驱动、网络效应入口
- Plugins 创作者 = 开发者——工程驱动、集成护城河

### 15.2 Skills 方向：内容生态（近期优先）

**关键产品决策：Skill 捕获（capture）而非编辑器**（见 #68 修正）

- **医生心智**："我平时怎么做这件事" → 做一遍，让 AI 记住
- **零门槛流程**：正常对话 → AI 完成 → 提示"保存为技能？" → 一键保存 → 自然语言微调 → 预览 → 确认
- **医生全部操作** = 点保存 + 偶尔一句话
- **模板作为可选起点**（SOAP/出院小结/文献检索），不是"医生填的表单"

**演进路径**：
1. 对话中捕获 + 一键保存（近期，灯塔医生验证）
2. 自然语言微调 + 预览演示（近期）
3. SkillHub 共享（#67）——医生之间分享经验，网络效应
4. skill 关联记忆（Memory Graph）——"经验闭环"

### 15.3 Plugins 方向：集成生态（中期）

**关键决策：走 MCP 标准**（参考 Cloudflare OS Gatekeeper/MCP 模型）

- 对接外部系统（EHR/影像/检验）用 MCP 协议，不自研协议
- 受限连接器模式：插件默认零权限，能力绑定（env.PROJECT 式）
- 读写分级：只读立即执行、写操作排队审批（Gatekeeper 思想，关联 #105）

**演进路径**：
1. MCP 适配（插件对接外部系统的标准协议）
2. 医疗连接器优先：EHR、影像系统、检验系统
3. 开发者平台完善：manifest + 沙箱 + 审计（已有基础）

### 15.4 共享底座（不合并但同源）

- 同一个目录/市场 UI（一个页面两个 tab：技能/插件）
- 同一个权限模型（#105 allow/deny/ask——skill 和 plugin 都走）
- 同一个沙箱（plugin 执行沙箱；skill 的 prompt 注入也可审计）

### 15.5 实施优先级

| 优先级 | 做什么 | 为什么 |
|---|---|---|
| P0（近期） | #68 改为 Skill 捕获 + 一键保存 | 医生 5 分钟创建第一个 skill = 粘性验证 |
| P1（近期） | 自然语言微调 + 预览演示 | 让医生有掌控感 |
| P1（中期） | Plugins 走 MCP 标准 | 医疗集成生态的标准方向 |
| P1（中期） | SkillHub 共享（#67） | 网络效应入口 |
| P2（远期） | 医疗连接器（EHR/影像/检验） | 医疗集成护城河 |
| P2（远期） | ClawHub 外部生态（#65-70） | 用户量起来后再做 |

### 15.6 风险与提醒

1. **当前不要同时推两条线**（单人资源有限）——近期只推 Skills 捕获
2. 编辑器形态保留为"高级模式"（懂技术的用户），默认入口是捕获
3. 权限模型（#105）是两条线的共同底座，尽早做

**关联 issues**：#68（Skill 捕获）、#66/#67（parser/SkillHub）、#105（权限底座）、#106（load_skill）、#65-70（ClawHub 生态）

---

## 十六、设计模式深审（超出前述章节的结构性问题）

> 目标：前述章节解决"数据一致性/可靠性/结构拆分"；本节聚焦**更深层的设计模式问题**——模块级状态管理、上帝路由、错误契约、领域模型贫血等。所有项可渐进修复，不需推翻重来。

### 16.1 模块级可变全局状态

| 位置 | 状态 | 风险 |
|---|---|---|
| user-context.ts:25 | `contexts = new Map` | 有 GC，需确认 evict 彻底性 |
| user-context.ts:109 | `personaCache = new Map` | **无上限、无清理**——长期运行内存增长 |
| compaction.ts:206 | `inFlight = new Map` | 有 Promise 去重，需确认失败后清理 |
| memory/registry.ts:20-30 | contextResolver/proposalApplier | 已修（#130），保持 |

**建议**：封装统一 `StateRegistry`（LRU 上限 + 失效策略 + 生命周期钩子），替代散落的 Map；`inFlight` 在 Promise settle 后 `finally` 清理。

### 16.2 chat.router（964 行）仍是上帝路由

**问题**：单 HTTP handler 承担：路由分发、SSE 管理、事件追加、压缩摘要注入、上下文组装、LLM 调用、工具循环、错误处理。

**建议（Handler + 传输分离）**：`ChatSessionHandler`（编排）+ `SSETransport`（SSE 写/abort/heartbeat）+ `chat.router`（只做路由注册）。

### 16.3 memory.service（735 行）门面下仍是实现

**问题**：双存储同步 + 事件追加 + curation 传播全耦合在一个类（原子性已修 #231，结构未拆）。

**建议（Facade + 内部协作者）**：`MemoryService` 保留门面；内部拆 `GraphWriter` / `LegacyProjection` / `EventAppender` / `PropagationCoordinator`（写入顺序原子性由它负责，可独立测试）。

### 16.4 错误处理模式不统一

**问题**：混合三种风格——`{ok:false,error}`（工具层）、`null`（memory.service 部分方法）、抛异常（部分路径）。

**建议**：统一 `Result<T> = { ok: true, value: T } | { ok: false, error: string }` 贯穿服务层；`null` 返回语义不明确，统一为 Result。

### 16.5 依赖注入不彻底

**问题**：chat.router 通过 `getUserContext()` 服务定位器取依赖；部分构造器注入、部分运行时 `await import()`。

**建议**：收敛为"构造器注入 + 顶层组装"（app.ts 组装依赖）；动态 import 只保留给可选能力（LLM provider）。

### 16.6 领域模型贫血（Anemic Domain Model）

**问题**：MemoryNode/FactNode/ArticleNode 是纯数据容器，行为（版本化/supersede/propagation）全在 MemoryService——导致服务类膨胀。

**建议**（不完全 DDD，单人项目适度）：内聚行为上移（`FactNode.isSuperseded()`、`ArticleNode.isStale(depStatus)`），节点演化逻辑放回节点，服务只做编排。

### 16.7 测试缺"行为契约"层

**问题**：测试按模块组织，但缺"记忆写入→审批→检索→上下文→提示词"的跨模块契约测试。

**建议**：补一条"端到端行为契约"测试（不跑真实 LLM，纯模块间契约）。

### 16.8 Web 前端同样的结构问题

**问题**：routes/chat.tsx（560+ 行）+ stores/chat.ts（307 行）——UI 与状态逻辑边界模糊（store 里处理 applyChunk 渲染逻辑）。

**建议**：store 只做状态；`applyChunk` 提取为独立纯函数模块（可单测）——前后端统一"纯逻辑与 IO 分离"。

### 16.9 优先级

| 优先级 | 项 | 理由 |
|---|---|---|
| P0 | personaCache/inFlight 泄漏清理 | 长期运行内存问题 |
| P0 | 错误契约统一（Result 类型） | 影响所有服务层可测性 |
| P1 | chat.router 拆 Handler + SSE 传输 | 964 行继续膨胀风险 |
| P1 | 领域行为内聚（节点方法） | 减少服务类膨胀 |
| P2 | DI 收敛、行为契约测试、前端 store 纯化 | 工程债 |

---

## 十七、代码结构与 UI/UX 审视（2026-08-06 深夜）

> 范围：80 个新提交（#261-#341）后的结构审视 + UI/UX 建议。功能质量已高（565 测试），本节聚焦结构性瓶颈与体验细节。

### 17.1 代码结构

#### 17.1.1 后端

| 项 | 现状 | 建议 | Issue |
|---|---|---|---|
| chat.router.ts | 977 行，上帝路由持续膨胀 | 拆 Handler + SSE 传输（#303 待做，优先） | #303 |
| knowledge/documents 路由 | 400+ 行，路由+业务混合 | #303 模式推广（路由注册 + service） | - |
| compaction.ts | 469 行，多职责混合 | 拆 budget/state/runner | #353 |
| memory.service.ts | 735 行门面 | 内部协作者拆分（GraphWriter/LegacyProjection/PropagationCoordinator） | #304 |
| 请求校验 | chat 等用 `as any` | zod 覆盖核心写路由 | #349 |

#### 17.1.2 前端

| 项 | 现状 | 建议 | Issue |
|---|---|---|---|
| api-client.ts | 1272 行上帝客户端 | 按领域拆（auth/chat/patient/memory/plugin） | #347 |
| 类型共享 | sdk 存在但 web 手写类型 | 共享类型包，防认证字段漂移 | #348 |
| 大页面 | research-detail 972/writing-editor 899/knowledge 744 | 按组件拆（随功能演进） | - |

#### 17.1.3 安全项（认证新实现）

| 项 | 现状 | 风险 | Issue |
|---|---|---|---|
| 验证码 attempts | 用 code 查库，错误码不计数 | 5 次限制失效，可暴力破解 | #343 |
| send-code IP 限流 | 只有同 target 60s 限流 | 邮件轰炸 | #344 |
| 备份静默跳过 | 未配置 exit 0 | 误以为有备份 | #346 |
| 恢复文档 | 不存在 | 出事无法恢复 | #345 |

### 17.2 UI/UX

| 项 | 现状 | 建议 | Issue |
|---|---|---|---|
| 多 Agent 活动 | 未实现（#288 后需要） | 子 agent 进度指示器（复用 StatusDot） | #350 |
| 写作页双栏 | 窄屏可能挤压 | chat 抽屉式滑出 | #351 |
| 认证 UX | 已实现基础流程 | 邮件反馈 + 重发倒计时 + 入口可见 | #352 |
| 设置页 | 632 行功能多 | 账号安全/模型/数据/集成分组 | #354 |
| 知识/记忆 Tab | 统一入口已做（#262） | Tab 状态保持（滚动/筛选） | - |

### 17.3 优先级

| 优先级 | 项 |
|---|---|
| P0（安全） | #343 验证码尝试失效、#344 IP 限流 |
| P0（结构） | #303 chat.router 拆分、#347 api-client 拆分 |
| P1 | #348 类型共享、#349 zod 校验、#350 多 agent UI、#352 认证 UX、#345 恢复文档 |
| P2 | #346 备份跳过、#351 双栏、#353 compaction、#354 设置页 |
