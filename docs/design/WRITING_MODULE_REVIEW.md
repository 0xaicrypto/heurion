# 写作模块评审 — 产品设计与代码问题

> **日期**：2026-09-11 ~ 2026-09-12
> **范围**：`packages/server-ts/src/modules/documents`、`modules/chat`（doc- 会话链路）、
> `tools/edit-document-tool.ts` 等写回工具、`packages/web/src/routes/writing*`
> **方法**：两个并行审计 agent（后端写作管道 / 前端写作 UI）+ 直接读代码验证 + 近 30
> 条相关提交历史（#892→#989）交叉核对，随后对 `4c9dfb87..HEAD` 的实际修复 diff
> 做了第二轮复核（`/code-review` 流水线 + 人工验证）。
> 本文档分两部分：**第一部分**是初次评审给出的产品设计与代码问题；**第二部分**
> 是针对后续修复提交的复核结论（哪些已修对、哪些修复引入了新问题）。
> **姊妹篇**：针对本文问题的"完全不受现有实现约束"的重新设计构想见
> [`WRITING_MODULE_REDESIGN.md`](./WRITING_MODULE_REDESIGN.md)（北极星方案，
> 含桌面/组件/移动三块画布截图与可交互画布链接）。

---

## 现状定性

从 commit 历史看（#892→#967→#976→#977→#978→#979 一路下来），写作链路经历过多次
真实生产事故（"声称完成但零写回"、GLM 流式工具调用被丢弃、上下文过大导致工具调用
可靠性坍塌）。团队早期的应对方式基本是**在同一层不断加正则/启发式补丁**：编辑意图
词表、声明-执行对账、连败直通、清单账本防伪造……这些补丁工程质量不低（有回归测试、
有诚实失败兜底），但模式上是"头痛医头"——没有从根子上解决"LLM 不可靠地调用工具/
复述原文"这个问题，而是在外面加越来越多层的检测网。这是本次评审最主要的切入点。

---

# 第一部分：初次评审

## 一、产品设计层面

**1. 统一"变更如何落地"的心智模型（最值得做）**
写入路径至少有 4 条并行、体验不一致的分支：AI 编辑走 diff review 确认；手动保存走
409 冲突横幅（keep mine / load latest）；`generateMethods`/`injectResults` 直接
`setBody` 覆盖，完全不过冲突检测；deck 冲突只弹一个 6 秒 toast，没有任何可操作按钮。
用户很难建立"我的修改什么时候会被覆盖"的稳定预期。建议把所有写入路径收敛成一种
"提议变更 → 用户确认/自动确认 → 落盘"的统一组件。

**2. AI 编辑过程不可见，只有"事后一次性大 diff"**
写回被缓冲最长 60 秒（`BATCH_FALLBACK_MS`）才展示，AI 多步编辑期间画布看起来是
"冻结"的，只有旁边聊天面板在动。对一个主打"对话驱动写作"的产品，编辑过程的可见性
直接影响信任感。

**3. 把后端的"账本纪律"转化为用户可感知的信任标记**
`set_task_plan` 账本已经做了很好的工程——写回步骤只能被系统在工具真正成功后自动
推进，模型无法自行声称完成。但这套"真实性验证"目前只是说给模型听的，用户侧看不出
"这一步是系统验证过的，还是模型自称的"。生产事故的核心痛点就是"模型说做了但没做"，
这个验证结果理应是给用户看的最直接的信任信号。

**4. 减少对"意图分类器"的路径依赖，给编辑动作一个显式开关**
TurnIntent 的分层判定设计得不错，但落地严重依赖手工维护的中英文关键词
表（`EDIT_MARKERS`、`DISCUSSION_MARKERS`……），近 10 次提交都是"补充漏掉的触发词"，
本质是打地鼠。产品层面给用户一个低成本的显式确认入口（比如气泡工具栏的"应用到文档"
按钮，或聊天区一个"讨论/编辑"模式切换），能把很大一部分判断负担从语言理解转移到
一次点击。

**5. 文档编辑用"整段原文复制"做锚点，体验上等价于"经常因为文字对不上而重试"**
`edit_document` 的 range 模式要求模型把 `old_text` 一字不差地从文档里复制出来，靠
三级模糊匹配兜底。用户能直接感知到的表现就是"AI 说改了但没找到位置""提示重新复制
原文"。建议给文档段落/章节一个稳定 ID，让模型按 ID 引用而不是按原文匹配。

**6. PHI/合规扫描不是自动的写作安全网**
作为面向临床科研的产品，AI 编辑路径完全不过 PHI 检查，扫描器要用户手动触发且规则
很弱（英文姓名正则、仅美国 SSN 格式）。建议至少做成写回后自动异步跑一遍、给出
非阻塞警示。

**7. Deck 与正文两个数据源容易静默分叉，且没有真正的解决 UI**
只有文案提示"放弃本地修改或采纳 AI 的"，没有实际的操作按钮，是个半成品功能。

**8. 只有整篇快照回滚，没有"按 AI 回合撤销"**
长文档多轮协作写作时，用户想撤销 AI 刚才一次编辑，但不想连带丢失自己之后做的修改
——目前做不到。

## 二、代码层面

### 后端 — 高优先级（数据一致性/安全）

- `documents.router.ts:102-185`（PUT 手动保存）存在 TOCTOU 竞态：`base_sha` 校验读
  的是事务外的 `existing.body`，两个并发 PUT 都能通过校验，后写的静默覆盖前写的，
  与别处 `writeDocVersion` 单点模式不一致。
- `documents.router.ts:79-86`：`PRAGMA foreign_keys = OFF` 后没有 `try/finally`，
  fallback insert 抛错时该连接的外键约束会一直保持关闭。
- `chart-renderer.ts:207`：柱状图数值标签直接拼进 SVG `<text>`，没有转义，`ChartInput`
  无运行时校验，理论上可造成 SVG/XML 注入。
- `edit-document-tool.ts:348-357`：全量重写的输出预算护栏用全局 `resolveActiveModel()`，
  不是本次会话实际生效的模型。
- `insert-asset-tool.ts:129` 用裸 `sessionId.slice(4)` 取 docId，没有像
  `edit-document-tool.ts:82` 那样走 `parseDocSessionId` 校验。
- **（自行发现）** `plan-store.ts:191-202`（`autoAdvanceWriteStep`）按"工具名"FIFO
  匹配来推进账本步骤，不校验语义对应关系，乱序执行时账本可能记错是哪一步完成的。
- **（自行发现）** `retrieval/query-router.ts:105` 的 `EDIT_MARKERS` 和
  `doc-executor.ts:31` 的 `DOC_EDIT_INTENT_RE` 是两份独立维护、词表不同步的正则，
  历史上多次因漏词导致误判。

### 后端 — 中优先级（可靠性/性能）

- `doc-context-builder.ts:177-179`：每轮无论请求多小，都把全文档（上限约 48K token）
  重新注入 context；`doc-executor.ts:136` 的兜底路径还会再读一次全文。
- 三套独立的"声明-执行对账"正则叠加：`EDIT_CLAIM_RE`、`countClaimedEditItems`、
  `tool-loop.ts` 内联检测，分别在不同 hotfix 里加的，且只认中文。
- `doc-context-builder.ts:90-116` 引用材料相关性判断是关键词/子串匹配，误判后模型
  唯一的挽救手段是 `import_reference`，而这会**整篇覆盖正文**。
- `markdown-export.ts:301-317, 491-509` 导出图片是 `for` 循环里顺序 `await`。
- `guide-for-authors.ts:22-36` 的 `fetchPageText` 无 SSRF 防护。
- `documents.router.ts:389-394` `/docs/:docId/chat` 已是 410 Gone 的废弃端点。

### 前端 — 高优先级（数据完整性 bug）

- `writing-editor.tsx` 路由缺少 `key={docId}`：切换文档时组件被复用，A 文档未处理的
  diff/冲突横幅可能残留渲染在 B 文档上，接受操作会把 A 的合并内容写进 B。
- `doc-merge.ts:41-49` 冲突检测用严格不等式判断区间重叠，两个发生在同一位置的纯插入
  不会被判定为冲突，会悄悄错序合并。
- `handleInjectResults`/`handleGenerateMethods` 直接 `setBody` 覆盖正文，绕过 diff-review。
- diff 处理后二次保存失败且非 409 时，只弹 6 秒 toast，不会把 `dirty` 置真，内容可能
  悄悄丢失且用户毫无感知。

### 前端 — 中优先级（体验/可访问性/可维护性）

- 弹窗无 `aria-modal`/焦点陷阱/Esc；deck 拖拽排序无键盘替代方案。
- 危险操作用原生 `window.confirm`，跳出应用自己的对话框体系。
- `writing-editor.tsx` 1164 行，状态逻辑并未真正下沉到 hooks。
- `ChatPanel`/`Toolbar` 未 `memo`；deck 视图不可见时仍每次按键重新解析全文。

## 三、落地顺序（初次评审建议）

1. **P0**：`writing-editor.tsx` 路由加 `key` 修跨文档串数据；PUT 端点改走
   `writeDocVersion`；`chart-renderer.ts` 数值转义。
2. **P1**：统一编辑意图词表；合并三套声明-执行检测器；`generateMethods`/
   `injectResults` 接入统一 diff-review；`doc-merge.ts` 补齐同点并发冲突检测。
3. **P2（结构性）**：从"原文模糊匹配"迁移到"稳定段落/章节 ID 引用"。

---

# 第二部分：修复复核（`4c9dfb87..HEAD`）

初次评审后，团队对以上几乎每一项都提交了对应修复（#980-#989 系列，约 31 个文件、
1579 行新增）。复核方法：对照原始发现逐条读 diff 验证是否真正修对，并用
`/code-review` 对整段 diff 做了一次独立系统性复核（找问题 + 逐条验证）。

## 一、原问题修复情况

| 原问题 | 修复方式 | 核实结论 |
|---|---|---|
| 路由不带 `key`，切换文档串数据 | `App.tsx` 加 `WritingEditorRoute` 用 `key={docId}` 强制重挂载 + `writing-editor.tsx` 再加一层保险 effect 清空写状态 | ✅ 正确，双保险 |
| `doc-merge.ts` 同点插入不判冲突 | 加"同锚点零宽 hunk"判定，不影响合法的相邻追加场景 | ✅ 正确 |
| 二次保存失败静默丢内容 | 改为常驻警示条 + 自动回灌 `dirty` 触发 autosave 重试 | ✅ 正确 |
| `autoAdvanceWriteStep` FIFO 误判步骤 | 加 `step_index` 精确匹配，未提供时回退 FIFO | ✅ 方向正确，但引入次生问题（见下） |
| `EDIT_MARKERS`/`DOC_EDIT_INTENT_RE` 两份独立正则表 | 合并到 `common/edit-intent.ts` 单一来源 | ✅ 正确 |
| 三套"声明-执行"检测器重叠 | 合并进 `edit-reconciliation.ts`，补了双语 | ✅ 正确 |
| `documents.router.ts` PUT 竞态 / PRAGMA 无 try-finally / 废弃端点 | 改走 `writeDocVersion`、加 try/finally、删掉 410 端点 | ✅ 方向正确，但迁移过程引入新问题（见下） |
| `chart-renderer.ts` SVG 注入 | 加 `chartInputSchema` 入口强校验 + 数值/颜色转义 | ✅ 堵住注入，但校验强度带来新的可用性风险（见下） |
| **架构建议**：模糊锚点 → 稳定结构 ID | 新增 `block-projection.ts`（section/block 投影）+ `edit_document` 的 `target_section` 确定性编辑模式，锚点模式保留兜底 | ✅ 分量最重的一项，整体设计谨慎（保留兜底、埋了 A/B 遥测、显式记录已知边界），细节仍有问题（见下） |

## 二、新发现的问题（按严重程度排序）

**1. `documents.router.ts:179` — title 更新脱离原子性，且无 try/catch**
`writeDocVersion` 单独成事务提交 body/deck 后，title 用一条独立的、事务外的
`prisma.doc.update` 补充更新，且没有包 try/catch。如果这次更新失败（网络抖动/
连接断开），body 已经落库但 title 静默留在旧值。**这恰好是这次重构本想解决的问题
（写回原子性）在 title 字段上开了个新口子**，建议优先修。

**2. `edit-document-tool.ts:157` — `section_action` 传错/漏传会静默退化成最具破坏性的 `replace`**
三元判断链 `append ? : prepend ? : delete ? : 'replace'`，任何不认识的值或字段缺失
都会落到 `replace`，整节内容被覆盖，没有任何报错。建议改成显式校验 + 拒绝。

**3. `chart-renderer.ts:211` — `safeNum(e.w || 11)` 漏改的 falsy-zero 老问题**
这一行用 `||` 而不是同文件其它地方一致使用的 `??`，模型显式传 `w: 0` 时会被误判成
"没传"而替换成 11。修 SVG 注入那批改动（#981）时这一处漏改了，一行代码即可修。

**4. `plan-store.ts` — `step_index` 精确匹配没有兜底，匹配失败会静默不推进账本**
修 FIFO 误判问题时引入的次生问题：如果模型传的 `step_index` 是过期/错位的值，
`autoAdvanceWriteStep`/`markWriteStepFailed` 找不到匹配项就直接返回 `null`，调用方
什么都不做——写回其实成功了，但账本永远卡在"未完成"，且没有任何日志或提示。这正是
"账本纪律"机制存在的意义所在，现在反而可能悄悄失真。建议：不匹配时至少落一条警示
事件/日志。

**5. `edit-document-tool.ts` 的 `sectionEdit`（以及 `rangeEdit`/`fullReplace`，这是
预先存在的架构模式，非本次新引入）— 读-算-写之间有竞态窗口**
先读一次文档算出新正文，再调用 `writeDocVersion`（内部自己再读一次做乐观锁校验）。
乐观锁只保护"`writeDocVersion` 自己读到写之间"没有被并发修改，保护不了"调用方最初
那次读到 `writeDocVersion` 内部读之间"这段窗口——如果这段窗口里有并发写入，乐观锁
会通过校验，但写进去的内容是基于更早、已过期的快照算出来的，等于悄悄覆盖了中间那次
并发修改。窗口很窄（毫秒级），中等优先级，值得记录在案。

**6. `block-projection.ts` — section 是扁平模型，删除/重写一个标题不会带上它嵌套的子标题**
比如 `## Methods` 下面嵌了 `### Subsection A`，`section.end` 停在下一个标题行（不管
层级），对 Methods 做 `delete`/`replace` 只会动到 Methods 自己的引言文字，
`Subsection A` 会完整保留、"孤立"在原位置。不算数据丢失，但和直觉预期不一致，且没有
报错提示这个截断。更像需要产品/工程共同决策的设计边界。

**7. `chart-renderer.ts` — 新加的 `chartInputSchema` 用 `z.number()` 严格校验，可能
把之前能容忍的输入打回**
比如模型把数值字段输出成字符串（LLM 工具调用参数里不算罕见），之前大概率能容忍，
现在会被直接拒绝，整个图表渲染失败。建议把数值字段从 `z.number()` 换成
`z.coerce.number()`。

**8. 次要项（低优先级）**：
- `writing-editor.tsx:409` — 手动保存不会更新前端本地的 `doc.block_projection`，
  导致"AI 正在编辑哪个节"这个新指示器在特定顺序下可能显示错的节（只影响提示准确性，
  不影响正文数据）。
- `documents.router.ts:119` — `writeDocVersion` 内部会自己重新查一次文档，和外层
  已查过的 `existing` 重复了一次 SELECT，纯性能小浪费。
- `block-projection.ts:41` 的 `HEADING_RE` 是从 `doc-sections.ts` 复制粘贴过来的，
  注释里自己承认"要保持同口径"——这正是这次专门修掉的"正则表分叉"那类问题，新模块
  里又出现了一次同类风险，建议直接 import。

## 三、总体评价

这一轮改动质量很高，尤其是块级投影这个架构级修复，思路和落地都很扎实。新出现的
问题基本都是"修一个坑时在旁边留了个小坑"性质——没有推翻此前的判断，说明改动方向
是对的。**建议优先处理 1、2、3 三项**（原子性、破坏性默认值、falsy-zero），都是
几行代码就能收尾的高置信度问题；4、5、6、7 可放进下一轮迭代。
