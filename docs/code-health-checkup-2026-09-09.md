# Heurion 全栈代码体检报告

**受检对象**：heurion monorepo（server-ts · web · worker · contracts · python-stats-worker 等 9 个包）
**出具日期**：2026-09-09
**审查方法**：3 路并行代码审计（server-ts / web / worker+基础设施+文档）+ git 历史分析 + 产品定位与视觉设计核查
**总体评级**：良好 · 待复查

---

## 项目生命体征

| 指标 | 数值 |
|---|---|
| 累计提交 | 1,052（约 4.5 个月内，2026-04-27 ~ 2026-09-09） |
| 贡献者身份 | 8（多为 AI 协作账号） |
| 源码文件 | 735+（server-ts 529 · web 181 · worker 25） |
| 测试用例通过 | 1,792（server-ts 1,581 · web 211） |
| CI workflow | 12（含 3 个待归档） |
| 均值提交规模 | 12 文件 / 515 行（近 100 次提交均值） |

---

## 总体印象

Heurion 是一个演化速度很快的医疗 AI 平台：4.5 个月内产出超过千次提交，核心服务有真实生效的测试套件、结构化日志纪律和事故驱动的回归锁，工程习惯总体扎实。但演化速度已经开始跑在治理机制前面——架构分层规则被文档声明却未被完整强制执行，"控制面"服务出现了文档自称已修复的循环依赖；顶层工程文档（`ENGINEERING_STANDARDS.md`、`ROADMAP.md`）仍停留在半年前已被删除的技术栈上；生产部署链路的自动回滚能力名存实亡。这些是慢性问题，会随迭代速度持续放大。同时发现一处需要立即处理的急性问题：患者报告接口存在越权访问缺口。

把镜头拉到产品和视觉层面，同样的"决策没有落地"模式又出现了一次：团队认真论证过一套面向临床信任感的视觉方向，但从未真正上线到任何实际交付面；产品定位陈述得很精准，实际信息架构却已经长成了一个体量接近全功能后台的系统。详见 PANEL 06。

**严重程度分布**：高优先级 6 项 · 中优先级 7 项 · 低优先级 7 项

---

## PANEL 01 — 架构与依赖分层

server-ts 的 5 层依赖规则（common/core → memory/retrieval → tools → modules）写进了 ARCHITECTURE.md，也有一份机读测试守着——但只守了一半。

### 🔴 高 · 分层规则实际已破，且形成了一条真实循环依赖
文档规定 `common/` 对 modules/memory 零依赖，实测发现 4 处反向依赖；其中 `common/persona.ts → memory/fact-provider.ts → common/fact-render.ts` 构成闭环，与文档"唯一已知循环已在 #679 修复"的表述直接矛盾。
- `src/common/persona.ts:3`
- `src/common/skill-node-migration.ts:17-18,73`
- `src/tools/insert-asset-export.ts:70-71`

### 🟡 中 · `arch-layers.test.ts` 只检查 modules 内部横向边，未覆盖 leaf 层反向依赖
现有机读回归锁真实生效（实跑 4 passed），是团队少数"真被强制"的规则；但检测范围窄，上面 4 处违规完全没被拦截，等于分层规则名义存在、实际无人守门。
- `tests/unit/arch-layers.test.ts`

### 🟡 中 · contracts 包与 python-stats-worker 是两份手写镜像 schema
zod schema（TS）与 pydantic 模型（Python）互相靠注释提醒"保持同步"，无代码生成或 CI 级字段对齐检查；仅有数值级 golden cross-check，覆盖不到 JSON 形状漂移。`requirements.txt` 全部浮动版本无锁文件，Dockerfile 里已留有源码编译兜底，侧面说明构建脆弱性发生过。
- `packages/contracts/src/stats.ts:10-21`
- `packages/python-stats-worker/main.py:20-30`

### 🔵 低 · contracts 无 workspace 编排，靠 4 个 CI workflow 各自重复"先 build"
仓库没有根 package.json / pnpm-workspace.yaml / turbo.json，contracts 用 `file:../contracts` 直接指向源目录；本地忘记 `pnpm build` 不会报错，只会静默用旧类型。
- `server-ts-ci.yml:77-80`、`worker-ci.yml:57-58`、`web-ci.yml:58-61`

---

## PANEL 02 — 代码质量

chat 编排链路和富文本编辑器是两个包体里各自最大的"器官"，也是最容易看出体量失控迹象的地方。

### 🟡 中 · chat 模块集中了 3 个 400~700 行的单体函数
`runConversationTurn` 约 678 行、`runToolCallLoop` 约 463 行、`handleAgentChat` 约 403 行，均为函数内联实现、无子函数拆分，只能靠端到端断言覆盖，函数内部分支组合基本无法被单测触达。
- `src/modules/chat/conversation-turn.ts:83-760`
- `src/modules/chat/tool-loop.ts:168-631`
- `src/modules/chat/chat-handler.ts:69-472`

### 🟡 中 · server-ts 完全没有 ESLint，470 处 any 逃逸未被任何静态门槛拦截
无 `.eslintrc` / `eslint.config`，无 lint 脚本；`: any` 270 处 + `as any` 200 处，342 处集中在 modules/*。core/ 目录（仅 2 个文件）是全库唯一零 any、零违规的干净层。统一错误契约 `Result<T>` 仅 6 个文件采用，其余靠 391 处零散 try/catch；全局错误处理器把 `err.message` 直接透传客户端，有信息泄露风险。
- `modules/knowledge/knowledge-stores.router.ts:62,74`
- `src/app.ts:71`

### 🟡 中 · writing-editor.tsx 是前端最大的"上帝组件"
1164 行、13 个 `useEffect`、27 个 `useState`，是全仓库复杂度最高的单文件，且集中了全库近全部 `react-hooks/exhaustive-deps` 豁免（24 处里 7 处在此文件），是潜在 stale-closure bug 的温床。同类量级的 `knowledge.tsx`(905行)、`submission.tsx`(877行)、`settings.tsx`(763行) 也未拆分。
- `packages/web/src/routes/writing-editor.tsx`

### 🟡 中 · i18n 有 131 个 key 缺失，非组件代码里还硬编码了中文
852 处 `t()` 调用中约 15~18% 的 key 在两份 locale JSON 里都不存在，会静默回退到代码里写死的中文默认值；zustand store 因为不是 React 组件、拿不到 `useTranslation()`，直接硬编码了中文错误提示，英文用户会看到中文原文。
- `packages/web/src/stores/chat.ts:41,250`
- `packages/web/src/components/chat/ChatMessages.tsx`（17 个缺失 key）

### 🔵 低 · 重复实现未抽成共享 hook
"用 ref 保存最新回调防闭包过期"模式手写 89 处；RAF 节流状态更新在两个文件里几乎逐行重复；全仓库 `hooks/` 目录事实上只有 1 个自定义 hook。
- `LlmContent.tsx:128-146`、`DocEditor.tsx:104-121`

---

## PANEL 03 — 安全与运维

CI 门禁和密钥管理是真实做对的部分；越权访问缺口和"文档宣称但实现没有"的两处安全承诺落差是本次体检最需要关注的地方。

### 🔴 高 · 患者报告接口存在越权访问（IDOR）
按 hash 查询患者记录时唯独漏了 `userId` 过滤，是全库 15 处同类查询里唯一一处；对应路由只做登录校验、不做归属校验，report 模块 0 测试覆盖，没有任何测试会捕获它。修复成本几分钟，是本次体检里性价比最高的一项。
- `src/modules/report/report-pdf.service.ts:14`

### 🔴 高 · 生产容器全部以 root 运行，与部署文档的安全声明矛盾
`DEPLOY.md` 明确写"容器以 non-root 用户（nexus，UID 1000）运行"，但逐一核查 server-ts / worker / python-stats-worker / embedding-server 四个 Dockerfile，均无 `USER` 指令。worker 的 root 运行有部分正当理由（headless chromium 沙箱限制），其余三个没有。
- `packages/server-ts/Dockerfile`、`DEPLOY.md · Security notes`

### 🔴 高 · 生产部署没有自动回滚，文档描述的能力已经失效
`docs/CICD.md` 描述 `vps_deploy.sh` 会记录上次成功镜像并在健康检查失败时自动回滚；但该脚本内的部署目录、域名都是迁移前的废弃配置，已不被任何 CI workflow 调用。现行的 `deploy-production-compose.sh` 健康检查失败时只打印日志退出，新镜像早已替换旧容器，回滚需要人工记得上一个 sha 手动执行。
- `docs/CICD.md:106-109`
- `scripts/deploy-production-compose.sh:150-163`
- `scripts/deploy/vps_deploy.sh`（孤立，未被调用）

### 🔵 低 · 磁盘空间是历史上反复出现的问题，团队已自查在途
`docker-compose.yml` 注释记录过一次日志打爆磁盘的真实事故（#801），每次部署仍要主动 prune；团队已在 `.github/workflows/README.md` 里把 3 个磁盘诊断 workflow 标记为归档候选，此处不再重复建议，仅作为过程记录。
- `docker-compose.yml:15-17`

### 🔵 低 · compose 层缺少健康检查门控 / 脚本严格模式覆盖不一致
`nexus-server`、`nexus-stats-worker` 各自暴露了 `/healthz` 但未接入 compose 的 healthcheck；`regression-test.sh`、`verify-epics-817-825.sh` 完全没有 `set -euo pipefail` 保护，其余脚本覆盖程度不一。

---

## PANEL 04 — 测试覆盖

测试是真实的、被日常维护的（不是摆设），但覆盖分布和体量成反比——越是被多处复用的核心代码，覆盖反而越薄。

### 🟡 中 · 高复用组件 ChatMessages 与高风险模块 report 均零覆盖
`ChatMessages.tsx` 被聊天页、患者页、写作编辑器三处消费，全仓库测试文件搜不到一次引用；server-ts 的 brain、report 两个模块 0 覆盖，且 report 恰好是上面 IDOR 缺口所在模块——覆盖缺口与安全缺口精确重合，不是巧合而是同一根因（没人测过这条路径）。
- `packages/web/src/components/chat/ChatMessages.tsx`
- `src/modules/report/*`

### 🔵 低 · 无覆盖率量化工具，测试命名易误导
vitest 未接 coverage provider，只能靠"是否有测试命中某路由"这种存在性判断；249 个测试文件里 99 个命名为 e2e 实为 vitest 进程内调用，与真正的 Playwright 套件（1 个文件）容易混淆，新人评估覆盖率时需要交叉核实两遍才能得到准确结论。
- `vitest.config.ts`、`playwright.config.ts`

---

## PANEL 05 — 文档一致性

ARCHITECTURE.md 是这次审查里唯一被反复交叉验证、每次都对得上代码的文档；其余几份的可信度按下表递减。

### 🔴 高 · ENGINEERING_STANDARDS.md 与 ROADMAP.md 完全过时
前者三条"非协商"规则全部指向 2026-07 已删除的 `packages/server`（Python/Alembic）、`packages/desktop-v2`（Tauri）、`scripts/build-macos.sh`（.dmg 打包），无一处能在当前仓库落地；后者"Now/Next"计划板块讲的是同一批已删除产品线的重组计划，无法回答"团队现在在做什么"。两份文档目前对读者的伤害大于价值，建议整篇重写而非修补。

### 🔵 低 · CONTRIBUTING.md / HISTORY.md 有局部污染
`CONTRIBUTING.md` 第 44 行残留 `cd packages/server && pytest`，引用了不存在的包；`HISTORY.md` 自 TS 重写后再未更新，源码里密集出现的 #791 起新 issue 号在其中找不到对应词条。

### 🔵 低 · TypeScript 编译器版本疑云
server-ts 声明 `typescript ^7.0.2`，核实后是微软新出的原生 Go 移植预览版编译器（tsgo），并非经典 tsc；web 包仍固定在 5.4.5。同一仓库两套完全不同实现的类型检查器并存，需要确认是有意选型还是版本号误填，否则会出现"IDE 不报错、CI 报错"的错配。

---

## PANEL 06 — 产品设计与视觉一致性

README 把 Heurion 定位为"面向肿瘤研究者的自我演化临床 AI 工作站"，核心叙事是记忆的审核与永续；但视觉呈现和信息架构都出现了与这个定位脱节的迹象。

### 🔴 高 · 团队认真做过的视觉方向决策，从未真正上线
`DESIGN_SYSTEM_v2.md`（451 行，状态"草案 v0.1，待医生审"）有一段很扎实的诊断：v1 的 dark-slate + cyan accent 让产品"读起来像 dev tool / dashboard"，对一个要建立临床信任感的工具是错的方向，因此明确决定放弃 cyan / electric blue，换成暖色 bone-paper 背景（`#FAF7F2`）+ "Apothecary Green"（`#2F4F47`）主色，并明文禁用 Inter 字体、纯白底色、红色告警徽标。核对当前实际交付面后发现：**这套决策没有一处被采纳**。web 应用的浅色主题主色是 `hsl(199 89% 48%) ≈ #0ea5e9`（sky-blue），背景是纯白 `hsl(0 0% 100%)`；根目录最新的营销主页草案 `homepage-draft.html`（906 行）主色同样是 `#0ea5e9`，字体用的正是被文档点名禁用的 Inter。也就是说，应用主界面和最新的对外主页，用的都恰好是设计系统文档诊断为"问题"、需要替换掉的那套视觉语言——不是没跟上，而是从未出发。

### 🔵 低 · 迁移是局部的：语义色板动了，核心决策没动
`tailwind.config.ts` 里能看到 `§11.3 (#221)` 的注释，说明团队确实把设计系统里的"临床语义色板"和"8/12/16 圆角语言"迁移进了 web 端；但恰恰是文档里分量最重的一条决策——主色与字体——没有被一并带过来。建议要么把 accent/字体决策也补上，要么在文档顶部加一行"截至 2026-09，主色/字体决策未采纳，现行值见 index.css"，避免下一个读文档的人以为产品已经在用 Apothecary Green。
- `packages/web/tailwind.config.ts`、`packages/web/src/index.css:7-16`

### 🟡 中 · 导航信息架构：一个"工具"分组正在变成杂物抽屉
AppShell 把 13 个顶级入口分成 5 组（概览/对话/患者工作区/记忆与知识/工具），分组本身合理；但"工具"组塞了技能、图表库、插件、文件、日程、导出、设置、管理共 7 项，图表库其实是写作模块的一个 tab 却被单独提到顶级导航，代码里为此专门写了 `activeQuery`/`inactiveQuery` 两个字段处理"同路径互斥高亮"——这是 IA 决策外溢成工程复杂度的一个具体例子。
- `packages/web/src/components/layout/AppShell.tsx:14-45`

### 🔵 低 · 功能广度已经超出"记忆工作站"这个差异化叙事
40+ 个路由文件里，imaging、labs、medical-records、submission、audit、security、logs、sidecar 等模块的体量已经接近一个全功能临床研究后台，而不只是"对话式记忆工作站"。这未必是坏事，但值得产品负责人回头核对：这些模块是否都仍在服务"记忆永续、人审后入库"这条核心差异化主张，还是已经变成了功能广度本身的竞赛——后者会稀释 README 里那句最有辨识度的定位陈述。

---

## 体检亮点

批评之外，这些是明确值得保留、甚至推广到其他包的实践：

- **worker 包安全设计扎实** — 路径穿越三层校验、execFile 全部数组参数无命令注入风险、鉴权 fail-closed、`callback_url` 协议白名单防 SSRF。
- **事故驱动的回归锁习惯** — `no-prisma-as-any.test.ts`、`arch-no-silent-degradation.test.ts` 都是真实故障后补的机读约束，且持续生效。
- **ApiClient 组合设计干净** — 15 个 domain 类以组合而非继承合并，contracts 类型复用扎实，全仓库仅 1 处合理的例外直接 fetch。
- **web 测试与 lint 真实通过** — 211/211 测试实跑通过，eslint 0 warning 门槛真实生效，不是摆设配置。
- **结构化日志纪律好** — 全库几乎没有 console.log 残留，统一走结构化 logger。
- **团队有自我纠错习惯** — `GRAFANA_ADMIN_PASSWORD` 从明文默认值改为 fail-closed；过时的诊断 workflow 已被团队自查标记归档候选。

---

## PANEL 07 — 处方：优先修复清单

1. **【立即】修复越权查询并补回归测试** — `report-pdf.service.ts:14` 加 `userId` 过滤；顺手补一条"patientRecord 查询必须带 userId"的静态扫描测试，参照 `no-prisma-as-any.test.ts` 的模式。修复成本几分钟，本清单收益最高的一项。
2. **【本周】核实容器 root 运行现状，修正文档或修正镜像** — 要么给 server-ts / embedding-server / stats-worker 的 Dockerfile 补 `USER` 非 root（worker 因 chromium 沙箱限制可保留并注明例外），要么把 `DEPLOY.md` 的安全声明改成如实描述。
3. **【本周】补齐或移植部署自动回滚能力** — 把 `vps_deploy.sh` 里"健康检查失败自动回滚"的逻辑移植进当前实际调用的 `deploy-production-compose.sh`（并更新其中过期的域名/路径），或者删除孤立脚本并同步改写 `docs/CICD.md`。
4. **【本月】把分层检测扩展到 leaf 层反向依赖** — 复用 `arch-layers.test.ts` 现成的 static+dynamic import 正则，把检测范围扩展到 common/core/tools/memory/retrieval 对 modules/ 的反向依赖，顺手修掉已发现的 4 处违规和那条真实循环依赖。
5. **【本月】重写 ENGINEERING_STANDARDS.md 与 ROADMAP.md** — 基于当前 server-ts / web / worker / contracts 的真实情况重写核心规则和"Now"计划。
6. **【本月】给 server-ts 补最小 ESLint** — 哪怕只开 `no-floating-promises`、`no-unused-vars`、限制跨层 import 三条规则。
7. **【本月 · 产品】对设计系统的主色/字体决策做一次明确表态** — 要么按 `DESIGN_SYSTEM_v2.md` 的论证把 Apothecary Green + 暖色纸面背景真正推行到 web 应用和 `homepage-draft.html`；要么正式承认现行的 sky-blue + Inter 是当前方向，更新文档、去掉"禁用 Inter/禁用 cyan"的措辞。
8. **【本季度】修 i18n 缺口，并给非组件代码补 i18n 调用路径** — 先修 `stores/chat.ts`、`lib/upload-flow.ts` 里完全绕开 i18n 的硬编码中文，再批量补全 131 个缺失 key；写一个 CI 脚本比对 `t()` 调用与 locale JSON 做 key 存在性校验。
9. **【本季度】拆分 chat 模块三个巨型函数，给 ChatMessages / brain / report 补测试** — 按"附件解析 → context 组装 → 模型调用 → 工具循环 → 收尾"切成可独立单测的小函数；同时接入 vitest coverage provider 产出量化覆盖率数字。
10. **【本季度 · 产品】复核导航信息架构与功能广度是否仍服务核心叙事** — 拆解"工具"分组这个杂物抽屉；由产品负责人过一遍 imaging/labs/medical-records/submission/audit/security/logs 等模块，确认它们是否都在为"记忆永续、人审后入库"这条差异化主张服务。
11. **【本季度】引入根 workspace 编排，消除 contracts 构建的重复样板** — 加一个根 package.json + pnpm workspace（或轻量 turbo/nx）编排 contracts→consumers 的构建顺序。

---

*方法论：3 路并行代码审计（server-ts / web / worker+基础设施+文档）+ git 历史分析 + 设计系统文档与实际视觉呈现的交叉核对，全部结论均附文件路径与行号证据。本报告不替代渗透测试或正式安全审计。*
