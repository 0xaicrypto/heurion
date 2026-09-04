# Journal Selection Design — 选刊能力升级

**Status:** Approved v1.0(2026-09-04,基于 #639-r5 会话评审)
**关联:** #382(写作↔投稿联动,已闭环)/ epic #834(Tier J3 OpenAlex)/ ARCHITECTURE_OPTIMIZATION §19(投稿工作流)/ #839(引用对账 — 信任哲学同源)

## 0. 现状盘点(2026-09-04 代码核查)

`modules/submission/journals.ts`(92 行)= **硬编码 18 本肿瘤期刊**:
- IF/接受率/审稿周/中科院分区为手写常量 — IF 年更(6 月),硬编码即过时即撒谎,且无来源无"截至"标注
- 匹配 = 标题关键词×3 + 摘要×1.5 + 5 条中文别名,无标准可解释
- 只有肿瘤科 — 与"全科室临床 AI"定位(#837-identity)不符
- reason = 命中词拼接,非结构化证据

结构性结论:选刊需要从"静态数组 + 隐式打分"升级为"**仓储 + 规则引擎 + 诚实的数据新鲜度**"。

## 1. 核心决策 D1-D6

| # | 决策 | 理由 |
|---|---|---|
| **D1** | **JournalRepository** 替代硬编码数组:seed 快照(内置 ~200 本核心医学刊,全科室)+ OpenAlex/DOAJ 动态补充 + #835 external-fetch 缓存 | 数据与逻辑分离;seed 保证离线可用;动态层补齐长尾 |
| **D2** | **数据新鲜度分层**:可免费 API 的(OpenAlex/Crossref/DOAJ)真拉取(24h 缓存);专有数据(JCR IF/中科院分区)用**年度快照 + "数据截至"强制标注** | "实时"诚实性原则 — 医疗场景宁可标注旧,不可假装新。快照过期 > 18 个月时 UI 显示"数据陈旧"警示 |
| **D3** | **三档梯度推荐**(冲/稳/保,各 2-3 本)替代单一 Top5:冲刺档明说差距,匹配档按研究类型×scope,保底档按速度/接受率 | 作者真实决策是梯度博弈;单一列表隐含"都要冲"的误导 |
| **D4** | **推荐理由结构化**:每维证据行(Scope 命中点/研究类型适配/影响力分区/速度与接受率/APF 费用),拒绝拼接话术 | 对齐 #839 信任哲学:说"为什么"要说得可核对 |
| **D5** | **红线防护一等公民**:中科院预警期刊名单(年度快照)命中即灰显 + 原因;掠夺性期刊 DOAJ 交叉校验 | 医疗合规红线,优先级高于任何推荐体验 |
| **D6** | **Logo = ISSN monogram**(首字母字标 + 出版商色板),不逐刊爬取 | 版权 + 维护双坑;Crossref/OpenAlex 官方 logo 缺口大,monogram 零风险 |

## 2. 数据源矩阵

| 数据 | 来源 | 新鲜度 | 成本 |
|---|---|---|---|
| 刊名/ISSN/出版商/DOI 前缀 | Crossref journals API | 24h 缓存 | 免费 |
| 引用量级/h-index/OA 比例/**topic 分布**(同类文章占比) | OpenAlex sources(#838) | 24h 缓存 | 免费 |
| OA 状态/APC 费用/许可 | DOAJ API | 24h 缓存 | 免费 |
| SJR | Scimago CSV 导入 | 年度快照 | 免费(无官方 API) |
| JCR IF | **Clarivate 专有** | 年度快照 + 截至标注 | 快照维护 |
| 中科院分区 | 第三方(LetPub 等) | 年度快照 + 截至标注 | 快照维护 |
| 预警期刊名单 | 中科院国际期刊预警名单 | 年度快照 | 快照维护 |
| Guide for Authors(字数/摘要结构/图表上限/引用格式) | 期刊官网抓取(medical-web-tools 既有能力) | 投稿前按需抓取 | 免费 |

## 3. 契约

```ts
interface JournalRecord {
  id: string                     // issn 优先,slug 兜底
  name: string
  issn?: string
  publisher?: string
  // 指标(各带来源与新鲜度)
  metrics: {
    impactFactor?: { value: number; asOf: string; source: 'jcr_snapshot' }
    casZone?: { value: string; asOf: string }
    sjr?: { value: number; asOf: string }
    acceptanceRate?: { value: number; asOf: string; source: string }
    reviewWeeksMedian?: { value: number; asOf: string }
    apcUsd?: { value: number; source: 'doaj' }
    openAlex?: { hIndex: number; worksCount: number; oaRatio: number; asOf: string }
  }
  scope: string[]                // 学科标签(OpenAlex topics + 内置)
  articleTypes: string[]         // 历史接收的研究类型分布(OpenAlex)
  warnings?: Array<{ kind: 'cas_warning_list' | 'predatory_signal'; asOf: string; note: string }>
  logo: { monogram: string; color: string }   // D6
  freshness: { seed: boolean; updatedAt: string }
}

interface Recommendation {
  journal: JournalRecord
  tier: 'reach' | 'match' | 'safety'
  breakdown: Array<{ dimension: string; score: number; evidence: string }>  // D4 结构化理由
  totalScore: number
}

interface SelectionProfile {      // ① 输入画像
  title: string; abstract?: string
  articleType?: 'rct' | 'cohort' | 'case_report' | 'review' | 'meta' | 'real_world' | string
  priority?: 'impact' | 'speed' | 'acceptance'      // D3 档位偏好权重
  selfPayOa?: boolean
  language?: 'en' | 'zh'
}
```

## 4. 作者流程(六步,#382 线性流程升级)

```
① 选题画像(写作 Tab,已有) — 自动:标题/摘要 + 研究类型识别;
   手动:档位偏好(影响力/速度/接受率)+ 自费 OA 意愿
② 梯度推荐(投稿 Tab) — 冲/稳/保三档各 2-3 本;每本对比卡
   (monogram·IF·分区·接受率·一审周期·APF·同类文章占比);
   顶部红线区:预警期刊灰显 + 原因
③ 对比决策 — 并排对比;每本可展开"为什么推荐/为什么不是顶刊"(D4)
④ 选定 → 格式对齐(#382 已有:模板→写作→AI 填充)
   新增:References 格式按刊切换(AMA/Vancouver)
⑤ 投稿前检查(新增) — 抓取该刊 Guide for Authors →
   字数/摘要结构/图表上限/引用格式逐项 ✓✗
⑥ 拒稿回流(闭环) — 标记被拒原因 → 同梯队自动补推替补刊
```

## 5. 匹配引擎

- **规则引擎**(可配置权重):`scope 匹配 × articleType 分布 × 影响力档位 × 速度 × 费用`,权重由 `SelectionProfile.priority` 驱动(impact/speed/acceptance 三预设 + 医生个人微调)
- **复用**:多路打分融合参考 `retrieval/rrf-fusion` 思想;外部数据走 `#835 externalRequest`(per-host 节流 + 24h 缓存)
- **梯度分档**:按 totalScore 排序后,以"匹配档"为锚(得分带中心),上取 reach、下取 safety;**警告期刊任何档位不得入选**,只在红线区展示
- **中文刊(Tier J4)**:P3 — 设计文档 RESEARCH_WORKSPACE L675 明示医生核心需求,licensing 复杂,先以快照收录核心中文刊目录(不接全文)

## 6. 合规红线

| 红线 | 保证 |
|---|---|
| 预警/掠夺性期刊 | D5:任何档位不得推荐,仅红线区灰显 + 原因 + 名单 asOf |
| 数据诚实性 | D2:专有指标必须带 asOf;快照超期警示 |
| 推荐可解释 | D4:breakdown 每行可核;无证据维度不出现在理由里 |
| 费用透明 | OA 刊必须展示 APC(DOAJ),自费意愿未开启时降低 OA 权重 |

## 7. 分期

- **P1(零新外部依赖)**:JournalRepository(seed 扩容 ~200 刊 + freshness)+ 三档梯度推荐 + 结构化 breakdown + 预警名单快照灰显 + SelectionProfile 输入
- **P2**:#838 OpenAlex client(topic 分布"同类文章占比")+ DOAJ APC + ISSN monogram logo
- **P3**:Guide for Authors 抓取校验(⑤)+ 拒稿回流(⑥)+ 中文刊 Tier J4

## 8. 决策记录

> 实施中发现决策前提不成立,须回到本节修订并注明日期,不得静默偏离(同 SKILL_EVOLUTION_DESIGN §6.1)。

- D1-D6 定案于 2026-09-04 评审(本轮会话);"实时更新"采纳为 D2 分层新鲜度而非全量真实时 — 专有指标无免费 API,假装实时=数据撒谎
