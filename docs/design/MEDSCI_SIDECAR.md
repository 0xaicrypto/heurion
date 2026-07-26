# MedSci-Sidecar：云端科研/医疗文件渲染执行服务

**Status:** Design proposal (v1.0)  
**更新:** 2026-07-26  
**Deciders:** JZ (architect), backend team  

---

## 1. 设计目标

MedSci-Sidecar 是 Heurion 的**执行型插件（Execution Plugin）**，负责把主 Agent 的决策转化为可下载的科研/医疗交付物：Word、PPT、PDF、图表等。

核心原则：
- **主 Agent 只决策，不渲染**：所有文件生成、图表绘制、格式转换都交给 Sidecar。
- **云端部署，零本地安装**：用户无需安装 Docker、Python 或任何桌面软件。
- **模板驱动**：通过预定义模板 + 结构化数据生成专业文档，避免版式错乱。
- **租户隔离**：每个用户/团队的数据和模板严格隔离。

---

## 2. 为什么不放在本地？

最初 PRD 倾向于本地 Sidecar（受 OpenWorker 影响），但 Heurion 的商业模式是 **云 SaaS**：

| 维度 | 本地 Sidecar | 云端 Sidecar |
|---|---|---|
| 用户门槛 | 需安装/配置环境 | 零安装 |
| 一致性 | 依赖用户机器 | 平台统一控制 |
| 扩展性 | 受限 | 可水平扩展 |
| PHI 控制 | 数据不出本机 | 通过租户隔离 + 加密 + 审计实现 |
| 运维成本 | 用户承担 | 平台承担 |

结论：MVP 及后续产品化阶段均采用**云端容器化部署**。

---

## 3. 总体架构

```
┌─────────────────────────────────────────────┐
│          用户浏览器 / 桌面客户端              │
└───────────────────┬─────────────────────────┘
                    │
┌───────────────────▼─────────────────────────┐
│      Heurion API Gateway + 主 Agent         │
│   - 意图识别                                 │
│   - 调用 Sidecar tool                       │
│   - 返回 file_id 给用户                      │
└───────────────────┬─────────────────────────┘
                    │ HTTP / gRPC
┌───────────────────▼─────────────────────────┐
│         Plugin Manager                      │
│   - 路由 tool call 到对应 plugin            │
│   - 鉴权、审计、限流                         │
└───────────────────┬─────────────────────────┘
                    │
┌───────────────────▼─────────────────────────┐
│      MedSci-Sidecar Container               │
│   - 模板渲染                                 │
│   - DOCX/PPTX/PDF 生成                       │
│   - 图表绘制                                 │
└───────────────────┬─────────────────────────┘
                    │ 上传输出文件
┌───────────────────▼─────────────────────────┐
│      Object Storage (S3/MinIO)              │
│   - 生成的文件按 tenant 隔离                 │
└─────────────────────────────────────────────┘
```

---

## 4. 职责边界

| 职责 | 主 Agent | MedSci-Sidecar |
|---|---|---|
| 理解用户需求 | ✅ | ❌ |
| 选择模板、组装数据 | ✅ | ❌ |
| 生成 DOCX/PPTX/PDF | ❌ | ✅ |
| 管理文件生命周期 | ✅（通过 file_id） | ❌（只负责生成） |
| 错误恢复与重试策略 | ✅ | ❌（只报告错误） |
| 执行时间控制 | ✅（设置 timeout） | ✅（内部 timeout） |

---

## 5. MVP 工具清单

| Tool Name | 功能 | 输出格式 | 优先级 |
|---|---|---|---|
| `sidecar_generate_docx` | 从模板+数据生成 Word 文档 | `.docx` | P0 |
| `sidecar_generate_pptx` | 从模板+数据生成 PPT | `.pptx` | P0 |
| `sidecar_render_table` | 生成医学 Table 1 / 统计表 | `.docx` | P0 |
| `sidecar_render_plot` | 生成 KM 曲线、柱状图、散点图 | `.pdf` / `.png` | P1 |
| `sidecar_convert_to_pdf` | 将 docx/pptx 转为 PDF | `.pdf` | P1 |

**不在 MVP 中**：Prism、SPSS、Photoshop、EndNote、LaTeX、R 语言。

---

## 6. 模板驱动生成机制

### 6.1 为什么用模板？

- 零生成容易导致版式错乱、字体缺失、主题不统一。
- 医学/科研文档有严格的格式规范，模板可由专业人员预先设计。
- 主 Agent 只需要提供数据，不需要关心排版细节。

### 6.2 模板存储

```
templates/
├── docx/
│   ├── case_summary.docx
│   ├── research_report.docx
│   └── discharge_summary.docx
└── pptx/
    ├── academic_presentation.pptx
    └── case_conference.pptx
```

模板来源：
- **系统模板**：内置，所有用户可用。
- **租户模板**：按 workspace/team 隔离，**workspace 管理员可上传**（已决策）。
- **用户模板**：个人用户可上传（后续版本）。

### 6.3 占位符规范

模板内使用 `{{placeholder}}` 占位：

| 占位符类型 | 示例 | 说明 |
|---|---|---|
| 简单文本 | `{{patient_initials}}` | 直接替换为字符串 |
| 富文本 | `{{{findings_html}}}` | 保留 HTML 格式 |
| 循环块 | `{{#each findings}}...{{/each}}` | 渲染列表/表格行 |
| 条件块 | `{{#if has_metastasis}}...{{/if}}` | 根据布尔值决定是否显示 |
| 图片 | `{{image:figure1_path}}` | 插入本地图片路径 |

---

## 7. 主 Agent 路由 Prompt

在 `buildPersona` 或 v2 chat system prompt 中注入：

```text
## MedSci-Sidecar 使用规则

你是医学/科研 AI 的决策大脑，不具备本地文件渲染能力。当用户需求涉及以下任务时，
必须调用对应的 sidecar 工具，禁止自己写简易代码或纯文本回答：

- 生成 Word 文档 / 病例总结 / 出院小结 / 研究报告 → sidecar_generate_docx
- 生成 PPT / 学术汇报 / 病例讨论 / 教学幻灯片 → sidecar_generate_pptx
- 生成统计表格 / Table 1 基线特征表 → sidecar_render_table
- 生成医学图表 / KM 曲线 / 柱状图 / 散点图 → sidecar_render_plot
- 文档转 PDF → sidecar_convert_to_pdf

调用 Sidecar 时，只发送 template_id 和 data JSON。禁止在对话中回传大量文件二进制或环境调试日志。
```

---

## 8. 数据流

```
用户输入："生成 ZQ 病例总结 Word"
   ↓
主 Agent 识别意图 → 需要 sidecar_generate_docx
   ↓
主 Agent 组装参数：
{
  "template_id": "case_summary",
  "data": {
    "patient_initials": "ZQ",
    "age": 58,
    "sex": "M",
    "diagnosis": "NSCLC IIIA",
    "findings": [...]
  },
  "output_name": "ZQ_Case_Summary"
}
   ↓
Plugin Manager 路由到 MedSci-Sidecar
   ↓
Sidecar 验证模板 → 填充数据 → 生成 DOCX
   ↓
Sidecar 上传文件到 Object Storage
   ↓
Sidecar 返回：
{
  "file_id": "file_xxx",
  "file_name": "ZQ_Case_Summary.docx",
  "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "size_bytes": 24576
}
   ↓
主 Agent 返回给用户：下载链接
```

---

## 9. 安全与隐私

### 9.1 输入侧

- Sidecar 接收的参数中**不包含真实姓名、病历号、身份证号**。
- 使用 `patient_hash` 做关联，文本内容已脱敏。
- 所有入参记录审计日志，但**不记录具体 PHI 内容**。

### 9.2 执行侧

- 每个任务在独立容器/沙箱中执行，限制：
  - CPU：1 vCPU
  - 内存：512MB - 1GB
  - 执行时间：按工具区分（已决策）
    - `generate_docx` / `render_table`：30 秒
    - `generate_pptx`：60 秒
    - `render_plot`：60 秒
    - `convert_to_pdf`：120 秒
  - 最长不超过 5 分钟
  - 无网络 egress（除上传文件到内部存储）
- 容器执行完后立即销毁，临时目录清空。

### 9.3 输出侧

- 生成文件上传到租户隔离的 Object Storage bucket/prefix。
- 文件访问通过 Heurion 鉴权链路，不允许匿名下载。
- 生成文件默认保留 **30 天**后自动清理（可配置；商业化后按套餐调整）。

### 9.4 审计

记录以下字段：
- `user_id`, `workspace_id`
- `tool_name`, `template_id`
- `started_at`, `completed_at`, `duration_ms`
- `status` (success / failure)
- `output_file_id`
- `error_message`（失败时，不含敏感数据）

---

## 10. 错误处理与降级

| 异常 | 处理策略 |
|---|---|
| 模板不存在 | 返回可用模板列表；主 Agent 可引导用户选择 |
| 数据缺失占位符 | 保留占位符原文，返回警告信息 |
| 生成超时 | 返回失败；可尝试简化数据后重试 |
| 字体缺失 | 容器预装常见学术字体；缺失时回退到默认字体 |
| PDF 转换失败 | 返回原始 docx/pptx，不强制要求 PDF |
| 存储上传失败 | 返回本地路径/重试；主 Agent 提示用户稍后重试 |

---

## 11. 技术栈

| 组件 | 选型 | 理由 |
|---|---|---|
| DOCX 生成 | `python-docx` + `docxtpl` | 成熟，支持模板占位符 |
| PPTX 生成 | `python-pptx` | 成熟，支持版式、图片、表格 |
| 图表渲染 | `matplotlib` + `plotly` + `seaborn`（已决策：两者都支持） | matplotlib 适合静态出版图；plotly 适合交互式探索 |
| PDF 转换 | `pypandoc` 起步，`LibreOffice headless` 作为高保真选项（已决策） | pandoc 轻量足够大多数场景；LibreOffice 处理复杂版式 |
| 服务端框架 | FastAPI / 轻量 gRPC | 与 Heurion Python 后端一致 |
| 容器运行时 | Docker / Kubernetes | 云平台标准 |
| 沙箱 | gVisor / Firecracker（后续） |  stronger isolation |

---

## 12. 与 Heurion 现有模块的集成

| 模块 | 集成方式 |
|---|---|
| `packages/server/nexus_server/tools_*.py` | 新增 `tools_sidecar.py`，封装对 Sidecar 的调用 |
| `packages/server-ts/src/modules/skills/skills.router.ts` | 新增 `official/medsci-sidecar` skill |
| `packages/server-ts/src/modules/chat/user-context.ts` | system prompt 注入 Sidecar 路由规则 |
| `packages/server-ts/src/modules/stubs/stubs.router.ts` | `/api/v1/sandbox/execute` 可扩展为通用 plugin 代理 |
| FileIndex / 文件上传体系 | Sidecar 输出文件注册到患者/研究文件列表 |
| 审计日志 | 复用现有 EventLog 或新增 sidecar_audit 表 |

---

## 13. Roadmap

| 阶段 | 目标 | 交付物 |
|---|---|---|
| **MVP (4-6 周)** | 云端 DOCX/PPTX/Table 生成 | `generate_docx`, `generate_pptx`, `render_table`，5 个基础模板 |
| **v1.0 (2-3 月)** | 完整图表 + PDF 转换 | `render_plot`, `convert_to_pdf`，租户自定义模板 |
| **v2.0 (3-6 月)** | 插件化 + 市场 | MedSci-Sidecar 作为第一个官方 Plugin 上架 |
| **v3.0 (6-12 月)** | 可选商业软件适配 | Prism/SPSS/Photoshop/EndNote connector（仅对授权用户） |

---

## 14. 已决策事项

| # | 问题 | 决策 |
|---|---|---|
| 1 | 模板上传权限 | **workspace 管理员可上传租户模板**，个人用户模板后续版本支持。 |
| 2 | PDF 转换引擎 | **`pypandoc` 起步，`LibreOffice headless` 作为高保真选项**。 |
| 3 | 图表渲染库 | **`matplotlib` 和 `plotly` 都支持**。matplotlib 用于静态出版图，plotly 用于交互式图表。 |
| 4 | 执行超时 | **按工具区分**：docx/table 30s，pptx/plot 60s，pdf 转换 120s，最长不超过 5 分钟。 |
| 5 | 文件保留期 | **默认 30 天**自动清理；商业化后按套餐调整。 |
