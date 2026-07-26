# Heurion 插件市场（Plugin Marketplace）架构设计

**Status:** Design proposal (v1.0)  
**更新:** 2026-07-26  
**Deciders:** JZ (architect), product team, backend team  

---

## 1. 问题陈述

当前 Heurion 的 **Skills 市场**本质上是 **prompt-based skills**：下载一个 `SKILL.md`，注入到 system prompt，影响主 Agent 的回复风格。它不能：

- 调用外部 API（Slack、GitHub、医院 HIS）
- 执行代码生成文件
- 扩展 UI 界面
- 管理外部系统的凭据

用户需要一个真正的 **Plugin 市场**：能安装运行时能力、连接器、渲染器。

---

## 2. 核心区分：Skills vs Plugins

| 维度 | Skills | Plugins |
|---|---|---|
| **本质** | Prompt 模板 + 医学知识包 | 可执行代码 + 连接器 + UI 组件 |
| **安装后发生什么** | 注入 system prompt | 注册 tools / connectors / UI 组件 |
| **能否调用外部 API** | ❌ | ✅ |
| **能否执行代码** | ❌ | ✅ |
| **安全风险** | 低（纯文本） | 高（网络、代码执行、凭据） |
| **配置复杂度** | 低 | 高（需 token、权限、沙箱） |
| **示例** | "肿瘤科 SOAP note 写作风格" | "Slack 通知连接器"、"MedSci-Sidecar 渲染器" |

**结论**：Skills 市场和 Plugins 市场必须分开，但 Plugins 可以包含 Skills。

---

## 3. 设计目标

1. **真正的运行时扩展**：插件能执行代码、调用外部 API、生成文件。
2. **安全隔离**：每个插件在受限沙箱中运行，权限最小化。
3. **统一发现与安装**：用户可在 marketplace 中浏览、安装、配置、启用/禁用插件。
4. **与现有 Skills 体系共存**：不破坏现有 skills 市场，插件可额外注册 skills。
5. **商业化就绪**：支持官方插件、第三方插件、付费插件。

---

## 4. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Heurion Web / Desktop                       │
│                  （Plugin Marketplace UI、设置页）                   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Heurion API Gateway (Control Plane)              │
│         （鉴权、限流、审计、路由到 Plugin Manager）                  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ enqueue job
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Async Job Queue (Redis / RabbitMQ / SQLite)      │
│   - 插件 tool 调用任务                                              │
│   - 重试、超时、优先级                                              │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ poll job
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Execution Plane (Sandbox VPS / Worker Pool)      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                   Plugin Manager                              │  │
│  │   - 插件生命周期管理（安装/启用/禁用/卸载）                    │  │
│  │   - Tool registry 聚合                                        │  │
│  │   - 权限校验                                                  │  │
│  │   - 调用路由                                                  │  │
│  │   - 审计日志                                                  │  │
│  └───────┬───────────────┬───────────────┬─────────────────────┘  │
│          │               │               │                         │
│          ▼               ▼               ▼                         │
│     Connector      Execution        Data Source                    │
│     Plugins        Plugins          Plugins                        │
│     (Slack,        (MedSci-         (PubMed,                      │
│      GitHub,        Sidecar,         HIS,                          │
│      Jira...)       R/Python...)     PACS...)                      │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 控制面 vs 执行面

| 维度 | Control Plane | Execution Plane |
|---|---|---|
| 位置 | 主生产 VPS | 独立 sandbox VPS / worker 节点 |
| 职责 | HTTP API、Plugin Manager、Job Queue、数据库 | 运行插件容器、执行 tool、渲染文件 |
| 公网暴露 | 是（通过 Caddy/Load Balancer） | 否（仅内网通信） |
| 安全级别 | 标准 | 高隔离、受限 egress |
| 扩容方式 | 垂直扩容 | 水平扩容 worker 实例 |

### 4.2 Worker Pipeline

插件 tool 调用通过异步 worker pipeline 执行：

1. 主 Agent 识别需要调用插件 tool。
2. Control Plane 的 Plugin Manager 校验权限，将 job 入队。
3. Execution Plane 的 worker 从队列取出 job。
4. worker 启动对应插件 runtime（容器/WASM），注入必要 secrets。
5. 插件执行完成后，将结果/文件写入 Object Storage。
6. worker 将 job 状态更新为完成，Control Plane 返回结果给用户。

这种设计让长时间运行的插件任务不会阻塞主 HTTP API。

---

## 5. 插件类型

| 类型 | 能力 | 示例 |
|---|---|---|
| **Connector** | 连接外部系统，读写数据 | Slack、GitHub、Jira、Notion、医院 HIS |
| **Execution** | 执行代码、渲染文件、运行脚本 | MedSci-Sidecar、R/Python 脚本执行器 |
| **Data Source** | 提供外部数据源 | PubMed、ClinicalTrials.gov、医院 LIS |
| **UI Plugin** | 扩展前端界面 | 自定义患者看板、研究进度图表 |
| **Automation** | 定时/触发任务 | 每日文献推送、随访提醒、数据同步 |

---

## 6. 插件生命周期

### 6.1 发现（Discover）

- 官方 marketplace：Heurion 维护的插件目录。
- 第三方 marketplace：审核后的第三方插件。
- 私有 registry：企业客户自托管的插件仓库。

### 6.2 安装（Install）

1. 用户点击安装。
2. 系统拉取插件镜像/代码包。
3. 解析 `plugin.manifest.json`。
4. 创建插件配置项（settings schema）。
5. 注册插件 tools 到 Plugin Manager。
6. 插件状态变为 `installed`。

### 6.3 配置（Configure）

- 用户填入必要的 settings（如 API token、域名、权限范围）。
- Secret 类型字段存入 Vault，不暴露给主 Agent。

### 6.4 启用/禁用（Enable/Disable）

- **启用**：Plugin Manager 开始路由对应 tool calls。
- **禁用**：保留配置，停止路由，但 tools 仍可见（标记为 disabled）。

### 6.5 升级（Upgrade）

- **单版本策略**（已决策）：每个插件在同一 workspace 下只保留一个版本。
- 升级时：拉取新版本镜像 → 停止旧实例 → 启动新实例 → 保留用户配置（向后兼容时）。
- 若新版本 breaking changes，提示用户重新配置。

### 6.6 卸载（Uninstall）

- 停止插件运行实例。
- 删除镜像/代码包。
- 删除配置和凭据。
- 从 registry 移除 tools。

```
Discover → Install → Configure → Enable → [Upgrade] → [Disable] → Uninstall
```

---

## 7. Plugin Manager 职责

Plugin Manager 是插件市场的核心控制面：

| 职责 | 说明 |
|---|---|
| **Registry** | 维护所有已安装插件的 manifest、tools、settings |
| **Router** | 根据 tool name 把调用路由到对应插件 runtime |
| **AuthZ** | 校验调用者是否有权限调用该插件 |
| **Permission Enforcer** | 检查插件声明的权限，拒绝越权请求 |
| **Secret Injection** | 把插件需要的 secret 安全注入 runtime |
| **Quota / Rate Limit** | 限制插件的 CPU、内存、并发、调用频率 |
| **Audit Logger** | 记录每次插件调用的元数据 |
| **Health Monitor** | 监控插件 runtime 健康状态 |

---

## 8. Plugin Runtime 架构

插件运行时可以采用多种形式，Plugin Manager 根据 manifest 中的 `runtime.type` 进行调度。

### 8.1 Python Container（MVP 主力）

- 每个插件一个 Docker 容器镜像。
- 通过 HTTP/gRPC 暴露 tool invocation endpoint。
- 适合 MedSci-Sidecar、Slack Connector 等绝大多数插件。

```yaml
runtime:
  type: container
  image: heurion/plugin-medsci-sidecar:1.0.0
  port: 8080
```

### 8.2 WASM Runtime（长期探索）

- 插件编译为 WASM 模块，在 WASM runtime 中执行。
- 启动更快、资源占用更低、隔离性更好。
- 生态和工具链目前弱于 Python container，作为实验性支持。

```yaml
runtime:
  type: wasm
  module: plugin.wasm
```

### 8.3 调度策略

| 类型 | MVP 支持 | 默认启用 | 说明 |
|---|---|---|---|
| container | ✅ | ✅ | 主力 runtime |
| process | ✅ | ❌ | 仅本地桌面版 |
| wasm | 实验性 | ❌ | 后续逐步完善 |

---

## 9. Tool Registry 聚合

Plugin Manager 需要向主 Agent 暴露一个统一的 tool list：

```
Plugin Manager Tool Registry
├── heurion/medsci-sidecar:generate_docx
├── heurion/medsci-sidecar:generate_pptx
├── slack-connector:send_message
├── slack-connector:list_channels
├── github-connector:list_issues
└── pubmed-source:search_articles
```

主 Agent 不需要知道工具来自哪个插件，只需要知道：
- tool name
- description
- parameters schema

---

## 10. 安全模型

### 10.1 权限声明（Manifest Permissions）

每个插件必须在 manifest 中声明所需权限：

```yaml
permissions:
  - network_egress:
      - slack.com
      - api.github.com
  - file_read: true
  - file_write: true
  - phi_access: false
  - execute_code: false
```

### 10.2 用户授权

安装插件时，用户必须明确同意权限范围。敏感权限需要二次确认：

- `phi_access: true` → 明确告知用户该插件会接触患者数据
- `network_egress` → 列出允许访问的域名
- `execute_code: true` → 明确告知会执行代码

### 10.3 沙箱执行

| 部署模式 | 沙箱方案 |
|---|---|
| 云端 K8s | 每个插件一个容器，NetworkPolicy 限制 egress |
| 更强隔离 | gVisor / Firecracker microVM |
| 本地桌面 | 独立进程 + 系统级权限限制 |

### 10.4 Plugin 间通信

**已决策：v1.0 不支持 Plugin 间直接通信。**

- 每个插件只能与 Plugin Manager 通信。
- 避免权限提升、循环依赖和调试复杂度。
- 如果一个插件需要另一个插件的能力，应通过主 Agent 编排。
- 未来若需要，通过 Plugin Manager 中转并引入显式依赖声明。

### 10.5 Secret 管理

DigitalOcean 没有独立的托管 Secrets Manager。推荐方案：

1. **Docker Secrets（Droplet 方案，首选）**
   - 使用 Docker Swarm / Docker Compose secrets。
   - 插件 API token、LLM key、JWT secret 存为 secret，挂载到 `/run/secrets/`。
   - Secret 只在 runtime 启动时注入，不进入主 Agent prompt。

2. **DigitalOcean App Platform Secrets**
   - 若 Execution Plane 部署在 App Platform，使用其内置 Secrets。
   - 适合 serverless plugin worker。

3. **自托管 HashiCorp Vault**
   - 在 DigitalOcean Droplet 上部署 Vault。
   - 动态凭证、审计、细粒度访问控制。

**通用规则**：
- Secret 不进入主 Agent prompt。
- Secret 不可被插件代码回传给外部（egress 白名单控制）。
- Plugin Manager 负责将插件需要的 secret 安全注入 runtime。

### 10.6 审计日志

每次插件调用记录：

- `timestamp`
- `user_id`, `workspace_id`
- `plugin_id`, `tool_name`
- `input_summary`（不含 PHI）
- `status`
- `duration_ms`
- `error_message`（失败时）

---

## 11. 与现有 Skills 市场的关系

### 11.1 用户界面层

Marketplace UI 分为两个 Tab：

- **Skills**：prompt-based skills，纯文本能力。
- **Plugins**：runtime plugins，代码/连接器能力。

### 11.2 实现层

- Plugin 可以包含 0 个或多个 Skill。
- 安装 Plugin 时，自动注册其 tools；可选注册其 skills。
- Skills 市场的现有代码完全保留。

```
Plugin: heurion/medsci-sidecar
├── runtime/
│   └── main.py
├── tools/
│   ├── generate_docx
│   └── generate_pptx
└── skills/
    └── when_to_use_sidecar.md   # 可选
```

### 11.3 主 Agent Prompt

System prompt 需要同时注入：

```text
## Active Skills
- Clinical Summary: ...
- Safety Monitor: ...

## Active Plugins
- heurion/medsci-sidecar: 提供 generate_docx / generate_pptx
- slack-connector: 提供 send_message / list_channels

## 路由规则
- 需要生成 Word/PPT → 调用 sidecar 工具
- 需要发送 Slack 通知 → 调用 slack-connector 工具
- 禁止自己写代码模拟这些能力
```

---

## 12. 与 MedSci-Sidecar 的关系

MedSci-Sidecar 是 **第一个官方 Execution Plugin**：

```yaml
plugin:
  id: heurion/medsci-sidecar
  name: MedSci Sidecar
  category: execution
  runtime:
    type: container
    image: heurion/plugin-medsci-sidecar:latest
  tools:
    - sidecar_generate_docx
    - sidecar_generate_pptx
    - sidecar_render_table
    - sidecar_render_plot
    - sidecar_convert_to_pdf
```

通过它验证整个插件架构：安装、启用、tool 路由、沙箱执行、文件输出。

---

## 13. UI Plugin 机制

**已决策：UI Plugin 采用 React 组件动态加载。**

### 13.1 为什么选 React 动态加载？

- Heurion 前端本身就是 React（web）/ Tauri + React（desktop）。
- 体验最自然，插件 UI 可以无缝融入现有布局。
- 比 iframe 更轻、性能更好。

### 13.2 安全边界

React 动态加载的最大风险是**插件代码可以访问整个前端上下文**。必须通过以下机制隔离：

| 机制 | 说明 |
|---|---|
| **ESM 沙箱** | 插件 UI 以 ES Module 形式加载，运行在独立作用域 |
| **Props 白名单** | 只传入 plugin 声明需要的 context（如 patient_hash），不暴露全局 state |
| **CSS 隔离** | 强制 Shadow DOM 或 CSS-in-JS 命名空间，防止样式污染 |
| **权限声明** | UI plugin 必须声明需要访问哪些前端路由/数据 |
| **运行时校验** | 对插件 bundle 做签名/哈希校验，防止篡改 |

### 13.3 UI 扩展点

| 扩展点 | 说明 |
|---|---|
| `panel` | 在患者/研究详情页新增一个 Tab 或侧边栏面板 |
| `settings_page` | 在插件设置页新增配置界面 |
| `toolbar_action` | 在聊天/文档工具栏新增按钮 |
| `dashboard_card` | 在首页 dashboard 新增卡片 |

### 13.4 暂不支持的方案

- **iframe**：体验割裂，性能差，仅作为未来第三方不可信插件的备选。
- **Web Component**：标准化但 Heurion 是 React 生态，接入成本高。

---

## 14. 第三方插件审核机制

**已决策：自动化安全扫描 + 人工抽检。**

### 14.1 自动化扫描

- **静态分析**：扫描 manifest 权限声明、可疑网络域名、危险函数调用。
- **镜像扫描**：检查容器镜像 CVE 漏洞、恶意软件。
- **Secret 检测**：确保示例代码中没有硬编码凭据。
- **PHI 检测**：扫描插件是否在不声明 `phi_access` 的情况下处理患者数据。

### 14.2 人工抽检

- 新上架插件首次必须人工审核。
- 更新版本：小版本自动化通过，大版本人工抽检。
- 高风险权限（`phi_access=true`、`execute_code=true`）必须人工复核。

### 14.3 运行时监控

- 插件上线后持续监控异常行为（如 egress 越权、资源占用异常）。
- 发现问题可立即下架或禁用。

---

## 15. Marketplace 后端设计

### 15.1 数据模型

| 实体 | 说明 |
|---|---|
| `plugin_catalog` | marketplace 目录，含官方/第三方插件元数据 |
| `plugin_installation` | 用户/团队已安装的插件实例 |
| `plugin_setting` | 插件配置项（key-value，secret 加密） |
| `plugin_tool` | 插件注册的 tools（冗余缓存，便于快速查询） |
| `plugin_audit_log` | 插件调用审计日志 |

### 15.2 API 端点

| 端点 | 说明 |
|---|---|
| `GET /api/v1/plugins/catalog` | 浏览 marketplace |
| `GET /api/v1/plugins/catalog/{id}` | 插件详情 |
| `POST /api/v1/plugins/install` | 安装插件 |
| `DELETE /api/v1/plugins/{id}` | 卸载插件 |
| `GET /api/v1/plugins/installed` | 已安装列表 |
| `POST /api/v1/plugins/{id}/enable` | 启用插件 |
| `POST /api/v1/plugins/{id}/disable` | 禁用插件 |
| `GET /api/v1/plugins/{id}/settings` | 获取配置 schema |
| `PUT /api/v1/plugins/{id}/settings` | 保存配置 |
| `POST /api/v1/plugins/{id}/tools/{tool}/invoke` | 手动调用插件 tool（调试用） |

---

## 16. 商业化考虑

| 维度 | 方案 |
|---|---|
| **官方插件** | Heurion 团队开发维护，免费或包含在订阅中 |
| **第三方插件** | 审核后上架，支持免费/付费模式 |
| **企业私有插件** | 企业自托管 registry，不上架公共市场 |
| **计费** | 按调用量、按席位、或一次性购买 |
| **分成** | 第三方插件收入平台抽成（如 20%） |

---

## 17. Roadmap

| 阶段 | 目标 | 关键交付 |
|---|---|---|
| **MVP (6-8 周)** | Plugin 基础设施 + 第一个插件 | Plugin Manager、manifest 规范、MedSci-Sidecar plugin |
| **v1.0 (3-4 月)** | Marketplace UI + 官方连接器 + UI Plugin 基础 | Slack、GitHub、Notion connector、React UI 扩展机制 |
| **v2.0 (4-6 月)** | 第三方插件 + 审核机制 + WASM 实验性支持 | 开发者文档、插件 SDK、上架审核流程 |
| **v3.0 (6-12 月)** | Automation + 高级 UI 扩展 | 定时任务、触发器、更丰富的 UI 扩展点 |

---

## 18. 已决策事项

| # | 问题 | 决策 |
|---|---|---|
| 1 | Plugin runtime 技术栈 | **Python container 为主，WASM 作为实验性支持**。 |
| 2 | Plugin 间通信 | **v1.0 不支持**。插件只能与 Plugin Manager 通信。 |
| 3 | UI Plugin 机制 | **React 组件动态加载**，通过 ESM 沙箱 + Props 白名单隔离。 |
| 4 | 第三方插件审核 | **自动化安全扫描 + 人工抽检**。高风险权限必须人工复核。 |
| 5 | 插件版本管理 | **单版本策略**。升级即替换，保留配置（向后兼容时）。 |
