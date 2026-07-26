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
┌─────────────────────────────────────────────────────────────┐
│                    Heurion Web / Desktop                    │
│              （Plugin Marketplace UI、设置页）               │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                  Heurion API Gateway                         │
│         （鉴权、限流、审计、路由到 Plugin Manager）           │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                   Plugin Manager                             │
│   - 插件生命周期管理（安装/启用/禁用/卸载）                    │
│   - Tool registry 聚合                                       │
│   - 权限校验                                                 │
│   - 调用路由                                                 │
│   - 审计日志                                                 │
└───────┬───────────────┬───────────────┬─────────────────────┘
        │               │               │
        ▼               ▼               ▼
   Connector      Execution        Data Source
   Plugins        Plugins          Plugins
   (Slack,        (MedSci-         (PubMed,
    GitHub,        Sidecar,         HIS,
    Jira...)       R/Python...)     PACS...)
```

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

### 6.5 卸载（Uninstall）

- 停止插件运行实例。
- 删除镜像/代码包。
- 删除配置和凭据。
- 从 registry 移除 tools。

```
Discover → Install → Configure → Enable → [Disable] → Uninstall
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

## 8. Tool Registry 聚合

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

## 9. 安全模型

### 9.1 权限声明（Manifest Permissions）

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

### 9.2 用户授权

安装插件时，用户必须明确同意权限范围。敏感权限需要二次确认：

- `phi_access: true` → 明确告知用户该插件会接触患者数据
- `network_egress` → 列出允许访问的域名
- `execute_code: true` → 明确告知会执行代码

### 9.3 沙箱执行

| 部署模式 | 沙箱方案 |
|---|---|
| 云端 K8s | 每个插件一个容器，NetworkPolicy 限制 egress |
| 更强隔离 | gVisor / Firecracker microVM |
| 本地桌面 | 独立进程 + 系统级权限限制 |

### 9.4 Secret 管理

- API token、密码等使用 Vault / AWS Secrets Manager / 自研 secret store。
- Secret 只在 runtime 启动时注入环境变量，不进入主 Agent prompt。
- Secret 不可被插件代码回传给外部（ egress 白名单控制）。

### 9.5 审计日志

每次插件调用记录：

- `timestamp`
- `user_id`, `workspace_id`
- `plugin_id`, `tool_name`
- `input_summary`（不含 PHI）
- `status`
- `duration_ms`
- `error_message`（失败时）

---

## 10. 与现有 Skills 市场的关系

### 10.1 用户界面层

Marketplace UI 分为两个 Tab：

- **Skills**：prompt-based skills，纯文本能力。
- **Plugins**：runtime plugins，代码/连接器能力。

### 10.2 实现层

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

### 10.3 主 Agent Prompt

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

## 11. 与 MedSci-Sidecar 的关系

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

## 12. Marketplace 后端设计

### 12.1 数据模型

| 实体 | 说明 |
|---|---|
| `plugin_catalog` | marketplace 目录，含官方/第三方插件元数据 |
| `plugin_installation` | 用户/团队已安装的插件实例 |
| `plugin_setting` | 插件配置项（key-value，secret 加密） |
| `plugin_tool` | 插件注册的 tools（冗余缓存，便于快速查询） |
| `plugin_audit_log` | 插件调用审计日志 |

### 12.2 API 端点

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

## 13. 商业化考虑

| 维度 | 方案 |
|---|---|
| **官方插件** | Heurion 团队开发维护，免费或包含在订阅中 |
| **第三方插件** | 审核后上架，支持免费/付费模式 |
| **企业私有插件** | 企业自托管 registry，不上架公共市场 |
| **计费** | 按调用量、按席位、或一次性购买 |
| **分成** | 第三方插件收入平台抽成（如 20%） |

---

## 14. Roadmap

| 阶段 | 目标 | 关键交付 |
|---|---|---|
| **MVP (6-8 周)** | Plugin 基础设施 + 第一个插件 | Plugin Manager、manifest 规范、MedSci-Sidecar plugin |
| **v1.0 (3-4 月)** | Marketplace UI + 官方连接器 | Slack、GitHub、Notion connector |
| **v2.0 (4-6 月)** | 第三方插件 + 审核机制 | 开发者文档、插件 SDK、上架审核流程 |
| **v3.0 (6-12 月)** | UI Plugin + Automation | 前端扩展机制、定时任务、触发器 |

---

## 15. 待决策事项

1. **Plugin runtime 技术栈**：Python container（推荐）还是 WASM/WASI（更轻但生态弱）？
2. **Plugin 间通信**：是否允许插件互相调用？如果允许，如何鉴权？
3. **UI Plugin 机制**：前端扩展用 iframe、Web Component 还是直接注入 React 组件？
4. **第三方插件审核**：人工审核还是自动化安全扫描？
5. **插件版本管理**：是否支持多版本共存？升级策略是什么？
