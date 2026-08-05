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
