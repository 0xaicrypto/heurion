# Heurion 1.0 → 2.0 功能迁移计划

**Status:** v0.1（2026-09-30）
**跟踪:** heurion 仓库 epic #1174
**前提:** 2.0 架构见 [DESIGN.md](DESIGN.md)。1.0 的代码只作参考实现，按需复制逻辑，不共享包、不共享数据。

## 1. 迁移原则

1.0 的每项功能按下面四类处理：

| 类别 | 判定 | 在 2.0 里的形态 |
|---|---|---|
| **A. dsh 替代** | 通用智能体能力 | 不迁移，1.0 实现直接废弃；最多写一份 skill 或 persona 说明 |
| **B. 领域 MCP 工具** | 需要 AI 在编辑中调用的医疗能力 | `apps/server/src/<domain>/` + 注册进 `/mcp`，按文档或用户签发令牌 |
| **C. 服务端模块 + UI** | 需要人直接操作的数据和流程 | REST 接口 + 前端页面；AI 需要用时，再同时开放 MCP 工具 |
| **D. 暂缓或放弃** | 与"快速 AI 编辑 + 医学文献"主线关系弱 | 先不做，按需求再评估 |

两条硬约束（与 DESIGN.md 一致）：

- 所有外部检索只走 heurion 的 MCP，不给模型通用联网能力；
- 引用只能来自 `insert_citation`，正文论断要经核对（见 M1）。

## 2. 1.0 功能清单与去向

### A. dsh 替代（不迁移）

| 1.0 功能 | 1.0 位置 | dsh 对应 |
|---|---|---|
| 对话工具循环、doom-loop、回合预算 | `modules/chat/`、`tools/doom-loop.ts` | agent 生命周期、工具执行管线 |
| LLM 网关（多 provider、reasoning） | `common/llm-gateway/` | `packages/llm`（DeepSeek 原生适配 + pi-ai 自定义路由） |
| 子代理 | `tools/subagent-runner.ts` | `packages/subagent`（2.0 实测中模型已自动使用） |
| 上下文压缩 | `memory/compaction/`、`context-compressor.ts` | `packages/compaction` |
| 任务计划 | `tools/set-task-plan-tool.ts` | `packages/plan`、`packages/todo` |
| MCP 客户端、运行时安装 MCP | `tools/mcp-client.ts`、`mcp-tools.ts` | `packages/mcp/mcp-client`（profile 声明） |
| 看图 | `tools/view-image-tool.ts` | `read_image` |
| 浏览器代理 | `tools/browser-agent-tool.ts`、`cf-browser-agent` | `packages/browser-use`（需要时经白名单开放） |
| 文档和 deck 编辑引擎（EditOp、提案、重基、锚点守卫、pptx-viewer-core） | `edit-*`、`doc-proposal`、`deck-proposal`、`edit-deck-bytes-tool` 等 | office 技能 + 模型写 python-docx/pptx 脚本；heurion 只管版本 |
| 图表渲染 | `render-chart-tool`、`chart-renderer`、`deck-chart-embed` | 容器内 matplotlib 或 python-pptx 原生图表，不需要单独服务 |
| 技能沉淀 | `modules/skills`、`skill-tools` | `packages/skill`（文件系统 skill） |

### B. 领域 MCP 工具

| 1.0 功能 | 1.0 位置 | 2.0 计划 | 里程碑 |
|---|---|---|---|
| PubMed 检索 | `search-citation-tool`、`medical-web-tools` | ✅ 已完成 `pubmed_search` | M0 |
| DOI 元数据、引用登记 | `crossref.client`、`insert-citation-tool`、`citation-store` | ✅ 已完成 `doi_lookup` / `insert_citation` / `list_citations` | M0 |
| 引用守卫 | `citation-guard`、`citation-audit` | ✅ 已完成回合后 DOI 校验；**补：无 DOI 手写条目识别** | M1 |
| 论断核对（1.0 没有） | — | **新：`verify_claims`**，正文论断对照已登记文献的摘要或全文 | M1 |
| OpenAlex 检索 | `openalex-search-tool` | `openalex_search` | M3 |
| OA 全文 | `oa-pdf-tool`（Unpaywall） | `oa_fulltext`，同时为论断核对供给全文 | M3 |
| 医学网站、全文抽取 | `medical-web-tools`（visit/extract） | `fetch_article`（经 ssrf-guard + 域名白名单） | M3 |
| 引用格式（AMA 以外） | `citation-format` | `insert_citation(style)`：Vancouver / APA / GB/T 7714 | M3 |
| 用户知识库检索 | `modules/knowledge`、`retrieval/unified-search` | `kb_search`（关键词 + 向量，RRF） | M3 |
| 统计分析 | `stats-engine`、`stat-*`、`python-stats-worker` | 容器预装 scipy/statsmodels/lifelines + **统计 skill**；需要可复核的结果时用 `run_stats`（固定实现，输出方法学段落） | M4 |
| 投稿选刊 | `modules/submission`（DOAJ、OpenAlex、warning list） | `journal_match` | M5 |
| 临床图谱检索 | `clinical-graph-tools`（search_node / search_encounter） | `patient_search` / `encounter_search`（按用户授权） | M6 |
| 入排筛选 | `research/eligibility-screening` | `screen_eligibility` | M6 |
| 记忆检索 | `memory-tools`、Brain 2.0 | `memory_search` / `memory_propose`（先只做检索与提议） | M7 |

### C. 服务端模块 + UI

| 1.0 功能 | 1.0 位置 | 2.0 计划 | 里程碑 |
|---|---|---|---|
| 文档列表、上传、版本、回滚、下载 | `modules/documents` | ✅ 已完成（M0） | M0 |
| 文档预览 | 1.0 富编辑器 / deck 画布 | LibreOffice 渲染 PDF/PNG（容器内已有） | M1 |
| 版本对比 | #1172 形状级 diff | 文本 diff（docx）+ 逐页渲染对比（pptx） | M1 |
| 评论 → AI 处理 | `modules/comments`、`comment-tools` | 评论锚定"页码 + 引文片段"，发给 AI 作为带定位的指令；AI 回复写回评论线程 | M1 |
| 导入 PDF、参考文献 | `doc-import`、`document-extractor`（OCR） | 上传 PDF 进工作区（模型用 pdf 技能读取）；参考文献批量导入到登记表 | M1 |
| 在线手工编辑 | 1.0 DocEditor + deck 画布 | **决策点（见 §4）**：嵌入 Collabora Online（WOPI），直接编辑权威文件 | M2 |
| 账户、登录、多用户 | `modules/auth`、`ownership` | JWT + 按用户划分数据 | M2 |
| 每用户容器隔离、网络出口白名单 | —（1.0 没有） | 调度器按用户起容器；出口代理只放行 LLM 端点和 /mcp | M2 |
| 审计日志 | `AuditLog`、EventLog | 每个 MCP 调用、每回合、每个版本都写审计日志 | M2 |
| PHI 扫描 | `common/pii-scanner`、doc phi-scan | 上传与导出时扫描；命中后需要确认 | M2 |
| 审批 | `modules/approvals` | 导出或投稿前审批（先做规则配置） | M5 |
| 知识库管理（上传资料） | `modules/knowledge`、`ingestion` | 上传 PDF/文献 → 切块、嵌入 → `kb_search` | M3 |
| 研究项目 | `modules/research`、`research-detail` | 项目 → 多份文档 + 共享文献库 | M6 |
| 患者、病历、检验、影像 | `patients`、`medical-records`、`labs`、`imaging`（DICOM） | 按合规评审后再迁移；影像查看沿用现成的 viewer | M6 |
| 投稿工作流 | `modules/submission`、`submission.tsx` | 选刊 + 按期刊格式重排（AI）+ cover letter | M5 |
| 设置、管理后台、模型配置 | `settings`、`admin` | 模型路由与配额；dsh provider 配置写进 profile | M2 |
| 数据导出 | `export-data.tsx` | 按用户打包导出（合规要求） | M2 |
| 可观测性 | telemetry、Loki/Grafana | 回合耗时、工具调用、token 成本入库；日志沿用 Loki | M2 |

### D. 暂缓或放弃

| 1.0 功能 | 理由 |
|---|---|
| 插件市场、外部应用 API（`modules/plugins`、`external`） | dsh 的 skill 和 MCP 已经覆盖扩展需求；等有真实外部接入方时再做 |
| 日程、今日、提醒（`calendar`、`today`、`schedule`） | 偏离主线 |
| 经验进化、技能归纳（`modules/evolution`） | 依赖 Brain 2.0，先做检索 |
| sidecar 意图路由（`intent-routing`） | dsh 由模型自行选择工具，不再需要前置路由 |
| 生成图片（`generate-image-tool`） | 医学写作用处小 |

## 3. 里程碑

| 里程碑 | 目标 | 退出标准 |
|---|---|---|
| **M0** ✅ | 架构跑通 | SDK 接入、文献 MCP、引用校验、版本回滚、容器化；3 个真实任务通过 |
| **M1 写作可用** | 单用户能高质量完成医学写作 | 预览、版本对比、评论驱动 AI、PDF/参考文献导入、论断核对、手写引用识别；**10 份真实文档评测**（延迟、保真、论断正确率） |
| **M2 可上线** | 多用户安全使用 | 账户、每用户容器、出口白名单、审计、PHI 扫描、导出、可观测性、在线手工编辑（按 §4 决策） |
| **M3 文献与知识** | 检索覆盖面与知识库 | OpenAlex、Unpaywall 全文、全文抽取、多引用格式、用户知识库 |
| **M4 统计与图表** | 可复核的统计 | 统计 skill + `run_stats`，输出结果表、图和方法学段落 |
| **M5 投稿** | 从稿件到投稿 | 选刊、期刊格式重排、cover letter、导出审批 |
| **M6 临床与研究** | 研究项目与临床数据 | 研究项目、入排筛选、患者和病历（先过合规评审） |
| **M7 记忆** | 个性化 | 记忆检索与提议 |

## 4. 待决策

1. **在线手工编辑怎么做。** 2.0 以文件为权威，最自然的办法是嵌入基于 WOPI 的 Office 在线编辑器：
   - **Collabora Online**（LibreOffice 内核，MPL，和容器里的 LibreOffice 同源）：**推荐**；
   - ONLYOFFICE（AGPL，1.0 的 #1101 评估过）。
   不做在线编辑的话，就只能"AI 改 + 下载"。
2. **患者、病历、影像是否留在 2.0 主线**，还是拆成独立产品线：它们的合规要求（PHI）远高于写作。
3. **隔离粒度**：按用户（默认）还是按组织。
4. **1.0 的数据要不要迁移**：用户、文档、引用、知识库。不迁移的话，1.0 保持只读，直到下线。
