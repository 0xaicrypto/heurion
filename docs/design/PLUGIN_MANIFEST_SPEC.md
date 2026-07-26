# Heurion Plugin Manifest 规范 v1.0

**Status:** Design proposal (v1.0)  
**更新:** 2026-07-26  
**Deciders:** JZ (architect), backend team  

---

## 1. 目标

定义 Heurion 插件市场的标准 manifest 格式，使得：

- Plugin Manager 能自动解析、安装、配置插件。
- 主 Agent 能自动发现插件提供的 tools。
- 安全系统能根据声明的权限进行最小化授权。
- 开发者能清晰知道如何编写兼容的插件。

---

## 2. 文件位置

每个插件包的根目录下必须包含：

```
my-plugin/
├── plugin.manifest.json    # 本规范定义的文件
├── runtime/                # 运行时代码或容器定义
├── tools/                  # tool 定义（可选，也可在 manifest 中内联）
├── skills/                 # 可选的 prompt skills
├── ui/                     # 可选的 UI 扩展
└── README.md
```

---

## 3. Manifest Schema

### 3.1 顶层字段

```json
{
  "manifest_version": "1.0.0",
  "plugin": {
    "id": "heurion/medsci-sidecar",
    "name": "MedSci Sidecar",
    "version": "1.0.0",
    "description": "Generate publication-ready medical and scientific documents.",
    "category": "execution",
    "author": {
      "name": "Heurion",
      "email": "plugins@heurion.io",
      "url": "https://heurion.io"
    },
    "license": "MIT",
    "icon_url": "https://cdn.heurion.io/plugins/icons/medsci-sidecar.png",
    "homepage": "https://docs.heurion.io/plugins/medsci-sidecar",
    "tags": ["medical", "research", "docx", "pptx", "pdf"]
  },
  "runtime": { ... },
  "permissions": { ... },
  "tools": [ ... ],
  "skills": [ ... ],
  "settings": { ... },
  "ui": { ... },
  "dependencies": { ... }
}
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `manifest_version` | string | ✅ | Manifest 规范版本，当前为 `1.0.0` |
| `plugin.id` | string | ✅ | 全局唯一插件 ID，建议 `org/name` 格式 |
| `plugin.name` | string | ✅ | 展示名称 |
| `plugin.version` | string | ✅ | 语义化版本，如 `1.0.0` |
| `plugin.description` | string | ✅ | 简短描述 |
| `plugin.category` | string | ✅ | 见下方 category 枚举 |
| `plugin.author` | object | ✅ | 作者信息 |
| `plugin.license` | string | ❌ | 开源协议或商业授权 |
| `plugin.icon_url` | string | ❌ | 插件图标 URL |
| `plugin.homepage` | string | ❌ | 文档链接 |
| `plugin.tags` | array | ❌ | 搜索标签 |

### 3.3 Category 枚举

| 值 | 说明 |
|---|---|
| `connector` | 外部系统连接器 |
| `execution` | 代码/文件执行 |
| `data_source` | 外部数据源 |
| `ui` | 前端 UI 扩展 |
| `automation` | 定时/触发任务 |
| `other` | 其他 |

---

## 4. Runtime 规范

### 4.1 Container Runtime（推荐）

```json
{
  "runtime": {
    "type": "container",
    "image": "heurion/plugin-medsci-sidecar:1.0.0",
    "command": ["python", "-m", "sidecar.server"],
    "port": 8080,
    "resources": {
      "cpu": "1",
      "memory": "512Mi",
      "max_execution_seconds": 60
    },
    "env": {
      "SIDEcar_LOG_LEVEL": "INFO"
    },
    "health_check": {
      "path": "/health",
      "interval_seconds": 10
    }
  }
}
```

### 4.2 Process Runtime（本地桌面）

```json
{
  "runtime": {
    "type": "process",
    "command": [".venv/bin/python", "-m", "sidecar.server"],
    "port": 8765,
    "resources": {
      "max_execution_seconds": 60
    }
  }
}
```

### 4.3 WASM Runtime（未来）

```json
{
  "runtime": {
    "type": "wasm",
    "module": "plugin.wasm"
  }
}
```

---

## 5. Permissions 规范

```json
{
  "permissions": {
    "network_egress": {
      "enabled": true,
      "allowlist": ["slack.com", "api.github.com"]
    },
    "file_system": {
      "read": true,
      "write": true,
      "paths": ["/tmp/sidecar", "/workspace"]
    },
    "phi_access": false,
    "execute_code": true,
    "use_gpu": false,
    "send_notifications": false
  }
}
```

### 5.1 权限字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `network_egress.enabled` | boolean | 是否允许出站网络 |
| `network_egress.allowlist` | array | 允许的域名/IP 列表；为空表示禁止所有出站 |
| `file_system.read` | boolean | 是否允许读文件 |
| `file_system.write` | boolean | 是否允许写文件 |
| `file_system.paths` | array | 允许访问的路径前缀 |
| `phi_access` | boolean | 是否接触患者健康信息（PHI） |
| `execute_code` | boolean | 是否执行任意代码 |
| `use_gpu` | boolean | 是否使用 GPU |
| `send_notifications` | boolean | 是否向用户发送通知 |

---

## 6. Tools 规范

### 6.1 Tool Schema

```json
{
  "tools": [
    {
      "name": "sidecar_generate_docx",
      "description": "Generate a Word document from a template and structured data.",
      "parameters": {
        "type": "object",
        "properties": {
          "template_id": {
            "type": "string",
            "description": "Template identifier"
          },
          "data": {
            "type": "object",
            "description": "Data to fill placeholders"
          },
          "output_name": {
            "type": "string",
            "description": "Suggested output filename without extension"
          }
        },
        "required": ["template_id", "data"]
      },
      "returns": {
        "type": "object",
        "properties": {
          "file_id": { "type": "string" },
          "file_name": { "type": "string" },
          "mime_type": { "type": "string" },
          "size_bytes": { "type": "integer" }
        },
        "required": ["file_id", "file_name", "mime_type"]
      }
    }
  ]
}
```

### 6.2 Tool 命名规范

**已决策：采用 `{plugin_id}:{tool_name}` 格式。**

- 全局唯一，格式：`{plugin_id}:{tool_name}`。
- 示例：`heurion/medsci-sidecar:generate_docx`。
- Tool name 只能包含小写字母、数字、下划线、连字符。
- `plugin_id` 与 manifest 中的 `plugin.id` 一致。

### 6.3 Tool 调用协议

Plugin runtime 必须暴露统一的 tool invocation endpoint：

```
POST /v1/tools/invoke
Content-Type: application/json

{
  "tool": "sidecar_generate_docx",
  "arguments": {
    "template_id": "case_summary",
    "data": { ... }
  },
  "context": {
    "user_id": "user_xxx",
    "workspace_id": "ws_xxx",
    "request_id": "req_xxx"
  }
}
```

响应：

```json
{
  "success": true,
  "output": {
    "file_id": "file_xxx",
    "file_name": "ZQ_Case_Summary.docx",
    "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "size_bytes": 24576
  },
  "error": ""
}
```

失败响应：

```json
{
  "success": false,
  "output": null,
  "error": "Template 'case_summary' not found. Available templates: [...]"
}
```

---

## 7. Skills 规范（可选）

插件可附带 prompt skills，安装时自动注册：

```json
{
  "skills": [
    {
      "name": "medsci-sidecar-guide",
      "description": "Guide the agent on when to use MedSci-Sidecar tools.",
      "instructions": "When the user asks to generate a Word document, PowerPoint, or medical table, use the sidecar tools instead of writing plain text."
    }
  ]
}
```

---

## 8. Settings 规范

```json
{
  "settings": {
    "schema": {
      "type": "object",
      "properties": {
        "api_token": {
          "type": "string",
          "format": "secret",
          "title": "API Token",
          "description": "Your Slack bot token",
          "required": true
        },
        "default_channel": {
          "type": "string",
          "title": "Default Channel",
          "description": "Default Slack channel to post messages",
          "default": "#general"
        }
      },
      "required": ["api_token"]
    }
  }
}
```

### 8.1 Setting 字段类型

| 类型 | 说明 |
|---|---|
| `string` | 普通字符串 |
| `secret` | 加密存储，UI 显示为密码框 |
| `number` | 数字 |
| `boolean` | 布尔 |
| `enum` | 下拉选择 |
| `array` | 数组 |
| `object` | 嵌套对象 |

---

## 9. UI 扩展规范（可选）

```json
{
  "ui": {
    "panels": [
      {
        "id": "patient-risk-panel",
        "name": "Risk Stratification",
        "type": "panel",
        "route": "/patient/:hash/risk",
        "entry": "ui/risk-panel.js"
      }
    ],
    "settings_pages": [
      {
        "id": "slack-settings",
        "name": "Slack Configuration",
        "entry": "ui/settings.js"
      }
    ]
  }
}
```

---

## 10. Dependencies 规范

**已决策：v1.0 支持插件依赖其他插件，安装时自动安装依赖插件。**

```json
{
  "dependencies": {
    "heurion": {
      "min_version": "2.5.0"
    },
    "plugins": {
      "heurion/file-storage": ">=1.0.0"
    }
  }
}
```

### 10.1 依赖安装规则

1. **自动安装**：安装插件 A 时，若 A 依赖插件 B，系统自动先安装 B。
2. **版本冲突**：若已安装 B 但版本不满足，提示用户升级或降级。
3. **循环依赖**：安装前检测循环依赖，发现则拒绝安装。
4. **权限继承**：依赖插件的权限也需要用户单独授权，不自动继承。
5. **卸载保护**：若插件 B 被其他插件依赖，卸载时提示需先卸载依赖方。

### 10.2 依赖声明限制

- v1.0 仅支持 `plugins` 类型依赖。
- `heurion` 版本依赖用于兼容性检查，不触发自动安装。

---

## 11. 完整示例：Slack Connector

```json
{
  "manifest_version": "1.0.0",
  "plugin": {
    "id": "heurion/slack-connector",
    "name": "Slack Connector",
    "version": "1.0.0",
    "description": "Send and receive Slack messages from Heurion.",
    "category": "connector",
    "author": {
      "name": "Heurion",
      "email": "plugins@heurion.io"
    },
    "license": "MIT",
    "tags": ["slack", "communication", "notification"]
  },
  "runtime": {
    "type": "container",
    "image": "heurion/plugin-slack-connector:1.0.0",
    "port": 8080,
    "resources": {
      "cpu": "0.5",
      "memory": "256Mi",
      "max_execution_seconds": 30
    }
  },
  "permissions": {
    "network_egress": {
      "enabled": true,
      "allowlist": ["slack.com", "api.slack.com"]
    },
    "file_system": {
      "read": false,
      "write": false
    },
    "phi_access": false,
    "execute_code": false,
    "send_notifications": true
  },
  "tools": [
    {
      "name": "slack_send_message",
      "description": "Send a message to a Slack channel.",
      "parameters": {
        "type": "object",
        "properties": {
          "channel": { "type": "string" },
          "text": { "type": "string" }
        },
        "required": ["channel", "text"]
      }
    },
    {
      "name": "slack_list_channels",
      "description": "List channels the bot has access to.",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  ],
  "settings": {
    "schema": {
      "type": "object",
      "properties": {
        "slack_bot_token": {
          "type": "string",
          "format": "secret",
          "title": "Slack Bot Token",
          "required": true
        }
      },
      "required": ["slack_bot_token"]
    }
  }
}
```

---

## 12. 完整示例：MedSci-Sidecar

```json
{
  "manifest_version": "1.0.0",
  "plugin": {
    "id": "heurion/medsci-sidecar",
    "name": "MedSci Sidecar",
    "version": "1.0.0",
    "description": "Generate publication-ready medical and scientific documents, tables, and plots.",
    "category": "execution",
    "author": {
      "name": "Heurion",
      "email": "plugins@heurion.io"
    },
    "license": "MIT",
    "tags": ["medical", "research", "docx", "pptx", "pdf", "chart"]
  },
  "runtime": {
    "type": "container",
    "image": "heurion/plugin-medsci-sidecar:1.0.0",
    "port": 8080,
    "resources": {
      "cpu": "1",
      "memory": "1Gi",
      "max_execution_seconds": 120
    }
  },
  "permissions": {
    "network_egress": {
      "enabled": false
    },
    "file_system": {
      "read": true,
      "write": true,
      "paths": ["/workspace", "/tmp"]
    },
    "phi_access": false,
    "execute_code": true,
    "use_gpu": false
  },
  "tools": [
    {
      "name": "sidecar_generate_docx",
      "description": "Generate a Word document from a template and structured data.",
      "parameters": {
        "type": "object",
        "properties": {
          "template_id": { "type": "string" },
          "data": { "type": "object" },
          "output_name": { "type": "string" }
        },
        "required": ["template_id", "data"]
      }
    },
    {
      "name": "sidecar_generate_pptx",
      "description": "Generate a PowerPoint presentation from a template and structured data.",
      "parameters": {
        "type": "object",
        "properties": {
          "template_id": { "type": "string" },
          "slides": { "type": "array" },
          "output_name": { "type": "string" }
        },
        "required": ["template_id", "slides"]
      }
    }
  ],
  "skills": [
    {
      "name": "medsci-sidecar-routing",
      "description": "Route document generation tasks to MedSci-Sidecar.",
      "instructions": "When the user asks for Word/PPT documents, tables, or medical plots, use the sidecar tools."
    }
  ],
  "settings": {
    "schema": {
      "type": "object",
      "properties": {
        "default_template_set": {
          "type": "string",
          "title": "Default Template Set",
          "default": "heurion-default",
          "enum": ["heurion-default", "cns-style", "nih-style"]
        }
      }
    }
  }
}
```

---

## 13. 版本演进

| 版本 | 变更 |
|---|---|
| `1.0.0` | 初始版本，支持 container/process runtime、tools、skills、settings、permissions、UI extension、plugin dependencies |
| `1.1.0`（未来）| 增加 automation triggers、更多 UI 扩展点 |
| `2.0.0`（未来）| 增加 WASM runtime、plugin-to-plugin 调用（若业务需要） |

---

## 14. 校验规则

Plugin Manager 安装插件时必须校验：

1. `plugin.id` 全局唯一且符合 `^[a-z0-9][a-z0-9_.\-/]*$`。
2. `plugin.version` 符合 SemVer。
3. `plugin.category` 在枚举范围内。
4. `tools` 中每个 tool 的 `name` 全局唯一。
5. `permissions` 中 `phi_access: true` 的插件需要额外审批。
6. `runtime.image` 必须来自允许的 registry。
7. `settings.schema` 中 `secret` 字段必须加密存储。

---

## 15. 已决策事项

| # | 问题 | 决策 |
|---|---|---|
| 1 | Tool 命名格式 | **采用 `{plugin_id}:{tool_name}`**。 |
| 2 | 插件依赖声明 | **v1.0 支持**，安装时自动安装依赖插件，需防循环依赖。 |
| 3 | UI 扩展 | **进入 v1.0 manifest**，支持 `panels`、`settings_pages` 等扩展点。 |
| 4 | Plugin 间通信 | **v1.0 manifest 不支持**，保留到 2.0.0。 |
| 5 | Runtime 类型 | **container 为主，process 为辅，wasm 为实验性**。 |
