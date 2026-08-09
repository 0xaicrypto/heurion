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
┌─────────────────────────────────────────────────────────────────────┐
│                         用户浏览器 / 桌面客户端                      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Heurion API Gateway + 主 Agent                   │
│   - 意图识别                                                         │
│   - 调用 Sidecar tool                                               │
│   - 返回 file_id 给用户                                              │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ enqueue job
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Async Job Queue (Redis / RabbitMQ / SQLite)      │
│   - 保存待执行的 Sidecar 任务                                        │
│   - 支持重试、超时、优先级                                            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ poll job
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Execution Plane (Sandbox VPS / Worker Pool)      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │   Plugin Manager                                              │  │
│  │   - 路由 tool call 到 MedSci-Sidecar                          │  │
│  │   - 鉴权、审计、限流                                           │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   MedSci-Sidecar Container                                    │  │
│  │   - 模板渲染                                                   │  │
│  │   - DOCX/PPTX/PDF 生成                                         │  │
│  │   - 图表绘制                                                   │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ 上传输出文件
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │   Object Storage (S3 / DigitalOcean Spaces / MinIO)           │  │
│  │   - 生成的文件按 tenant 隔离                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 为什么需要 Worker Pipeline？

MedSci-Sidecar 的执行是**异步、资源密集、可能失败**的，不适合直接在 HTTP 请求中同步完成：

| 问题 | 同步 HTTP | Worker Pipeline |
|---|---|---|
| 执行时间 | 受 HTTP timeout 限制（通常 30-120s） | 可运行数分钟 |
| 资源峰值 | 阻塞主 API 进程 | 在独立 worker 上运行 |
| 失败处理 | 只能返回错误 | 可重试、可降级 |
| 并发控制 | 困难 | 通过队列限流 |
| 可观测性 | 差 | 独立日志、指标、审计 |

### 3.2 Execution Plane 部署

Execution Plane 推荐部署在**独立的 VPS / 节点**上：

- 与 Control Plane 通过 VPC / WireGuard / 内网通信。
- 不直接暴露公网，只接受来自 Job Queue 或 Control Plane 的请求。
- 可按需横向扩展 worker 实例。

示例：DigitalOcean 上两台 Droplet：

| 节点 | 角色 | 规格 |
|---|---|---|
| `heurion-control` | Control Plane + Job Queue | 2 vCPU / 4 GB |
| `heurion-worker` | Execution Plane + Sandbox | 2 vCPU / 4 GB（可扩容） |

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

### 9.5 Secret 管理

DigitalOcean 没有独立的托管 Secrets Manager。推荐按以下优先级：

1. **Docker Secrets（Droplet 方案，首选）**
   - 使用 Docker Swarm 或 Docker Compose secrets。
   - 将 `SERVER_SECRET`、LLM API key、插件 token 存为 secret，挂载到 `/run/secrets/`。
   - 不进入镜像，不进入环境变量，支持权限控制。

2. **DigitalOcean App Platform Secrets**
   - 若 Execution Plane 部署在 App Platform，使用其内置 Secrets/Env 功能。
   - 适合 serverless/plugin worker 形态。

3. **自托管 HashiCorp Vault**
   - 在 DigitalOcean Droplet 上部署 Vault。
   - 动态凭证、细粒度 ACL、审计日志。
   - 适合企业级多租户场景。

**MVP 推荐**：Docker Secrets on DigitalOcean Droplets。Control Plane 和 Execution Plane 各自维护自己的 secrets，插件凭据由 Plugin Manager 注入 worker runtime。

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
| `packages/server-ts/src/tools/`（BaseTool 体系） | 在 `src/tools/` 增加 sidecar 工具（封装对 Execution Plane 的调用） |
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
