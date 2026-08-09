# 科学图表与统计工作台 — AI 交互式图表生成（Stats + BioScene）

> **状态**：设计稿 v1（2026-08-08）
> **范围**：`packages/server-ts`（chat / execution / plugins / tools）、`packages/worker`（执行层）、`packages/web`（工作台 UI）
> **关联**：`docs/design/RESEARCH_WORKSPACE_DESIGN.md`（研究空间总体设计）、`PLUGIN_MANIFEST_SPEC.md`（插件清单规范）、`SIDECAR_TO_PLUGINS_REFACTOR.md`（sidecar→插件重构）
> **本文档解决**：论文工作台内"AI 交互式生成复杂科学图表"——统计分析（对标 GraphPad Prism）与分子生物/机制示意图（对标 BioRender）

---

## 1. 背景与目标

### 1.1 现状问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | 论文工作台无统计分析能力，用户需导出数据到 Prism/SPSS 手工分析 | 工作流断裂，数据反复搬运 |
| 2 | 现有 `stat-tools.ts` 为**手写纯 TS 统计实现**（不完全 beta/gamma 求 p 值），未经参考实现对拍 | 医学发表场景不可信，期刊统计审稿有风险 |
| 3 | 无分子生物/机制示意图能力（细胞、通路、受体-配体机制图） | 图形摘要/机制图需外部工具 |
| 4 | 统计工具零散（stat_ttest/stat_km/stat_ai），无统一分析工作流、无方法学报告 | AI 只能"给建议"不能"给结果+可引用输出" |

### 1.2 目标

1. **统计核心**：对标 Prism 的分析能力（t 检验族、ANOVA、非参、卡方、回归、生存、ROC），全部基于学术界参考库（scipy/statsmodels/lifelines），拒绝手写
2. **正确性护栏**：LLM 只"提议"分析，执行由白名单+结构校验的受控层完成；正态性门控自动降级；与 scipy 参考输出对拍进 CI
3. **AI 交互闭环**：上传数据 → AI 提议 → 执行 → 出版级图表 + 方法学报告（可直接进论文 Methods）→ 用户迭代
4. **分子生物示意图**（BioScene）：LLM 从受限 CC-BY 图标目录选图标组合成场景 JSON，SVG 渲染器绘制，可编辑可导出
5. **统一执行层**：两者都作为执行层插件，复用现有 sidecar/worker 队列架构，零新基建模式

### 1.3 非目标（本期不做）

- 非线性回归（四参数剂量反应）的完整曲线拟合 UI（Gen 2）
- .pzfx（Prism 文件格式）导入导出（Gen 3）
- 期刊级排版（多面板组合、figure legend 自动生成）（Gen 2）

---

## 2. 总体架构：执行层插件模式

完全复用现有执行平面（`execution-plane.service.ts` + Redis `heurion:jobs` + `packages/worker`）：

```
用户（论文工作台聊天）
  │  "帮我比较两组生存率" / "画一张 EGFR 信号通路图"
  ▼
chat-handler（工具调用层）
  │  run_stats_analysis / render_scene 工具（schema 白名单）
  ▼
execution-plane.enqueue({ type, payload })   ← POST /api/v1/execution/jobs
  ▼
Redis heurion:jobs
  ▼
Worker 消费者（BRPOP 按 job type 路由）
  ├─ TS worker：渲染类（现有 plot/pptx/docx 不变）
  ├─ stats handler：统计分析（W1 TS / W2 Python）
  └─ scene handler：BioScene 渲染
  ▼
SSE 回执（job 状态轮询 / sidecar_file / 结构化结果）
  ▼
前端：交互图（render_chart）+ 方法学报告 + 可编辑画布
```

新插件登记三件套（与 pptx/docx/plot 完全同构）：
1. `packages/worker/src/handlers/<name>.ts` + `consumer.ts` 注册 job type
2. `plugin-capability.service.ts` 注册能力 → LLM 可见对应工具
3. 结果回执：结构化 JSON + 图表数据（走现有 SSE / job 状态链路）

---

## 3. 统计分析插件（对标 GraphPad Prism）

### 3.1 插件形态

- **job type**：`sidecar.heurion/stats.run_analysis`
- **工具**：`run_stats_analysis`（LLM 可见），参数 schema 白名单：
  ```json
  {
    "test": {"enum": ["ttest_unpaired","ttest_paired","ttest_welch","mann_whitney",
                      "wilcoxon","anova_oneway","kruskal_wallis","chi_square","fisher",
                      "pearson","spearman","linear_regression","km_logrank","roc"]},
    "data": {"oneOf": ["values_2groups","values_paired","grouped_table","contingency_table",
                       "xy_pairs","survival_table","continuous_x_y"]},
    "params": {"alpha": 0.05, "correction": "none|bonferroni|tukey", ...}
  }
  ```
- **结果**（统一形状，兼容现有 stat-tools 输出约定）：
  ```json
  {
    "report": {"method","test_stat","df","p_value","effect_size","ci","assumptions_checked","interpretation"},
    "chart": {"plot_type","data"},      // → 前端 render_chart
    "methods_text": "..."               // 可直接粘贴进论文 Methods
  }
  ```

### 3.2 计算层：两阶段演进

| 阶段 | 实现 | 覆盖 | 理由 |
|------|------|------|------|
| W1（TS，快速可用） | `jstat` + 现有手写 KM/log-rank（已测） | 描述统计、t 检验、卡方/Fisher、线性回归、KM+log-rank、Pearson/Spearman | 复用现有 worker 部署管线，1-2 天端到端 |
| W2（Python，正确性） | **同队列双消费者**：Python worker 消费 `stats.*` job types | 全部 + two-way ANOVA、非线性回归、Cox | scipy/statsmodels/lifelines 是期刊可引用的参考实现 |

Python worker 新增成本 = 一个新镜像 + VPS 部署配置（部署管线现成，参考 `packages/embedding-server` 的镜像构建）。现有 `stat-tools.ts` **不删**——降级路径，全部纳入对拍测试。

### 3.3 统计门控（执行层内建，非 LLM 决定）

1. **假设前提检查**：t 检验前 Shapiro-Wilk 正态性 → 不通过自动降级 Mann-Whitney，并在报告中说明（Prism 推荐行为）
2. **数据结构校验**：配对/分组/列联表形状不符直接拒绝（400 级错误返回，不静默）
3. **效应量与置信区间**：每个检验输出 effect size + 95% CI（论文规范）
4. **多重比较**：校正方法白名单（Bonferroni/Tukey/Holm），默认 none 并显式声明

### 3.4 Golden 对拍测试（正确性生命线）

- 每个统计函数与 **scipy/R 参考输出对拍**（误差 <1e-8），用例覆盖：边界 df、小样本、非正态、带 ties、极端值
- 现有手写 `stat-tools.ts` 的实现同样纳入对拍
- 对拍进 CI（`server-ts-ci.yml` 或独立 job），参考值由 Python 生成后固化

### 3.5 数据输入管线

- 复用 files 模块上传链路（`extractTextFromUpload` 已有）
- 新增 **CSV/Excel 解析器** → 归一化为上述 data shapes（表头推断 + 类型推断 + 数据预览）
- Gen 2 起支持 Prism 式数据表模型（XY/Column/Grouped/Contingency 四类，UI 中组织数据）

---

## 4. 分子生物/机制示意图（BioScene）

### 4.1 为什么不自建编辑器、不用 BioRender

- **BioRender**：图标/编辑体验最优，但企业订阅 10 人起按座付费、图表版权随账号、且其自身 AI 文生图已发布（供应商=竞品），无公开程序化建场 API → 仅保留"外链用户自行精修"作为可选项
- **自建场景图**：LLM 输出结构化 JSON + 受限 CC-BY 图标目录 → SVG 渲染。质量闸门 = 受限目录（LLM 只能从带语义标签的图标 id 中选，杜绝张冠李戴）

### 4.2 BioScene schema（草案）

```json
{
  "canvas": {"width": 1600, "height": 900, "background": "#ffffff"},
  "objects": [
    {"id": "obj1", "icon": "membrane_receptor", "x": 100, "y": 200, "scale": 1.0,
     "rotate": 0, "label": "EGFR", "colorize": "#4a90d9"}
  ],
  "connections": [
    {"from": "obj1", "to": "obj2", "type": "arrow|dashed|phosphorylation",
     "label": "P", "bend": 0}
  ],
  "annotations": [
    {"type": "text|callout|bracket", "x": 50, "y": 50, "text": "Ligand binding", "size": 24}
  ]
}
```

- 渲染器：SVG（React 组件直接可用），校验 icon 存在性与类型
- 编辑闭环：用户拖拽 → 场景 JSON 回填对话上下文 → AI 基于当前场景迭代修改

### 4.3 图标资产管线（CC-BY，混合用户合规）

| 来源 | 许可 | 内容 | 备注 |
|------|------|------|------|
| Bioicons | CC-BY | 数千个分子生物学 SVG（细胞/蛋白/通路/化学） | 主力 |
| Servier Medical Art | CC-BY | 解剖/细胞/疾病图示 | 医学通用 |
| SciDraw library | 开源 | 高质科研插图 | 补充 |
| Reactome | CC-BY | 通路图标/组件 | Gen 2 通路渲染 |

- 抓取 → 归一化 `icons.json`（id / 名称 / 语义标签 / SVG path / 分类），MVP 子集约 500 个（膜、受体、激酶、离子通道、细胞器、细胞类型）
- 每个图标带**语义标签**（供 LLM 检索与校验），CC-BY 署名信息随导出元数据携带

### 4.4 定位与预期管理

AI 生成的分子图为 **"AI 起草 + 专家精修"** 定位（同 BioRender AI），不承诺发表级。正确性底线：语义标签检索 + 渲染器校验 + 场景 JSON 可编辑。

---

## 5. 分代路线图

| 代 | 内容 | 估算 |
|----|------|------|
| **Gen 1（MVP）** | 统计：描述/t 检验族/Mann-Whitney/卡方/Fisher/线性回归/KM+log-rank/ROC/相关；图表：柱/散点/箱线/XY+显著性标注、KM/ROC/森林；方法学报告；CSV 解析 | 3-4 周 |
| **Gen 1.5** | Python stats worker（scipy/lifelines）替换核心计算 + 全量对拍 CI | +1 周 |
| **Gen 2** | two-way ANOVA(+RM)、非线性回归、Bland-Altman、配对检验族；BioScene MVP（schema+渲染器+500 图标+render_scene 工具）；3D 蛋白（Mol\*） | 4-6 周 |
| **Gen 3** | Prism 式数据表模型、.pzfx 导入导出、Reactome 通路数据、R 互操作、模板库 | 持续 |

### Gen 1 交付拆分（W 级）

- **W1**：TS handler + jstat 核心 + 工具注册 + 端到端（t/卡方/回归/描述）
- **W2**：CSV/Excel 解析 + 门控（正态性降级、结构校验）+ 方法学报告
- **W3**：图表扩展（显著性标注、箱线/散点）+ golden 对拍第一批
- **W4**：Python worker 镜像 + 核心计算切换 + 部署

---

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 统计正确性质疑（期刊审稿） | 参考库实现 + golden 对拍 + 完整方法学报告（检验名/统计量/df/p/效应量/CI） |
| LLM 提议错误分析 | 白名单 + 结构校验 + 门控自动降级；LLM 不直接执行 |
| 图标语义错误（分子图） | 受限目录 + 语义标签检索 + 渲染器校验 + 定位"起草非发表级" |
| Python worker 部署成本 | 同队列双消费者，复用现有镜像构建/部署管线 |
| 手写 stat-tools 与参考库结果不一致 | 全部纳入对拍；差异时以 scipy 为准并修复 |

---

## 7. 验收标准（Gen 1）

1. `run_stats_analysis` 在聊天中可调用，10 类分析端到端可用（t/Mann-Whitney/卡方/Fisher/线性回归/KM/ROC/Pearson/Spearman/描述）
2. 每个分析输出 `{report, chart, methods_text}`；方法学文本可直接粘贴进论文
3. 正态性门控：非正态数据自动降级并在报告声明
4. golden 对拍：首批 ≥20 用例误差 <1e-8，进 CI
5. CSV 上传 → 分析 → 图表 → 导出 SVG/PNG 全链路 <30 秒
6. 图表含显著性标注（* / ** / *** 与 p 值）
