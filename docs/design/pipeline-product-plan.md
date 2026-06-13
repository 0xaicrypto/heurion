# Workflows 产品计划

**状态：** 草稿 v0.1 · 2026-05-17
**负责人：** JZ
**灵感来源：** @sairahul1 "5-Agent Content Pipeline" 推文串 + Claude Code `.claude/agents/` 生态
**目标产物：** Nexus 推出一个一等公民的多 agent 流水线功能，且具备其他消费级桌面 AI 客户端都没有的链上溯源能力，这是核心护城河。

---

## 1. 战略框架

### 为什么是这个，为什么是现在

单线程聊天正在快速商品化。ChatGPT、Claude Desktop、Cursor 的外壳越来越趋同。Nexus 的差异化必须落在 **结构化、可重复、可审计的 agent 工作** 上，光靠 chat 表面承载不了。

从 @sairahul1 那条推文里能直接对接到 Nexus 既有护城河的三个观察：

1. **专业化 > 通用 context。** 每个 agent 在自己独立的 context window 跑，比单一长 thread 输出质量高，因为不存在"context contamination"。Nexus 通过 twin/memory 模型本就把会话 context 隔离了——我们离把这件事变成产品表面只差一步。
2. **artifact 即契约。** 一条 pipeline 不过是 N 个 markdown 文件 + 严格的输入输出 shape。存储与分享几乎免费，价值全在 recipe + runtime。
3. **handoff 才是真正的 IP。** "HANDOFF TO / FROM / INSTRUCTION" 这种 agent 间模板化交接才是防止 drift 的关键。Nexus 可以把它作为别人 UI 里都没有的原语固化下来。

### 为什么 Nexus 能赢这块

三个结构性优势，竞品没有：

| 优势                     | 解锁的价值                                                |
| ------------------------ | --------------------------------------------------------- |
| 链上 anchor (BSC)        | 合规买家可验证的审计链（Radiology Pro 档位）              |
| 每个 agent 独立身份 (ERC-8004) | 流水线里每个 agent 都是链上独立身份                |
| 原生 macOS + 本地数据    | 流水线客户端运行，无 SaaS 往返、无数据出境                |

Claude Code 用户今天能手搓流水线；ChatGPT 用户不能；合规买家两边都不信。Nexus 是唯一能一键回答"我用 agent A→B→C→D→E 处理了这些输入，且链上有据"的地方。

---

## 2. Phase 0 — 格式对齐（第 1 周）

**目标：** Nexus 的 Skill 格式变成 `.claude/agents/` 的严格超集。第一天就跟 Claude Code 生态 drop-in 兼容。

### 为什么先做这个

其他每个阶段都依赖它。如果格式自创，我们就把自己切断在已经在 `.claude/agents/` 上长起来的 agent 模板生态之外。

### 范围

- 读现有 Skills schema：`packages/server/nexus_server/skills_*.py`（先 grep 定位精确文件）
- 对比 `.claude/agents/` YAML frontmatter 规范（`name`、`description`、body）
- 把缺的字段补上；Nexus 专属扩展放在 namespaced section 里
- 写 importer：把 `.claude/agents/foo.md` 文件丢进 Nexus 的 skill 目录 → 自动加载
- 写 exporter：任意 Nexus skill → 合法的 `.claude/agents/` markdown
- 测试：从 GitHub 装 3 个流行的 Claude Code agent，验证能跑

### 验收

- [ ] `cp ~/some-repo/.claude/agents/researcher.md ~/Library/.../RuneProtocol/skills/` → skill 在 Nexus 里出现
- [ ] 在 Nexus 里跑该 skill 输出（模型差异之外）跟 Claude Code 一致
- [ ] 来回往返：导入 → 在 Nexus UI 里改 → 导出 → 回到 Claude Code 仍可加载

### 工作量

约 2 天。基本是机械对齐 + 1 个 importer + 1 个 exporter。

---

## 3. Phase 1 — Workflows 模式（第 2-4 周）

**目标：** 一等公民的 UI 表面，用来定义和运行多 agent 流水线。

### 设计

新建一个 view（跟 Chat / Plan / Account 同级），叫做 **Workflows**（这个名字市场上比 "Pipelines" 更友好）。从用户菜单进入。

```
┌─────────────────────────────────────────────────────────────────┐
│  Workflows                                                      │
│  ─────────                                                      │
│  把 agent 串成链。每一步在独立 context 里跑。                    │
│                                                                 │
│  [ + 新建 workflow ]                                            │
│                                                                 │
│  ┌─ Content Studio ─────────────────────────────────────────┐   │
│  │ Strategist → Researcher → Writer → Editor → Publisher    │   │
│  │ 上次运行 2 小时前 · 耗时 18 分钟 · ✓ 已上链               │   │
│  │                                              [ 运行 ▸ ]  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Code Review ────────────────────────────────────────────┐   │
│  │ Architect → Security → Performance → Style               │   │
│  │ 上次运行 昨天 · 耗时 7 分钟 · ✓ 已上链                    │   │
│  │                                              [ 运行 ▸ ]  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Workflow 编辑器

点进某个 workflow → 可拖拽排序的步骤列表：

```
┌─────────────────────────────────────────────────────────────────┐
│  Content Studio                              [ 保存 ] [ 运行 ▸ ]│
│  ─────────────                                                  │
│                                                                 │
│  ▼ 输入                                                         │
│    主题：    [                                              ]   │
│    受众：    [                                              ]   │
│    平台：    [ Twitter/X thread ▾ ]                             │
│                                                                 │
│  ▼ 步骤                                                         │
│  ┌─ 1. Strategist ────────────────────── ⋮ ─┐                   │
│  │  返回 angle / hook / brief             │                    │
│  └────────────────────────────────────────────┘                 │
│  ┌─ 2. Researcher ──────────────────────── ⋮ ─┐                 │
│  │  5 个来源、3 条事实、3 条反证             │                  │
│  └────────────────────────────────────────────┘                 │
│  ┌─ 3. Writer  …                                                │
│  ...                                                            │
│                                              [ + 添加步骤 ]     │
└─────────────────────────────────────────────────────────────────┘
```

### 运行视图

workflow 运行时，用户看到的是纵向时间线：

```
┌─────────────────────────────────────────────────────────────────┐
│  Content Studio · Run 1f3e2d                                    │
│  开始于 14:02 · 进行中：第 3 步 / 共 5 步                        │
│                                                                 │
│  ✓ Strategist                                            32s    │
│    └─ "Most people use Claude as one assistant. The ones..."    │
│                                                                 │
│  ✓ Researcher                                            2m18s  │
│    └─ 找到 5 个来源、3 个反证数据                                │
│                                                                 │
│  ◐ Writer                                                运行中  │
│    └─ 起稿中...                                                  │
│                                                                 │
│  ○ Editor                                                待开始  │
│  ○ Publisher                                             待开始  │
│                                                                 │
│  [ 取消 ]                                  [ 查看 handoffs ]    │
└─────────────────────────────────────────────────────────────────┘
```

完成的每一步可展开看完整输出。"查看 handoffs" 显示步骤间的传递 payload（调试 + 审计用）。

### 工程构件

1. **`Workflow` 模型 + 存储** — 每个 workflow 一个 JSON 或 YAML 文件，存在 `~/Library/.../RuneProtocol/workflows/` 下。schema：
   ```yaml
   id: 0xabc...
   name: Content Studio
   inputs:
     - { key: topic, label: 主题, type: text, required: true }
     - { key: audience, label: 受众, type: text, required: true }
     - { key: platform, label: 平台, type: select, options: [linkedin, twitter, blog, newsletter, youtube] }
   steps:
     - skill: content-strategist
       inputs_from: workflow.inputs
     - skill: content-researcher
       inputs_from: previous.output
     - skill: content-writer
       inputs_from: [step.1.output, step.2.output]
     ...
   ```

2. **Workflow 运行时** — 服务端编排器。每一步：
   - 用模板拼出 handoff payload
   - 在 skill prompt 范围内启动一个新 agent context（LLM 调用）
   - 抓取输出、持久化为事件，run 结束后批量 anchor
   - 移交到下一步

3. **Handoff 模板（内置）** — 取自原推文，自动注入到每个 step 的 prompt 前缀：
   ```
   HANDOFF TO: {next_skill}
   FROM: {prev_skill}

   {prev_output}

   INSTRUCTION: Take the above as your input. Execute your role.
   Do not re-run the previous agent's job. Start from where they stopped.
   ```

4. **桌面端 `WorkflowViewModel` + `WorkflowView` + `WorkflowRunView`**。step 输出的渲染复用现有 chat-message 组件。

5. **API（服务端）：**
   - `GET /api/v1/workflows` — 列表
   - `POST /api/v1/workflows` — 创建
   - `PUT /api/v1/workflows/{id}` — 更新
   - `POST /api/v1/workflows/{id}/run` — 启动运行，返回 run_id
   - `GET /api/v1/workflows/runs/{run_id}` — 轮询状态 + 输出（或 SSE 流）

### 验收

- [ ] 用户能 2 分钟内从零创建一个 workflow
- [ ] 用户能跑通自带的 "Content Studio"，拿到 publish-ready 输出
- [ ] 每一步的独立输出可见可复制
- [ ] 用户关掉桌面后运行仍能继续（服务端不中断）
- [ ] 失败的步骤明确标示（哪一步、什么错、retry 选项）

### 工作量

约 2 周。表面积大但没有未解的研究问题——直接的 orchestrator + UI。

---

## 4. Phase 2 — Starter pipeline packs（第 5 周）

**目标：** 上线即附带 5 个高质量 workflow，第一天就能展示完整产品力。

### 五个 pack

| Pack             | 步骤                                                            | 目标用户                | 档位           |
| ---------------- | --------------------------------------------------------------- | ----------------------- | -------------- |
| Content Studio   | Strategist → Researcher → Writer → Editor → Publisher           | 独立创作者 / 营销人员   | 免费           |
| Research Brief   | 提问 → 找源 → 综合 → 反证 → 引用                                 | 知识工作者 / 分析师     | 免费           |
| Code Review      | Architect → Security → Performance → Style                      | 工程师                  | Pro            |
| Daily Standup    | 昨日 → 今日 → 阻塞 → 风险                                        | 工程 lead / 创始人      | Pro            |
| Radiology Report | 发现提取 → 鉴别诊断 → 建议 → 审计                                | 放射科医生（付费）      | Radiology Pro  |

**Radiology Report pack 是医疗垂直的撕口**——它是唯一一个链上 anchor 是 **法律要求**、不是 nice-to-have 的场景。上线前需要拿到真实放射科医生的输入共建。现在就开始 outreach。

### 打包方式

每个 pack 发布为一个 `.workflow` 文件（§3 的 YAML schema）+ 它引用的 N 个 skill markdown。用户装一个 pack → workflow 出现在列表，skill 出现在 skill picker。

### 验收

- [ ] 5 个 pack 都能在全新账号上一键装好并跑通
- [ ] 每个 pack 在 `docs/workflows/` 有 30 秒 demo GIF
- [ ] 每个 pack 在 app 内有 1 段"这是干嘛的"描述

### 工作量

约 1 周。主要是写 skill markdown + workflow 定义 + 录屏。Radiology pack 需要医生伙伴——现在就开始联系。

---

## 5. Phase 3 — Marketplace + 档位 gating（第 6-7 周）

**目标：** 用户能浏览、安装、分享 workflow。付费 pack 是升级触发点。

### 浏览 / 安装

新增 view section：**Browse workflows**。显示 5 个自带 pack + 社区提交。分类：Content / Research / Engineering / Medical / Custom。

```
┌─────────────────────────────────────────────────────────────────┐
│  浏览 workflows                                    [ 搜索… ]    │
│  ──────────────                                                 │
│  推荐                                                           │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐       │
│  │ Content Studio │ │ Code Review    │ │ Radiology Rpt  │       │
│  │ 5 agent · 免费 │ │ 4 agent · Pro  │ │ 4 agent · 🔒   │       │
│  │ [ 安装 ]       │ │ [ 安装 ]       │ │ [ 升级 ]       │       │
│  └────────────────┘ └────────────────┘ └────────────────┘       │
│                                                                 │
│  社区                                                           │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 档位 gating

- **Free Beta**：Content Studio + Research Brief（每天 5 次运行上限）
- **Pro ($29/月)**：以上 + Code Review + Daily Standup，无限运行
- **Pro Plus ($59/月)**：以上 + 自建 workflow + 社区分享
- **Radiology Pro ($149/月)**：以上 + Radiology Report pack + 审计 PDF 导出

这让 Plan 标签的购买信号变强——用户看到锁着的 workflow，升级 CTA 就在旁边。

### 分享

Pro Plus 用户可以 `导出 workflow` → 生成 `.workflow` 文件 + 打包的 skill。丢到别人的 Nexus → 自动装上。暂时不做中央 registry（看流量再上 Phase 4）。

### 验收

- [ ] 锁住的 workflow 显示档位徽标 + 内联 upgrade CTA
- [ ] 自带 pack 3 秒内装到用户列表
- [ ] 导出 → 导入在两台 Nexus 之间往返成功

### 工作量

约 2 周。大部分是 browse UI + 档位执行逻辑。档位检查在 billing 阶段已经写好。

---

## 6. Phase 4 — 链上 anchor 运行（第 8 周）

**目标：** 每次 workflow 运行都获得一个可验证的链上 anchor。这就是护城河——竞品做不到。

### 工作机制

workflow 完成时：

1. 服务端对 (workflow_id, 各 step 输出, 时间戳, 模型版本) 计算 Merkle root
2. 通过 Nexus 现有的 anchor 通道写入 BSC
3. 存储 tx hash + 每一步的 Merkle proof

之后用户可以"证明这次运行的输出是 T 时刻、由这些 agent、用这些输入产生的"——通过导出 **审计报告 PDF**，里面包含：

- workflow 定义
- 每个 step 的输入、输出、时间戳
- 把报告锚回链上 root 的 Merkle proof
- 区块浏览器链接

### UI

完成的运行视图：

```
✓ 运行完成 · 18m 02s

  [ 查看输出 ]  [ 导出审计报告 ▾ ]  [ ✓ 已锚定到 BSC ]
                                              ↳ 0x4a3b...
```

点绿色对勾 → 跳转区块浏览器。

### 为什么这件事重要

Radiology Pro 档位的整个销售逻辑就建立在这单个功能上。放射科医生的 AI 生成报告在法律意义上是无效的，除非他能证明 **生成时间、模型版本、输入内容**。Nexus 的 anchor 给他这一切，别的消费级产品都给不了。

可泛化到：法律 discovery、新闻业（信息来源溯源）、合规审计（SOC 2、HIPAA）、学术研究（可复现性）。

### 验收

- [ ] 运行完成 → tx hash 60 秒内出现在 run card
- [ ] 审计报告 PDF 包含有效的 Merkle proof
- [ ] 独立验证：拿着 PDF 和区块浏览器的第三方能确认运行确实按描述发生

### 工作量

约 1 周。anchoring 基础设施已经有，我们只是把 workflow 运行包进现有原语里。

---

## 7. Phase 5 — Launch（第 9 周）

**目标：** 把这个功能高调发出去。我们刚读的那条推文就是 playbook。

### 吃自己的狗粮

直接用 Content Studio 这个 workflow 来生成本次 launch 的内容：

- 输入：`Nexus Workflows — 带链上溯源的多 agent 流水线`
- 受众：`独立创始人 + AI 玩家 + 合规买家`
- 平台：Twitter/X 推文串、LinkedIn、博客、YouTube demo、newsletter

推文要打的标语："5 个 Workflow。一个文件夹。链上可验证。唯一能证明自己跑过的多 agent 运行器。" 配 30 秒录屏显示真实运行 + 锚定到链上。

### 分发清单

- [ ] Twitter/X 推文串（自己发 + BNB Chain 团队转）
- [ ] LinkedIn 帖（Web2 受众）
- [ ] HackerNews "Show HN"（工程师受众）
- [ ] r/LocalLLaMA（重度用户）
- [ ] BNB Chain newsletter（链原生受众）
- [ ] 1 个播客（AI 主题、不嫌小）
- [ ] Radiology 合作医生发自己的 workflow（医疗受众）

### 定价文案

更新 Plan 标签的 tagline：

> Pro Plus — 给运行 agent、而不是跟 agent 聊天的人。

### 验收

- [ ] launch 周内 1000+ 下载
- [ ] launch 周内 50+ 付费转化
- [ ] 至少 1 个 radiology pilot 落地

### 工作量

约 1 周，主要是内容 + 外联。可以跟 Phase 4 收尾并行。

---

## 8. 开放问题与决策建议

每个问题列出 2-4 个可行选项，逐项利弊，最后给一个有立场的推荐。你可以接受推荐、改方向、或者跳过暂缓。

---

### Q1：Workflow 用 YAML 文件描述，还是把它当成一串有序的 skill markdown？

**核心问题：** workflow 的"recipe"（步骤顺序、输入输出怎么穿、参数）跟"内容"（每个 agent 的 prompt body）该不该分文件？

**选项 A — YAML workflow 文件 + 引用一组 skill markdown**

例：`content-studio.workflow.yaml` 引用 `content-strategist.md` / `content-researcher.md` 等。

- ✅ Recipe 与 instruction 分离，schema 严格、便于校验
- ✅ Skill 可在多个 workflow 间复用（Strategist 既给 Content Studio 用也给 Newsletter 用，单点改）
- ✅ 容易表达条件分支、并行、输入映射 (`step.2.output → step.3.input`)
- ✅ 可视化编辑器友好（表单驱动，不是裸文本）
- ❌ 用户要学两种格式
- ❌ 一个完整 workflow 是 N+1 个文件，分享时要打包
- ❌ 比单文件版本多一层心智负担

**选项 B — Workflow = 一个有序文件夹**

例：`content-studio/01-strategist.md` `02-researcher.md` `03-writer.md` ...，按文件名前缀排序就是执行顺序。

- ✅ 极简，"workflow 就是有序的 agent 文件夹"
- ✅ 文件系统顺序 = 执行顺序，零抽象层
- ✅ 每个 step 是一个完整自包含 `.claude/agents/` 文件，可从 Claude Code 生态直接拿
- ✅ 分享 = zip 整个文件夹
- ❌ 表达力局限于线性流，无法分支 / 并行
- ❌ 跨 workflow 共享 skill 要靠复制（drift 风险）
- ❌ 输入映射只能写死规则（"上一步输出 → 下一步全量输入"），无法精细配置
- ❌ UI 编辑只剩"重命名 + 拖序"，限制了产品可发挥的视觉空间

**选项 C — 单一 super-markdown，frontmatter 列所有步骤**

例：`content-studio.md` 顶部 frontmatter 里 `steps: [strategist, researcher, ...]`，body 用 H2 分章节，每章节是一个 agent 的 prompt。

- ✅ 一个 workflow = 一个文件，分享起来像那条 @sairahul1 推文一样具有病毒性
- ✅ 读起来从上到下就是整个 pipeline，自文档化
- ❌ 单文件长，难编辑，UI 化更难
- ❌ 跨 workflow 复用某个 agent = 复制粘贴
- ❌ 数据（recipe）和内容（指令）混在一起，长期维护成本高

**我的推荐：选 A（YAML workflow + 独立 skill markdown），但支持"内联 skill"作为一次性导出格式**

理由：
1. **生态兼容**：skill 保持纯 `.claude/agents/` markdown 兼容，零摩擦从 Claude Code 拿东西过来
2. **复用**：5 个 workflow 引用 12 个 skill 比 5 个 workflow 内嵌 25 个重复 skill 干净
3. **病毒分享**：写一个 `nexus export --inline` 命令，把 workflow + 引用的所有 skill 合并成单文件，那种"五个 markdown 在一个文件夹"的浪漫感保留作为分享形式

90% 的工程化用法走 A，10% 的病毒传播场景走 C 的导出。两边都要。

---

### Q2：每个 step 跑用户选的模型，还是 per-step pin？

**核心问题：** Strategist 需要洞察力（贵模型），Publisher 只是排版（便宜模型）。要不要让 workflow 作者按 step 钉模型？

**选项 A — 全跑用户当前选的模型**

- ✅ 心智模型简单："我现在用 Sonnet，全程都是 Sonnet"
- ✅ 成本预估线性
- ❌ 简单 step 浪费钱（Publisher 用 Opus 是杀鸡用牛刀，贵 30 倍）
- ❌ Workflow 质量被用户当前的模型选择绑架

**选项 B — Workflow 定义里每个 step 钉模型**

- ✅ Workflow 作者按"洞察 vs 执行"分级：Strategist=Opus、Researcher=Haiku、Writer=Sonnet、Editor=Opus、Publisher=Haiku
- ✅ 常见组合可降本 5-7 倍
- ✅ 关键步骤可强制用最强模型，保证质量
- ❌ Workflow 作者要懂模型分级（提高创作门槛）
- ❌ 用户失去控制（"我 $29 的 Pro 订阅怎么按 Opus 价收费？"）
- ❌ 跟档位耦合（Free Beta 不能用 Opus，但 workflow 钉了 Opus，怎么办？）

**选项 C — Workflow 给"建议"，用户三档开关覆盖**

Workflow 作者给每个 step 标签：`tier: strong / fast / cheap`。用户在 workflow 页面有 3 选 1 开关：

- `Use workflow defaults` — 按作者建议
- `All economy` — 全部跑便宜模型
- `All premium` — 全部跑最强模型

运行前显示成本估算。

- ✅ 默认覆盖 95% 场景（作者最懂）
- ✅ 用户保留控制
- ✅ 跟档位天然耦合：Free Beta 强制 `economy`，Pro Plus 解锁 `defaults`，Radiology Pro 解锁 `premium`
- ❌ 三档比单档复杂一些，但仍在普通用户能理解的范围

**我的推荐：选 C**

成本控制 + 用户感知 + 档位营销，一个机制解决三个问题。运行前的成本估算 banner（"此次运行预计 ~$0.42"）也变成升级 CTA 的触发点之一。

---

### Q3：Pipeline 超时 / 成本上限默认值？

**核心问题：** 防止跑飞——单个坏 step 死循环可以烧掉几十美元。

**选项 A — 不设限，跑完为止**

- ✅ 行为可预测
- ❌ 跑飞代价巨大（一次 $100+ token 账单）
- ❌ 用户首次体验如果是 $50，信任崩塌

**选项 B — 硬上限：每 step + 每次运行**

- ✅ 成本可预测："最多 $X / 次"
- ✅ 用户信任有界
- ❌ 切断合法的长运行（Radiology Report 做影像 diff 可能正当地需要 20+ 分钟）
- ❌ Workflow 作者无法保证 100% 完成率

**选项 C — 软上限 + 确认弹窗**

跑到上限时暂停："已运行 10 分钟 / 已花费 $3，继续吗？" 用户确认才继续。

- ✅ 常见场景受控，长合理运行可手动放行
- ❌ 后台运行 UX 被打断（用户走开了，回来发现卡在确认对话框）
- ❌ 上限要有意义就需要前置成本估算（增加复杂度）

**我的推荐：选 B（硬上限），按档位差异化**

| 档位            | 单 step 上限 | 单次运行上限 | 单次成本上限 |
| --------------- | ------------ | ------------ | ------------ |
| Free Beta       | 3 分钟       | 15 分钟      | $1           |
| Pro             | 5 分钟       | 30 分钟      | $5           |
| Pro Plus        | 10 分钟      | 60 分钟      | $20          |
| Radiology Pro   | 20 分钟      | 120 分钟     | $50          |

触发上限时显示明确错误 + "升级以解锁更高上限"按钮——又一个升级 CTA 触发点。Radiology Pro 的上限对图像处理类合理够用。

---

### Q4：社区 marketplace 注册中心——Nexus 自托管 / IPFS / GitHub-based？

**核心问题：** 用户怎么发现别人造的 workflow？

**选项 A — Nexus 自托管中央 registry**

我们建数据库 + 搜索 + 评分 + 评论 + 付费 workflow gating。

- ✅ 控制力全：策展、推荐、付费 gating、删违规
- ✅ 内置社交信号（下载数、评分、评论）
- ✅ 用户行为数据回流帮助迭代产品
- ❌ 托管成本随用户量上升
- ❌ 审核负担（医疗内容、版权、滥用）——我们变成出版商，背负法律责任
- ❌ 工程量大（CRUD + 搜索 + 评分 + 支付）

**选项 B — IPFS 去中心化**

Workflow 用 content-addressed hash 引用，存 IPFS。

- ✅ 跟链上叙事一致——workflow 内容寻址、链上引用
- ✅ 零托管成本
- ✅ Crypto 原生受众喜欢
- ❌ 发现性差（IPFS 没有搜索引擎）
- ❌ 用户信任薄（无质量信号）
- ❌ 检索慢（HTTP 永远更快）
- ❌ Pinning 生命周期问题（没人 pin 内容就丢）
- ❌ 主流用户（放射医、营销人）受不了 IPFS 摩擦

**选项 C — GitHub-based**

Workflow 当成 GitHub repo，搜索走 GitHub API。

- ✅ 零基础设施成本
- ✅ 开发者本就在 GitHub
- ✅ 版本管理、PR、issue 免费送
- ✅ `.claude/agents/` 生态本来就在 GitHub
- ❌ 主流用户（医生、营销人）没 GitHub 账号
- ❌ GitHub 控体验（rate limit、repo 下架）
- ❌ 付费 workflow 很难 gate
- ❌ GitHub 搜索对非代码内容不够好

**选项 D — 不做 marketplace，只支持 export / import 私下分享**

用户用 Twitter / Slack / Discord 互传 `.workflow` 文件。

- ✅ 零新基础设施
- ✅ 分享行为自然外溢，免费 PR
- ✅ 把决策推迟到知道用户是谁、怎么用之后
- ❌ 无发现性（用户不知道有什么）
- ❌ 无社交信号
- ❌ 错过网络效应护城河

**我的推荐：v1 选 D，v2 再做 A**

理由：
- v1 launch 时 5 个自带 pack 已经解决冷启动问题
- 在我们知道有 100+ 活跃用户、知道他们分享 workflow 的实际形态之前，过早建 marketplace 等于猜
- D 状态下用户用 Twitter 互传 workflow → 帮我们做免费传播 → 也帮我们收集"哪些 workflow 真火"的市场信号
- 等到那些信号清晰了，再做 A——并且届时我们对哪些功能是必要的（评分？评论？付费？）有了实证依据
- IPFS 留作"加密原生用户分享"的小众通道，不当主路径

---

### Q5：Radiology 合作医生

**核心问题：** Radiology Report pack 是医疗垂直的撕口，必须有真实放射科医生共建——否则我们造的是脱离临床实际的玩具。

**选项 A — 冷外联 LinkedIn / Twitter**

向 30-50 个放射科医生发私信。

- ✅ 直接、快
- ✅ 不依赖现有关系网
- ❌ 冷邮件响应率极低（<5%）
- ❌ 没有产品可演示前，很难说服医生投入时间
- ❌ 时间消耗大

**选项 B — 等产品上线后等真实用户自荐**

- ✅ 自筛选的用户质量高
- ✅ 无外联负担
- ❌ 慢——可能 launch 后 6 个月才来一个
- ❌ 没有医疗专属功能，根本吸引不到他们 → 鸡生蛋问题

**选项 C — 跟放射科诊所 / 集团合作**

- ✅ 单点带来量 + 信誉 + PR 价值
- ❌ 集团采购周期 6-12 个月
- ❌ 一开始就要 HIPAA 全面合规
- ❌ 法律复杂度跳一级

**选项 D — 招一个做顾问，给少量股权**

- ✅ 深度参与，输入质量最高
- ✅ Launch 时挂他名字带信誉
- ❌ 股权稀释
- ❌ 找对人需要时间

**我的推荐：A + D 组合，立刻启动，杠杆点是你的 BNB Chain 关系网**

理由：
- BNB Chain 应该有医疗 pilot 项目或合作医院网络——你可能 1 通电话就能找到 2-3 个候选放射医，**远比冷外联效率高**
- 第一周内见 2-3 个，挑一个最契合的给 0.25-0.5% 顾问股权
- 这个人不需要全职，只需要每月 2-4 小时审 workflow 输出 + 给真实 case study
- 一个真实放射医背书 launch，比 100 个特性都值钱
- 替代方案（无人共建）= Radiology Pro 档位是空壳，$149/月卖不出去

**今天能做的事：** 给 BNB Chain 关系网里管医疗的人发个微信，开门见山："我在做一个 AI agent 产品，有一档是给放射科医生的，你那边有放射医联系人吗？想找一两个做 advisor。"

---

### Q6：运行状态持久化——只服务端还是本地也存一份用于离线查看？

**核心问题：** 用户运行完一个 workflow，输出存在哪里？关掉网络还能看回放吗？

**选项 A — 只存服务端，桌面是 viewer**

- ✅ 单一数据源，无同步冲突
- ✅ 多设备访问（未来出 web 版直接受益）
- ✅ 桌面 binary 更轻
- ❌ 离线看不了历史
- ❌ 存储成本随用户量上升（虽然 workflow 输出比 chat 历史小，但仍是成本）
- ❌ 隐私角度：所有数据都在我们这

**选项 B — 服务端 + 本地副本**

服务端是源头，桌面缓存最近 50 次运行用于离线浏览。

- ✅ 离线可看已完成的运行
- ✅ 本地访问快（无往返）
- ✅ 服务端是 fallback / sync 层
- ❌ 同步复杂度（多设备冲突解决）
- ❌ 两端都要存
- ❌ 缓存失效策略要想清楚

**选项 C — 只存本地，服务端可选**

- ✅ 跟"你的数据在你机器上"叙事一致
- ✅ 零服务端成本
- ✅ 默认离线工作
- ❌ 机器擦掉就丢数据（无云备份）
- ❌ 多设备访问不了
- ❌ 分享 run 需要显式导出
- ❌ Nexus 现有架构是 server-first，转向 C 等于大架构调整

**我的推荐：选 B（服务端 + 本地缓存）**

理由：
- 服务端是真源（用户跨设备访问 + 备份保险）
- 本地缓存覆盖离线浏览 + 速度
- 链上 anchor 是终极兜底（即使服务端数据丢了，链证明运行发生过）
- 这构成"三地存证"叙事，对合规买家特别有说服力："您的数据有本地副本、服务端备份、链上证明，三个独立通道任意一个能验证"
- 多设备同步的复杂度其实不大——workflow 运行天然是离散事件，每次完成就是一个不可变记录，无并发编辑问题

---

### 推荐汇总

| 问题 | 我的选择 | 一行理由                                                       |
| ---- | -------- | -------------------------------------------------------------- |
| Q1   | A + 一点 C | YAML workflow 引用独立 skill，但支持 `--inline` 单文件导出     |
| Q2   | C        | Workflow 标签 + 用户三档开关 + 档位天然解锁不同档                |
| Q3   | B        | 硬上限，按档位差异化（$1 / $5 / $20 / $50）                    |
| Q4   | D 起步、A 跟进 | v1 只做 export/import，到 100+ 活跃用户再建中央 registry        |
| Q5   | A + D    | 通过 BNB Chain 医疗关系网快速找 2-3 个候选，挑 1 个给顾问股权 |
| Q6   | B        | 服务端源头 + 本地缓存 + 链上 anchor = 三地存证                  |


---

## 9. 风险

| 风险                                                                | 缓解                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 多步运行慢（每个 3-5 分钟）→ 用户跳出                                 | 实时显示 step 进度；允许后台运行                                  |
| 长 pipeline token 成本爆炸                                          | per-step model pinning；预算上限；运行前显示成本估算              |
| Skill 格式后期跟 `.claude/agents/` 偏离                              | Phase 0 锁定契约；当公开 API 对待                                 |
| 导出的 workflow 包含用户私密数据                                     | 默认从导出中剥离用户特定值                                        |
| Radiology pack 被无监督使用产生法律风险                              | 醒目的免责声明 + 档位 gate + EULA 附录                            |
| BSC anchor 频次高时成本上升                                          | 按用户每日批量 anchor；高频段位收费                               |

---

## 10. 时间线汇总

```
第 1 周   Phase 0  格式对齐
第 2-4 周 Phase 1  Workflows 模式（UI + 运行时 + 持久化）
第 5 周   Phase 2  5 个 starter pack
第 6-7 周 Phase 3  Marketplace + 档位 gating
第 8 周   Phase 4  链上 anchor 运行
第 9 周   Phase 5  Launch

总计：约 9 周（1 人开发），并行可压缩到 6 周。
```

**关键路径：** Phase 0 → Phase 1 → Phase 2 → Phase 5。Phase 3 和 Phase 4 如果有人力可以跟 Phase 5 筹备并行。

---

## 11. 今天就能动的最小 Phase 0

如果你现在就想开工，1 小时内可启动的步骤：

1. 打开 `packages/server/nexus_server/` 找到 skill 加载器（`grep -r "skill" --include="*.py" | head`）
2. 拿它的 frontmatter 解析器跟 `.claude/agents/` 规范对 diff
3. 挑一个有代表性的开源 Claude Code agent（比如 `https://github.com/anthropic-experimental/agent-cookbook` 如果存在；没有就自己造一个）
4. 丢进 Nexus 的 skill 目录，跑，看哪里炸
5. 修补 gap

这就是后面所有事的解锁起点。

---

## 12. Changelog

### 2026-05-17 · Phase 0 完成（v0.1）

**范围：** Skill 格式与 Claude Code `.claude/agents/` 生态对齐。

**改动文件：**

- `packages/sdk/nexus_core/skills/manager.py`
  - `InstalledSkill` 新增 `model`、`tools`、`layout` 字段
  - `_load_all` 双 layout 扫描（folder skills 优先，flat skills 补充）
  - 拆出 `_load_skill_folder` (Layout A 原有) 与 `_load_skill_flat` (Layout B 新增)
  - 新增辅助函数 `_extract_version_author` / `_extract_model` / `_extract_tools`，frontmatter 双格式兼容（`name`/`title`、顶层/嵌套 `version`/`author`）
  - 新增 `install_from_claude_agents(path)` —— 接受单 `.md` 文件或目录批量导入
  - 新增 `export_to_claude_agents(name, dest_dir)` —— 把任意 skill 写成合法的 Claude Code agent 文件
  - 重写 `_parse_frontmatter` 支持 inline list (`[a, b]`) 和 block list (`\n  - a`)

**验证：**

- 端到端 round-trip 测试通过：
  - 合成 `content-strategist.md`（带 `model: strong` + `tools: [Read, WebSearch]` block list）→ Nexus 导入 → frontmatter 字段完整保留
  - Nexus skill → 导出为 Claude Code agent 文件 → 二次导入到新 SkillManager → 字段与正文完全一致（identity）
  - 旧 Nexus `SKILL.md` folder layout（带嵌套 `metadata.version`/`metadata.author`）继续正常加载
- SDK 测试套件全绿：**361 passed, 3 skipped**（1 个 deselected 是预存在的 LobeHub 测试，跟本次改动无关）

**接下来阻塞解除：** Phase 1（Workflows mode）现在可以基于这个统一的 skill 契约开始构建。

---

### 2026-05-17 · Phase 1a 完成（v0.2）

**范围：** 服务端 workflow 运行时 + REST API。无 UI——可以 `curl` 验证。

**新增文件：**

- `packages/server/nexus_server/workflows.py`
  - Pydantic 模型：`WorkflowDefinition` / `Workflow` / `WorkflowRun` / `WorkflowRunStep` / `WorkflowInputSpec` / `WorkflowStep`
  - CRUD：`create_workflow` / `get_workflow` / `list_workflows` / `update_workflow` / `delete_workflow`（cascade 删 run + step）
  - Run lifecycle：`start_run`（同步建 pending 行 + pre-seed step 占位）/ `execute_run`（异步循环）/ `get_run` / `list_runs`
  - Handoff 模板：`FIRST_STEP_TEMPLATE`（首步用 workflow inputs）+ `HANDOFF_TEMPLATE`（后续步骤用前一步输出），verbatim 取自原推
  - 默认 skill resolver 复用 Phase 0 SkillManager
- `packages/server/nexus_server/workflows_router.py`
  - 路由前缀 `/api/v1/workflows`
  - CRUD: GET/POST/PUT/DELETE on `/{id}`
  - Runs: POST `/{id}/run`、GET `/runs`、GET `/runs/{run_id}`
  - 运行用 FastAPI BackgroundTasks 异步起，202 立即返回，client poll `/runs/{id}`
- `packages/server/tests/test_workflows.py` —— 9 个测试覆盖 CRUD、user scoping、完整 run、缺 skill、LLM 崩溃、replay 幂等、HTTP 端到端

**改文件：**

- `packages/server/nexus_server/database.py` —— 加 3 张表：`nexus_workflows` / `nexus_workflow_runs` / `nexus_workflow_run_steps`。run 表预留 `anchor_tx` 列给 Phase 4。step 表 PK (run_id, step_index)。
- `packages/server/nexus_server/main.py` —— 挂载 `workflows_router.router`

**关键设计决策（跟 §8 推荐一致）：**

- **Q1** 选 YAML/JSON 描述（`definition` 列存 JSON）+ skill markdown 独立。Workflow 引用 skill 名，runtime 从 SkillManager 拉系统 prompt
- **Q2** Workflow step 可设 `model` override；不设则用 skill 的 `model`，再不设传 None 走 server 默认。三档 `strong/fast/cheap` 映射 Phase 1b UI 时落
- **Q3** 上限：当前未硬编码超时；Phase 3 marketplace 落档位 gating 时一起加
- **Q6** 服务端 SQLite 为单一源头（本地缓存 Phase 1b 桌面端建好后从 server 拉）

**验证：**

- ✓ 9 个新测试全过（CRUD、run、handoff、缺 skill、LLM crash、replay、HTTP）
- ✓ Server 全套 138 passed（**0 回归**）
- ✓ 模型干跑：fake LLM 注入，验证 step N 收到的 user message 里确实有 step N-1 的输出

**Phase 1a 阻塞解除：** Phase 1b 桌面端 UI 可以基于这个 API 开始构建（`WorkflowView` / `WorkflowEditorView` / `WorkflowRunView`）。

---

### 2026-05-17 · Phase 1b 完成（v0.3）

**范围：** 桌面端 Workflows UI，Linear / GitHub Actions 风格。

**新增文件：**

- `packages/desktop/RuneDesktop.UI/ViewModels/WorkflowsViewModel.cs`
  - `WorkflowsViewModel` 顶层（列表 + 选中 + 活动运行 + 2s 轮询）
  - `WorkflowItemViewModel` —— 一个 workflow 行 + 它的 input draft form 状态（跨选择保留）
  - `WorkflowInputFieldViewModel` —— 单个 input 字段（short text / longtext / select 三种）
  - `WorkflowRunSummaryViewModel` —— Recent runs 列表项
  - `WorkflowRunDetailViewModel` —— 完整 run 详情 + step 列表（in-place reconcile，避免 expander 展开态丢失）
  - `WorkflowRunStepViewModel` —— 单个 step 行
- `packages/desktop/RuneDesktop.UI/Views/WorkflowsView.axaml` + `.axaml.cs`
  - Full-bleed 280px / 1px / * 三栏布局，无 card-on-card 嵌套
  - 左侧 source list（SurfaceMuted 底，无 card chrome），分 WORKFLOWS / RECENT RUNS 两节
  - 右侧三态切换：空态（4 个 starter pack tile）/ workflow 详情（step flow + inputs + run）/ 活动运行（垂直 pipeline timeline）
  - 自动选首个 workflow，永远不留"请选择"空态
  - Run timeline 用 GitHub Actions 风格的节点 + 连线视觉

**改文件：**

- `packages/desktop/RuneDesktop.Core/Services/ChainModels.cs` —— 加 11 个 Workflow 相关 record
- `packages/desktop/RuneDesktop.Core/Services/ApiClient.cs` —— 加 7 个 workflow 方法（List / Get / Create / Delete / StartRun / GetRun / ListRuns）
- `packages/desktop/RuneDesktop.UI/ViewModels/MainViewModel.cs` —— `WorkflowsVm` 字段、`ShowWorkflows` 命令、`IsWorkflowsActive` 计算属性、logout 停 polling
- `packages/desktop/RuneDesktop.UI/Views/MainWindow.axaml` —— 用户菜单加 "Workflows" 项、column 2 加 WorkflowsView IsVisible 绑定

**UI 设计决策：**

- **抛弃 card-on-card 嵌套**——视觉结构靠 typography + whitespace，不靠盒子套盒子
- **Step flow visualization**——选中 workflow 显示 `Strategist → Researcher → Writer → Editor → Publisher` pill chain
- **真正的 pipeline timeline**——run view 用垂直连线 + 节点圆点，每个节点 2px stroke 绕一个 SurfaceBase 实心圆，颜色绑定 step status（pending 灰 / running 蓝 / succeeded 绿 / failed 红）
- **自动选首个 workflow**——`RefreshAsync` 末尾 if `Selected == null && Workflows.Count > 0 → Selected = Workflows[0]`，杜绝空右侧
- **空态用 4 个 starter pack tile**——Content Studio (Free) / Research Brief (Free) / Code Review (Pro) / Radiology Pro，配档位徽标，比抽象图标有用
- **In-place reconcile of step rows on poll**——避免 expander 展开/折叠态被 2s 轮询重置
- **Status hex string → IBrush 自动转**——VM 存 `#0A84FF` 字符串，XAML 直接 `Background="{Binding StatusColor}"`（Avalonia implicit converter）

**未编译验证：** sandbox 没装 dotnet，下次 `./scripts/build-macos.sh` 时如果有 build error 会冒出来。已经手动 review 了所有 Avalonia binding 表达式（特别注意 `SolidColorBrush.Color` 不会自动从 string 转，所以 BorderBrush 直接 bind 字符串而不是嵌套 `<SolidColorBrush Color="...">`）。

**Phase 1b 阻塞解除：** Phase 2 starter packs 可以开干——需要写 5 份 workflow definition JSON + 对应 skill markdown，然后 seed 到测试用户。

---

### 2026-05-17 · Phase 2 v1 完成（v0.4）—— 一键安装入口

**背景：** 之前的 Workflows 空状态展示 4 个 starter pack 卡片只是装饰，install 路径要用 `python3 scripts/seed-test-workflow.py` 跑脚本——开发期 hack，绝非产品。本轮把入口做正：empty state 4 张卡片变成可点的 Install 按钮，从 server 端 bundled 资产直接装。

**新增 server 端：**

- `packages/server/nexus_server/starter_packs/content-studio/`
  - `workflow.json` —— workflow 定义
  - `skills/content-strategist.md` / `content-researcher.md` / `content-writer.md` / `content-editor.md` / `content-publisher.md` —— 5 个 agent prompt
- `packages/server/nexus_server/starter_packs.py`
  - `PACK_CATALOG` 4 个 pack 元数据（Content Studio 完整，其余 3 个 `available=false` + `coming_soon_note`）
  - `list_packs()` / `get_pack(id)` / `install_pack(user_id, id)` —— install 拷 skills + 建 workflow，幂等（同名 workflow 自动替换）

**改文件：**

- `packages/server/nexus_server/workflows_router.py` —— 加 `GET /packs` + `POST /packs/{id}/install` 路由
- `packages/server/pyproject.toml` —— 加 `[tool.setuptools.package-data]` 把 `starter_packs/**/*.json` + `**/*.md` 打进 wheel（否则 PACKS_ROOT 在 installed wheel 里找不到资产）

**新增 client 端：**

- `ChainModels.cs` —— `StarterPackInfo` + `StarterPackListResponse` records
- `ApiClient.cs` —— `ListStarterPacksAsync` + `InstallStarterPackAsync`
- `WorkflowsViewModel.cs`
  - `Packs` collection（每次 Refresh 重新拉）
  - `InstallPackAsync(pack)` 命令——拒绝 `!Available` pack，install 成功后自动 select 新建的 workflow
  - `StarterPackItemViewModel` —— 单 pack 行 VM，含 `IsInstalling` 状态 + `TierLabel/TierColor` 计算
- `WorkflowsView.axaml` —— 空状态那 4 个硬编码卡片改成 ItemsControl 绑 `Packs`，每张含 Install 按钮，coming-soon pack 显示灰色提示

**关键设计：**

- Pack 资产**跟着 server bundle 一起发**，不是远程 registry。Phase 3 marketplace 才上远程。这让一键安装无网络依赖，install 是纯本地文件拷 + DB insert
- **Install 幂等**——同名 workflow 自动替换（cascade 删 runs），re-install 不会堆重复
- **Skill 文件拷到 `Path.cwd() / .nexus / skills`**——跟 SkillManager 默认扫的路径一致，desktop bundle 跑 server 时 cwd = $RUNE_HOME，所以 install 后 SkillManager 立即能 resolve 到
- **Coming-soon packs 在 catalog 里有占位**——UI 能完整渲染 4 张卡片讲全产品故事（不只有 Content Studio），但 install 端点会 403 拒绝（PermissionError），UI 卡片那边直接灰按钮 + 注解

**验证：**

- ✓ 5 个新 pytest 全过（list / install / 幂等 / 403 / 404）
- ✓ Server 整套 **143 passed**（之前 138 + 5 新），0 回归
- ✓ 端到端：register → POST install → 验证 workflow 行 + skill 文件都在

**Phase 2 v1 阻塞解除：** seed-test-workflow.py 现在可以正式淘汰（虽然作为 dev tool 留着也行）。Phase 2 v2 = 把 Research Brief / Code Review / Radiology Report 三个 pack 也补完。Phase 3 marketplace 用户能 import / share 自建 workflow 的 .workflow YAML。

---

### 2026-05-17 · Phase 2.5 (Pattern 2) 完成（v0.5）—— Workflow → Chat 单向打通

**背景：** 用户的 workflow run 跑完拿到 9-tweet thread，想说"第 3 条改 punchier 一点"——之前没法做，run 是个一次性 artifact。这一轮把 workflow 输出注入 chat 让用户可以无缝 chat-iterate。

**Pattern 2（已 ship）：**

- Server: `POST /api/v1/workflows/runs/{run_id}/send-to-chat` —— 把指定 step 的输出（默认最后一步）作为 assistant message 写入 user 的 twin event_log，附 `source=workflow_run` + `workflow_run_id` metadata 用于 citation 渲染
- Client: WorkflowRunDetailView 的 succeeded 状态显示 "Send to chat" 按钮 + 说明文案。点完触发 `WorkflowsViewModel.SendActiveRunToChatAsync`：API call → 显示"Sent to chat" 状态 → 500ms 后 `_navigateToView("chat")` 跳回 chat surface
- `WorkflowsViewModel` ctor 接 `SessionListViewModel` 和 `Action<string> navigateToView` 依赖，由 MainViewModel 注入

**Pattern 1（部分准备好，下一轮 ship）：**

server 端 schema forward-compatible 已经就位但未真正接驳到 production chat 路径：

- `LLMChatResponse` 新增 `workflow_suggestion: Optional[WorkflowSuggestion]` 字段
- `WorkflowSuggestion` Pydantic model 定义好（workflow_id + prefilled_inputs + reason）
- `TOOL_DEFINITIONS` 加 `suggest_workflow` 工具描述，agent 调用时返回结构化建议

**为什么 Pattern 1 没完结：** production chat 走 TwinManager → SDK DigitalTwin.chat()，工具注册中心在 SDK 不在 server。要让 `suggest_workflow` 真正被 production agent 调用，需要去 `packages/sdk/nexus_core/tools/` 注册新工具 + 让 twin 知道这个 tool 的存在。属于 Phase 2.5b 任务。

**验证：** server 全套 143 passed（无回归）。Pattern 2 端到端流程：run 跑完 → 点 Send to chat → 500ms 后 view 切到 chat → assistant message 出现，body 是 markdown header（"From content-publisher (step 5 of 5 in workflow run wf_xxx)"）+ 完整最后步骤输出 → 用户继续打字 chat-iterate。

---

### 未发布

Phase 2.5b: `suggest_workflow` 接驳 SDK twin 工具注册中心，让 production agent 真的在合适场合推 workflow 卡片到 chat
Phase 2 v2: Research Brief / Code Review / Radiology Report 3 个 pack 补完
Phase 3: Marketplace + 档位 gating
Phase 4: 链上 anchor
Phase 5: Launch
