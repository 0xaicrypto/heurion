# Heurion Plugin Manifest 规范（as-built）

> **状态**：已交付（插件市场 v1 已上线：catalog/安装/启用/配置/审计/执行面/
> UI 扩展点全链在产）。本文档原为 2026-07-26 的 design proposal（v1.0），
> 实现落地时多处与提案发生实质偏差——**工具命名未采用 `{plugin_id}:{tool_name}`、
> 依赖系统未实现、triggers 字段与 in-process 运行时未写进原文档**。
> 2026-09-22 逐条对照代码重写为 as-built（参照 `CITATION_SYSTEM.md` 补记式
> 写法），抽查声明逐条可验证。
> **本次重写核对过的代码**：
> `packages/server-ts/src/modules/plugins/`（plugin-catalog / plugin-validation /
> plugin-installation / plugin-capability / plugin-chat-handler / plugins.router /
> plugin-audit-log）、官方目录种子 `packages/server-ts/data/official-plugins.json`
> （8 个官方插件）、前端 `packages/web/src/components/plugins/PluginUIRegistry.tsx`
> / `PluginExtensionPoint.tsx` / `routes/plugins.tsx` / `routes/plugin-settings.tsx`、
> 配置加密 `common/settings-encryption.ts`、执行面 `modules/execution/execution-plane.service.ts`。
> **关联**：[`PLUGIN_MARKETPLACE.md`](./PLUGIN_MARKETPLACE.md)（市场整体架构提案，
> 其中"控制面/执行面分离"部分与实现一致，manifest 细节以本文档为准）。

---

## 1. 目标（不变）

定义 Heurion 插件市场的标准 manifest 格式：Plugin Manager 能解析/安装/配置；
主 Agent 能通过 triggers 发现插件能力；开发者知道如何编写兼容插件。

## 2. Manifest 的流转方式（与提案 §2 的偏差）

提案假设"每个插件包是一个目录（plugin.manifest.json + runtime/ + tools/ +
skills/ + ui/）"。**实际是单一 JSON manifest，无插件包目录结构**：

- 官方目录：`packages/server-ts/data/official-plugins.json`（8 个 manifest），
  服务器启动/首个请求时 seed 进 `plugin_catalog` 表（`plugin-catalog.service.ts`
  `seedOfficialCatalog`）。
- 社区插件：两种发布入口，均先过 `validateManifest` 再入库——
  `POST /api/v1/plugins/install-from-url`（拉 URL 解析）与
  `POST /api/v1/plugins/install-upload`（上传 manifest JSON 文件）。
  `POST /api/v1/plugins/validate-manifest` 仅校验不入库。
- 安装 = `plugin_installations` 表按 `userId+pluginId` upsert（配置默认值
  来自 `settings.schema.properties[*].default`）；没有镜像/容器拉取步骤。

```
端点（plugins.router.ts）:
GET  /api/v1/plugins/catalog                          检索目录
GET  /api/v1/plugins/catalog/:namespace/:name         目录项（含完整 manifest）
POST /api/v1/plugins/install                          按 pluginId 安装
POST /api/v1/plugins/install-from-url / install-upload  社区 manifest 发布+安装
POST /api/v1/plugins/validate-manifest                仅校验
GET  /api/v1/plugins/installed / installed-ui / audit-logs
POST /api/v1/plugins/:id/enable / disable             DELETE /api/v1/plugins/:id
GET/PUT /api/v1/plugins/:id/settings                  配置读写（secret 解密后返回）
```

## 3. Manifest Schema（as-built 字段，与 plugin-catalog.service.ts 的 TS 类型一致）

```json
{
  "manifest_version": "1.0.0",
  "plugin": {
    "id": "heurion/docx",
    "name": "DOCX Renderer",
    "version": "1.0.0",
    "description": "Generate Word documents from templates.",
    "category": "execution",
    "author": { "name": "Heurion", "email?": "...", "url?": "..." },
    "license?": "MIT",
    "icon_url?": "...",
    "homepage?": "...",
    "tags?": ["docx"]
  },
  "runtime":   { "type": "container|wasm|process|in-process", "...": "见 §4" },
  "permissions": { "...": "声明性元数据，校验器不消费（见 §5）" },
  "tools":     [ { "name": "generate_docx", "description": "...", "parameters": {...}, "returns?": {} } ],
  "triggers?": [ { "intent": "docx", "patterns": ["docx", "word", "病例总结"] } ],
  "settings?": { "schema": { "type": "object", "properties": { "...": "见 §7" } } },
  "ui?":       { "bundle_url": "...", "integrity?": "sha256-<base64>", "extension_points": [ { "type": "...", "target?": "...", "id": "dashboard_card", "label?": "..." } ], "permissions?": ["..."] }
}
```

| 字段 | 类型 | 必填 | 校验（plugin-validation.service.ts） |
|---|---|---|---|
| `manifest_version` | string | ✅ | 非空字符串（**不校验 SemVer**） |
| `plugin.id` | string | ✅ | `/^[a-z0-9]([a-z0-9._\-/]*[a-z0-9])?$/i`（大小写不敏感）+ 禁 `..`（路径穿越防御）；**全局唯一性靠 catalog upsert 的 id 主键，非安装时扫描** |
| `plugin.name` / `version` / `description` / `category` | string | ✅ | 非空字符串；category **不做枚举校验**（官方目录用 `execution`/`rendering`/`automation`，与提案枚举已不同——"rendering" 即提案没有的新值） |
| `plugin.author.name` | string | ✅ | 非空 |
| `runtime` | object | ✅ | `type` ∈ `{container, wasm, process, in-process}`；container→`image` 必填；wasm→`module` 必填；process→`command[]` 必填 |
| `tools` | array | ✅ 非空 | 每项 `name`/`description`/`parameters(object)` 必填；**name 全局唯一性无校验** |
| `triggers` | array | 可选 | 每项 `intent` 必填 + `patterns` 非空数组 |
| `permissions` / `settings` / `ui` / `skills` / `dependencies` | — | 可选 | permissions **形状强校验**（#中-12：四个已知能力键 + 类型，未知键/类型错误拒绝）；skills/dependencies 在 TS 类型之外（校验器忽略，安装流程不消费——skills 注册与依赖解析均未实现，见 §8） |

提案 §3.3 的 category 枚举（connector/execution/data_source/ui/automation/other）
未实现——校验器只要求非空字符串，官方目录实际用 `execution`（docx/pptx/table/
plot/pdf）、`rendering`（bioscene/chart）、`automation`（browser-agent）。

## 4. Runtime（as-built）

### 4.1 `container`（官方渲染插件：heurion/docx|pptx|table|plot|pdf）

容器镜像在 worker（python 执行面）侧运行；控制面不直接起容器——工具调用被
编排为执行面 job：

```json
{ "type": "container", "image": "heurion/plugin-docx:1.0.0", "port": 8080,
  "resources": { "cpu": "1", "memory": "512m", "max_execution_seconds": 60 } }
```

- 官方 5 个渲染插件的 job type 映射到**契约渲染 job**（`sidecar.generate_docx`
  等，`RENDER_TOOL_TYPES`，`plugin-capability.service.ts`）——worker 只注册
  契约 job type，第三方插件退回 legacy 命名 `sidecar.<pluginId>.<toolName>`
  （#766，对 worker 而言同样是 unknown type，等于未支持）。
- 渲染参数有**内容保证层**（#451）：LLM 按工具 `parameters` 构造 payload →
  contracts `validateRenderContent` 校验 → 带精确 schema 错误重试一次 →
  仍失败用文本派生的最小合法内容模型（生成器永不接收空 data）。
- 模板 ID 修正（#451-fix）：docx 只带 `case_summary`/`discharge_summary`
  模板，`RENDER_TEMPLATE_IDS` 把 `default` 重映射为 `case_summary`。

### 4.2 `in-process`（提案没有的类型，官方 bioscene/chart/browser-agent 在用）

```json
{ "type": "in-process", "resources": { "max_execution_seconds": 30 } }
```

工具在控制面进程内执行（BioScene/图表确定性 SVG 渲染器、browser-agent 的
Cloudflare Worker 桥）。校验器白名单含 `in-process`；`PluginManifest` TS
类型的 runtime.type 联合**尚未**包含该值（类型注记滞后，实际数据已用）。

### 4.3 `process` / `wasm`

- `process`：校验器支持（command 数组必填），但仓库当前无桌面端承载，
  官方目录无用例——规范保留。
- `wasm`：校验器仅要求 `module` 字段存在，**无实际 wasm 运行时**——占位。

## 5. Permissions（声明性 + 形状强校验，非强制闸门）

`permissions` 目前仍是声明性元数据（无 `phi_access:true 需审批` 的检查，
无 registry 白名单），但**形状已 fail-closed 校验**（#中-12 起）：
`validateManifest` 接受 `network_egress{enabled:boolean,description?}` /
`file_system{read:boolean,write:boolean,paths?:string[]}` / `phi_access:boolean` /
`execute_code:boolean` 四个已知能力键，未知键或类型错误在安装/发布时即被
拒绝——声明不再被静默忽略。实际安全机制在别处：

- 官方渲染插件 `network_egress.enabled=false`：worker 渲染器本身零外呼
  （渲染边界见 `RENDER_BOUNDARY.md`）。
- in-process 工具不自带网络/文件能力——需要什么由 ToolContext 注入的
  port 提供（#666），插件代码不直接持有系统能力。
- browser-agent 的网络面来自其 `settings` 里的 `worker_url`/`worker_token`
  （用户自己配置的 Cloudflare Worker），manifest 里的 network_egress 声明
  是文档性描述。
- 配置里的 secret（见 §7）加密落库是唯一真正强制的安全约束。

提案 §5 的字段级权限规范（file_system.paths / use_gpu / send_notifications 等）
**未实现强制语义**，保留为声明性元数据。

## 6. Tools：命名与调用协议（与提案的实质偏差）

### 6.1 Tool Schema（与提案一致）

```json
{ "name": "generate_docx", "description": "...",
  "parameters": { "type": "object", "properties": {...}, "required": [...] },
  "returns?": { "type": "object", "..." : "..." } }
```

### 6.2 Tool 命名（提案决策未采用 — as-built 事实）

- **实际是裸名**（`generate_docx` / `render_chart` / `browser_task`），不含
  `{plugin_id}:` 前缀；提案的 `heurion/medsci-sidecar:generate_docx` 格式在
  全仓无一处实现。
- 工具在插件内按 name 查找（`buildPayload` 的 `tools.find`）；跨插件区分
  靠**调用方记录 `pluginId + toolName` 二元组**——内部映射表以
  `${pluginId}.${toolName}` 点号拼接为键（`RENDER_TOOL_TYPES` /
  `DATA_SHAPE_HINTS`），非 manifest 命名约定。
- tool name 全局唯一性：校验器不检查；官方目录靠命名不冲突（`generate_docx`
  等带域名前缀语义但无命名空间语法）。

### 6.3 调用协议（提案 §6.3 的 `POST /v1/tools/invoke` 未实现）

实际链路（`plugin-chat-handler.ts` → `plugin-capability.service.ts` →
`modules/execution/execution-plane.service.ts`）：

```
turnIntent.action === 'generate'（上游 decodeTurnIntent 裁定, #579）
  → matchIntent(userId, turn)         triggers 模式匹配（§6.4）
  → buildPayload(pluginId, toolName)  服务端构造 payload（LLM + schema 校验 +
                                      纠错重试 + 兜底；非插件自身暴露 HTTP 端点）
  → executionService.enqueue(jobType, payload, tenant)
  → python worker 渲染 → file_id → presigned 下载 URL（#447, 诚实下载链接）
```

- 插件**不暴露**统一的 `/v1/tools/invoke` HTTP 端点；容器插件只是 worker
  镜像内部的渲染服务，调用面在执行面 job 层。
- 会话侧 SSE 事件流（供前端渲染进度）：
  `plugin_selected` → `payload_building` → `job_enqueued` → `job_status`（轮询
  ≥30s）→ `file_ready { file_id, file_name, mime_type }`；响应含
  `{ text, job, file { fileId, fileName, mimeType, downloadUrl, expiresIn } }`。
- 未命中行为（#558/#451）：已装插件但触发词不命中 → 回退普通对话（不再
  循环提示安装）；什么都没装 → 提示去插件市场装官方渲染插件。
- 审计：每次调用写 `plugin_audit_log`（`recordPluginInvocation`：
  pluginId/toolName/jobId/status/durationMs/inputSummary/errorMessage），
  卸载时级联删除（#454）。

### 6.4 Triggers（提案 v1.1"未来项"，实际 v1 已交付）

```json
{ "triggers": [ { "intent": "docx", "patterns": ["docx", "word", "病例总结", "出院小结", "discharge summary"] } ] }
```

- `matchIntent`（`plugin-capability.service.ts`）：仅 `generate` 动作咨询
  trigger；文本（小写化）`includes(pattern)` 命中，置信度 =
  `pattern.length / max(text.length, 1)`（最长 pattern 胜出，平手取先注册）。
- 两道护栏（#557）：`DISCUSSION_MARKERS` / `EDIT_MARKERS`（检索路由的
  编辑/讨论语义锚点）证明是编辑/讨论 → 返回 `'edit-or-discuss'`，**生成插件
  在设计上就是错的**，调用方转回普通对话；无命中且已装插件 → 同样回退
  （裸确认"是的/开始"不该循环提示安装）。
- 三向返回值约定（#558）：`PluginMatch` / `'edit-or-discuss'` / `null`。
- 官方目录：5 个渲染插件各带 1 个 trigger；3 个 in-process 插件
  （bioscene/chart/browser-agent）`triggers: []`（不走对话触发，经工具注册
  调用）。winning trigger 只取 `manifest.tools[0]`（每个渲染插件恰好 1 个
  工具的结构性假设，写死在 matchIntent）。

## 7. Settings（as-built）

```json
{ "settings": { "schema": { "type": "object", "properties": {
    "worker_url":   { "type": "string", "description": "Cloudflare Worker endpoint" },
    "worker_token": { "type": "string", "format": "password", "description": "..." }
} } } }
```

- **安装时播种默认值**：`buildDefaultConfig` 把 `properties[*].default` 写进
  `plugin_installations.config`（JSON 存储，`plugin-installation.service.ts`）。
- **secret 处理**：`format: 'secret'` 的字段写入时用 AES-256-GCM 加密
  （`enc:` 前缀，`common/settings-encryption.ts`，密钥 `PLUGIN_ENCRYPTION_KEY`
  / `SERVER_SECRET` 派生），读出时解密；前端对 secret 渲染密码框
  （`plugin-settings.tsx`）。
- ⚠️ **已发现的漂移**：官方 browser-agent manifest 用的是
  `format: "password"`——而加密层与前端只识别 `'secret'`，该 token 目前
  **以明文落库**。修复应把官方 manifest 的 format 改为 `secret`（或让
  `isSecretField` 同时识别 `password`）。

## 8. 未实现的部分（提案 §7/§10 的裁决修订）

| 提案条目 | 实际 |
|---|---|
| §7 Skills（插件附带 prompt skills 自动注册） | **未实现**——`skills` 字段校验器忽略，官方目录 8 个插件均不带，安装时不注册任何 prompt skill |
| §10 插件依赖 + 自动安装 + 循环检测 + 卸载保护 | **未实现**——manifest 无 `dependencies` 字段语义，`installPlugin` 无依赖解析；`heurion` 版本兼容检查未实现 |
| §15 决策 4（plugin 间通信 → v2.0） | 维持：未实现 |
| §9 UI 扩展 | **已实现但形态不同**，见 §9 |

## 9. UI 扩展（as-built，与提案 §9 的 `panels/settings_pages` 形态不同）

```json
{ "ui": {
    "bundle_url": "https://…/plugin.js",
    "integrity": "sha256-<base64>",          // SRI 式完整性校验
    "extension_points": [ { "type": "panel", "target": "chat_toolbar", "id": "chat_toolbar", "label?": "..." } ]
} }
```

运行时（`packages/web/src/components/plugins/`）：

- **加载**：`PluginUIProvider` 拉取 `GET /api/v1/plugins/installed-ui`
  （enabled=1 且带 `ui` 字段），按 `bundle_url` 动态 `import()`；
  有 `integrity` 时先拉文本用 `crypto.subtle` 校验
  （sha256/sha384/sha512-`-<base64>` 格式），**校验失败降级为 sandbox
  iframe**（`sandbox="allow-scripts"`）——同一个 URL 换一种隔离形态，不
  静默丢弃。
- **注册**：bundle 执行期间全局暴露
  `window.__HEURION_PLUGIN_RUNTIME__`（`register(extensionPointId, factory)` +
  `api`（带 token 的受限 fetch）/`context`/`events`/`storage`（per-plugin
  localStorage 前缀）/`ui`（toast/modal/navigate，裸 DOM 实现 #688））。
- **渲染**：`<PluginExtensionPoint point="...">` 挂点，工厂产物装入
  closed Shadow DOM 宿主（样式隔离），iframe fallback 同位渲染。
- **生产在用的扩展点**（官方 manifest 尚未带 ui 字段，端点本身开放给
  第三方）：`dashboard_card`（today.tsx）、`patient_detail`（patients.tsx）、
  `chat_toolbar`（chat.tsx，layout=row）、`settings_page`
  （plugin-settings.tsx）。
- 提案 §9 的 `panels[].route/entry`、独立 `settings_pages` 未实现——
  设置页走统一的 `plugin-settings.tsx`（按 settings.schema 渲染表单），
  UI 扩展只有"挂载点"一种形态。

## 10. 校验规则（提案 §14 → 实际清单）

`validateManifest`（plugin-validation.service.ts）实际执行：

1. 顶层必须是 JSON object。
2. `manifest_version` 非空字符串。
3. `plugin.{id,name,version,description,category}` 非空字符串。
4. `plugin.id` 匹配字符集 + 禁 `..`（防路径类注入）。
5. `plugin.author.name` 非空。
6. `runtime.type` ∈ 四类；按类型要求 image/module/command。
7. `tools` 非空数组，逐项 name/description/parameters。
8. `triggers`（可选）逐项 intent + patterns 非空。

提案有而**未实现**的校验：SemVer 格式、category 枚举、tool name 唯一性、
`phi_access` 附加审批、镜像 registry 白名单、secret 字段加密校验（加密在
写入配置时才发生，校验器不看）。安装动作本身没有用户确认步骤
（validate → 直接 upsert 安装行）。

## 11. 完整示例：官方目录真实形状

`packages/server-ts/data/official-plugins.json`（8 个）：

| plugin.id | category | runtime | tools | triggers |
|---|---|---|---|---|
| `heurion/docx` | execution | container | `generate_docx` | `docx`（word/病例总结/出院小结/discharge summary） |
| `heurion/pptx` | execution | container | `generate_pptx` | `pptx`（ppt/幻灯片/汇报/presentation） |
| `heurion/table` | execution | container | `render_table` | `table`（表格/基线特征/baseline/table 1） |
| `heurion/plot` | execution | container | `render_plot` | `plot`（chart/图表/曲线/km curve/forest plot） |
| `heurion/pdf` | execution | container | `convert_to_pdf` | `pdf`（convert to pdf/导出 pdf） |
| `heurion/bioscene` | rendering | in-process | `render_scene` | — |
| `heurion/chart` | rendering | in-process | `render_chart` | — |
| `heurion/browser-agent` | automation | in-process | `browser_task` | —（网络经 settings.worker_url） |

官方渲染插件工具的 `data` 参数承载 contracts 的 versioned render-content
模型（`SCHEMA_VERSION`，见 `RENDER_BOUNDARY.md`）。

## 12. 版本演进（修订版）

| 版本 | 变更 |
|---|---|
| `1.0.0` | 已交付：container/in-process runtime（process/wasm 为占位）、tools、triggers、settings（含 secret 加密）、声明性 permissions、UI 扩展点（bundle_url + integrity + 挂载点） |
| 未来候选 | 插件 skills 注册、依赖系统与循环检测、tool 命名空间化（若第三方工具冲突成为现实问题）、UI 扩展点扩展 |

## 13. 已决策事项的最终状态（对照提案 §15）

| # | 问题 | 提案决策 | 实际状态 |
|---|---|---|---|
| 1 | Tool 命名格式 | `{plugin_id}:{tool_name}` | **未采用**——裸 tool 名 + 调用方持 pluginId；内部映射用点号键 |
| 2 | 插件依赖声明 | v1.0 支持 | **未实现**（留待后续） |
| 3 | UI 扩展 | panels/settings_pages | **形态变更**：bundle_url + integrity + extension_points 挂载点 |
| 4 | 插件间通信 | 留 2.0 | 未实现（与提案一致） |
| 5 | Runtime 类型 | container 为主，process 为辅，wasm 实验性 | 实际主力是 container + **in-process**（提案漏掉的类型）；process/wasm 为占位 |
