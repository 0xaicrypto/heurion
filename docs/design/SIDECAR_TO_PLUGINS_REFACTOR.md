# Sidecar → Plugins Refactor RFC

**Status:** Phase 1 implemented + production hardening (audit log, secret encryption, Docker network isolation, job-type mapping); Phase 2 third-party install and UI plugin runtime partial  
**Updated:** 2026-07-28  
**Deciders:** JZ (architect), product team  
**Related docs:**
- `docs/design/PLUGIN_MARKETPLACE.md`
- `docs/design/PLUGIN_MANIFEST_SPEC.md`
- `docs/design/MEDSCI_SIDECAR.md`

---

## 1. Background & Goals

Today, Heurion's file-generation capabilities are hard-coded inside the Control Plane (`sidecar-chat-handler.ts`) and the Execution Plane (`sidecar.py`). DOCX, PPTX, table, plot, and PDF conversion are all baked into one module, with a fixed allow-list in `execution.router.ts`.

This RFC defines how to refactor these capabilities into **installable, containerized plugins**, while keeping the existing Skills marketplace separate.

### Goals

1. **Decompose Sidecar** into independent official plugins (`heurion/docx`, `heurion/pptx`, `heurion/table`, `heurion/plot`, `heurion/pdf`).
2. **Introduce a Plugin Manager** in the Control Plane with catalog, per-user installation, enable/disable, and settings.
3. **Run every plugin in its own container** from day one, using the existing worker queue for scheduling.
4. **Allow third-party plugins** to be developed as container images + manifest, and installed by users.
5. **Support UI Plugins** through React dynamic loading, allowing plugins to extend the Heurion frontend safely.
6. **Support a WASM runtime** for lightweight, sandboxed computation-oriented plugins.
7. **Position the Plugin Marketplace as a standalone product** with external APIs, so other agents and applications can discover, install, and invoke plugins without using the Heurion web app.
8. **Keep the Skills marketplace independent**; skill-based capabilities are not in scope for this refactor.
9. **Maintain backward compatibility** for old job types and existing chat triggers during the migration window.

### Non-goals

- Workspace-level plugin installation (per-workspace billing/governance) — deferred until workspace concept is introduced.
- Paid / commercial plugin billing and revenue share mechanics — deferred.

---

## 2. High-level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Heurion Web (React)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Marketplace  │  │ Installed    │  │ Developer / Manual       │  │
│  │ (official +  │  │ (enable /    │  │ install (URL/zip)        │  │
│  │  community)  │  │  disable /   │  │                          │  │
│  │              │  │  configure)  │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
└─────────┼─────────────────┼───────────────────────┼────────────────┘
          │                 │                       │
          └─────────────────┴───────────────────────┘
                            │ REST
┌───────────────────────────▼─────────────────────────────────────────┐
│                    Control Plane (server-ts)                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Plugin Catalog   │  │ Plugin           │  │ Plugin Capability│  │
│  │ Service          │  │ Installation     │  │ Service          │  │
│  │                  │  │ Service          │  │ (chat routing)   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                     │            │
│           └─────────────────────┴─────────────────────┘            │
│                             │ enqueue job                           │
│                             │ (only if plugin installed & enabled)  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ Redis
┌─────────────────────────────▼───────────────────────────────────────┐
│                    Execution Plane (heurion_worker)                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Plugin Runner                                                 │  │
│  │  - poll job                                                   │  │
│  │  - resolve plugin image from manifest                         │  │
│  │  - run container with tenant context + secrets + templates    │  │
│  │  - POST /v1/tools/invoke                                      │  │
│  │  - update job status + file metadata                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                    │
│           ▼                  ▼                  ▼                    │
│     ┌──────────┐      ┌──────────┐      ┌──────────┐                │
│     │ heurion/ │      │ heurion/ │      │ third-   │                │
│     │ docx     │      │ pptx     │      │ party/x  │                │
│     │ container│      │ container│      │ container│                │
│     └────┬─────┘      └────┬─────┘      └────┬─────┘                │
│          │                 │                 │                       │
│          └─────────────────┴─────────────────┘                       │
│                            │                                         │
│                            ▼                                         │
│              Tenant-isolated Object Storage (S3/MinIO)               │
└─────────────────────────────────────────────────────────────────────┘
```

### Key design principle

The Control Plane never runs plugin code. It only:

1. Decides which plugin (if any) matches a user request.
2. Verifies the plugin is installed and enabled for that user.
3. Builds the invocation payload.
4. Enqueues a job with a well-known `job.type`.

The Execution Plane is the only place that executes plugin containers.

### 2.1 Product-level architecture

The Plugin Marketplace is designed as a **standalone product surface**, not just a Heurion web-app feature. Other agents and partner applications can consume it, and plugins can extend both backend and frontend.

```
External Agents / Partner Apps                Heurion Web (React)
        |                                            |
        |  OAuth2 / API keys / mTLS                  |  UI Plugin runtime
        |                                            |  (Shadow DOM + iframe fallback)
        ▼                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Plugin Marketplace (Control Plane)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Catalog API  │  │ Installation │  │ External Auth & Quotas   │  │
│  │              │  │ API          │  │                          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  Container Runtime        WASM Runtime           UI Extension
  (docx/pptx/...)          (compute/...)          (panels/cards)
```

This means a hospital's own agent, a research collaboration platform, or a third-party clinical tool can all use the same plugin catalog and execution infrastructure through the external API.

---

## 3. Plugin Manifest

Each plugin ships with a `plugin.manifest.json` that follows `docs/design/PLUGIN_MANIFEST_SPEC.md`. For this refactor we use a constrained subset focused on containerized execution plugins.

### 3.1 Manifest schema (v1.0 subset)

```json
{
  "manifest_version": "1.0.0",
  "plugin": {
    "id": "heurion/docx",
    "name": "DOCX Report Generator",
    "version": "1.0.0",
    "description": "Generate Word documents from clinical summaries and templates.",
    "category": "execution",
    "author": { "name": "Heurion", "email": "plugins@heurion.io" },
    "license": "MIT",
    "icon_url": "https://cdn.heurion.io/plugins/icons/docx.png",
    "tags": ["report", "docx", "document"]
  },
  "runtime": {
    "type": "container",
    "image": "heurion/plugin-docx:1.0.0",
    "port": 8080,
    "resources": {
      "cpu": "1",
      "memory": "512Mi",
      "max_execution_seconds": 60
    },
    "env": {
      "PLUGIN_LOG_LEVEL": "INFO"
    },
    "health_check": {
      "path": "/health",
      "interval_seconds": 10
    }
  },
  "permissions": {
    "network_egress": { "enabled": false },
    "file_system": { "read": true, "write": true, "paths": ["/workspace", "/tmp"] },
    "phi_access": false,
    "execute_code": false
  },
  "tools": [
    {
      "name": "generate",
      "description": "Generate a Word document from a template and structured data.",
      "parameters": {
        "type": "object",
        "properties": {
          "template_id": { "type": "string" },
          "data": { "type": "object" },
          "output_name": { "type": "string" }
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
  ],
  "triggers": [
    { "intent": "docx", "patterns": ["docx", "word", "病例总结", "出院小结", "discharge summary"] }
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

### 3.2 Built-in plugins

| Plugin ID | Image | Responsibility | Old job type alias |
|---|---|---|---|
| `heurion/docx` | `heurion/plugin-docx:1.0.0` | Word reports, case summaries, discharge notes | `sidecar.generate_docx` |
| `heurion/pptx` | `heurion/plugin-pptx:1.0.0` | Academic slides, case conferences | `sidecar.generate_pptx` |
| `heurion/table` | `heurion/plugin-table:1.0.0` | Table 1, baseline characteristics, AE summaries | `sidecar.render_table` |
| `heurion/plot` | `heurion/plugin-plot:1.0.0` | KM curves, bar/line/scatter plots | `sidecar.render_plot` |
| `heurion/pdf` | `heurion/plugin-pdf:1.0.0` | Convert DOCX/PPTX to PDF | `sidecar.convert_to_pdf` |

Each built-in plugin starts as a thin container wrapping the existing logic in `sidecar.py`. Over time they can evolve independently (e.g., the PDF plugin can switch from `pypandoc` to `LibreOffice` without touching the others).

---

## 4. Data Model

Use Prisma-style tables. All tables are scoped per user for this phase.

### 4.1 `PluginCatalog`

Read-only registry of available plugins. For the official catalog this can be a JSON file shipped with the server; for community plugins it can be fetched from an external registry.

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | `heurion/docx`, `acme/slack-connector` |
| `source` | string | `official`, `community`, `manual` |
| `manifest` | JSON | Full `plugin.manifest.json` |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

### 4.2 `PluginInstallation`

One row per user per installed plugin.

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | cuid |
| `userId` | string FK | |
| `pluginId` | string FK | references `PluginCatalog.id` |
| `version` | string | installed version |
| `enabled` | boolean | default true |
| `config` | JSON | user-provided settings from manifest schema |
| `installedAt` | datetime | |
| `updatedAt` | datetime | |

Unique constraint: `(userId, pluginId)`.

### 4.3 `PluginAuditLog`

Record every plugin invocation. Can reuse the existing EventLog infrastructure or a dedicated table. Recommended dedicated table for fast queries.

| Field | Type |
|---|---|
| `id` | string PK |
| `userId` | string |
| `pluginId` | string |
| `toolName` | string |
| `jobId` | string |
| `status` | string |
| `durationMs` | int |
| `inputSummary` | string (no PHI) |
| `errorMessage` | string |
| `createdAt` | datetime |

---

## 5. API Endpoints

All endpoints require authentication.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/plugins/catalog` | List marketplace catalog. Query: `?source=&query=` |
| GET | `/api/v1/plugins/catalog/:id` | Plugin details including manifest and permissions |
| POST | `/api/v1/plugins/install` | `{ pluginId, version? }` — install for current user |
| DELETE | `/api/v1/plugins/:id` | Uninstall for current user |
| POST | `/api/v1/plugins/:id/enable` | Enable plugin |
| POST | `/api/v1/plugins/:id/disable` | Disable plugin |
| GET | `/api/v1/plugins/installed` | List current user's installed plugins |
| GET | `/api/v1/plugins/:id/settings` | Get settings schema + current values |
| PUT | `/api/v1/plugins/:id/settings` | Save settings values |
| POST | `/api/v1/plugins/validate` | (Dev) Validate an uploaded manifest |

The existing Skills marketplace endpoints (`/api/v1/skills/*`) remain unchanged.

---

## 6. Control Plane Implementation

Create `packages/server-ts/src/modules/plugins/`.

### 6.1 `plugin-catalog.service.ts`

- Loads the official catalog from `data/official-plugins.json` or similar.
- Merges with community registry if configured.
- Provides `getById(id)` and `search(query, source)`.
- Caches manifests in memory; reload on deployment.

### 6.2 `plugin-installation.service.ts`

- CRUD for `PluginInstallation`.
- On install: validate manifest exists, ensure permissions are acceptable, create row with default config.
- On uninstall: delete row; optional cleanup of user-generated plugin outputs (future).
- On enable/disable: flip flag.

### 6.3 `plugin-capability.service.ts`

- `getActivePlugins(userId)` returns installed + enabled plugins.
- `matchIntent(userId, text)` iterates through plugin `triggers` and returns the best matching `{ pluginId, toolName, confidence }`.
- `buildPayload(pluginId, toolName, text, patient, context)` constructs the invocation arguments. For MVP this is a generic LLM-based builder that asks the model to produce JSON matching the tool's `parameters` schema. Built-in plugins can include an `inputExample` in the manifest to guide the LLM.

### 6.4 `plugins.router.ts`

Implements the endpoints in Section 5.

### 6.5 Changes to chat flow

1. The Query Router keeps returning `intent: 'sidecar'` for report-generation-like requests.
2. The chat handler calls `pluginCapabilityService.matchIntent(userId, text)`.
3. If a match is found, it calls `buildPayload`, then enqueues a job via the execution plane service with:
   ```json
   {
     "type": "sidecar.heurion.docx.generate",
     "payload": { "template_id": "case_summary", "data": { ... }, "output_name": "..." },
     "tenant": { "userId": "..." }
   }
   ```
4. The old `sidecar-chat-handler.ts` is either removed or kept as a thin compatibility shim that delegates to the capability service.

### 6.6 Streaming reasoning trace

The chat endpoint returns Server-Sent Events (SSE). In addition to `final_answer_chunk` and `sidecar_file`, the backend emits structured reasoning events that the UI can render as an expandable "thinking" panel.

Event types:

| Event type | Purpose |
|---|---|
| `thought` | A plain-text reasoning step from the model, e.g. "The user wants a Word report." |
| `intent_detected` | Query router result, e.g. `{ intent: "sidecar", confidence: 0.95 }`. |
| `plugin_selected` | `{ pluginId: "heurion/docx", tool: "generate", confidence: 0.92 }`. |
| `payload_building` | Indicates the LLM is turning the user request into structured arguments. |
| `job_enqueued` | `{ jobId: "...", pluginId: "...", tool: "..." }`. |
| `job_status` | `{ jobId: "...", status: "running" | "completed" | "failed" }`. |
| `file_ready` | `{ fileId: "...", fileName: "...", mimeType: "..." }`. |
| `final_answer_chunk` | Traditional answer tokens. |

For plugin invocations, the trace looks like:

```
▶ 识别到报告生成意图
▶ 选择插件：DOCX Report Generator（heurion/docx）
▶ 构建模板参数：case_summary
▶ 已创建任务 job_abc123，正在执行
▶ 容器已启动，正在渲染文档
▶ 文档已生成：ZQ_Case_Summary.docx
```

The frontend collapses this trace by default and shows a compact "Thinking..." indicator; users can expand it to inspect plugin calls and intermediate steps.

### 6.7 Backward compatibility

- `POST /api/v1/execution/render` remains but internally maps old types (`sidecar.generate_docx`) to new types (`sidecar.heurion.docx.generate`).
- Old job types in Redis are still consumed by the worker during the migration window.

---

## 7. Execution Plane Implementation

### 7.1 Worker changes

Refactor `packages/server/heurion_worker/consumer.py`:

- Introduce a `PluginRunner` that resolves a job type to a plugin manifest and image.
- Job type convention: `sidecar.<plugin_id>.<tool_name>`.
- The runner pulls the image (if not present), starts a container, invokes the tool, and updates the job status.

```python
# Conceptual registry
REGISTRY = {
    "heurion/docx": {
        "image": "heurion/plugin-docx:1.0.0",
        "port": 8080,
    },
    # ...
}
```

For built-in plugins the registry can be loaded from the same official catalog JSON used by the Control Plane. For third-party plugins, the worker loads a local `plugins/` directory or queries the Control Plane for manifests.

### 7.2 Plugin container interface

Every plugin container exposes:

- `GET /health` — readiness check.
- `POST /v1/tools/invoke` — invoke a tool.

Request body:

```json
{
  "tool": "generate",
  "arguments": { "template_id": "case_summary", "data": { ... } },
  "context": { "user_id": "...", "workspace_id": "...", "request_id": "..." }
}
```

Response body:

```json
{
  "success": true,
  "output": {
    "file_id": "...",
    "file_name": "...",
    "mime_type": "...",
    "size_bytes": 12345,
    "download_url": "..."
  },
  "error": ""
}
```

The plugin container is responsible for uploading the generated file to object storage. It receives S3 credentials and endpoint via environment variables.

### 7.3 Container runtime details

Use `python-docker` (Docker SDK) from the worker:

```python
container = docker.run(
    image=manifest.runtime.image,
    network="heurion-plugins",          # restricted Docker network
    environment={
        "S3_ENDPOINT": os.environ["S3_ENDPOINT"],
        "S3_BUCKET": os.environ["S3_BUCKET"],
        "S3_ACCESS_KEY_ID": os.environ["S3_ACCESS_KEY_ID"],
        "S3_SECRET_ACCESS_KEY": os.environ["S3_SECRET_ACCESS_KEY"],
        "TENANT_PREFIX": tenant_prefix,
    },
    volumes={
        template_path: {"bind": "/templates", "mode": "ro"},
    },
    mem_limit=manifest.runtime.resources.memory,
    cpu_quota=...,
    detach=True,
)
```

After invocation, stop and remove the container. For built-in plugins we may later add a warm pool; for MVP, start-on-demand keeps the implementation simple and ensures isolation.

### 7.4 Network isolation

- Create a dedicated Docker bridge network `heurion-plugins`.
- Default policy: deny egress.
- Allow only the S3 endpoint (and any domains declared in `permissions.network_egress.allowlist` for connector plugins).

### 7.5 Built-in plugin images

Each built-in plugin is a small Python FastAPI service. Example `heurion/plugin-docx`:

```
packages/server/plugins/docx/
├── Dockerfile
├── pyproject.toml
├── plugin.manifest.json
├── main.py
└── templates/
    └── case_summary.docx
```

`main.py` exposes `/health` and `/v1/tools/invoke`, imports the existing generation logic from `heurion_worker`, and uploads the result to S3.

This structure also serves as the reference implementation for third-party developers.

---

## 8. UI Changes

### 8.1 `plugins.tsx` becomes the Plugin Marketplace

Replace the current Skills-only UI with a unified plugin marketplace:

- **Marketplace tab**: official plugins + community plugins. Cards show icon, name, author, tags, and a short permission summary. Install button opens a consent dialog listing required permissions.
- **Installed tab**: cards show enabled/disabled state, version, and a "Configure" button if the plugin has settings. Actions: Enable / Disable / Uninstall.
- **Developer tab** (Phase 2): install from GitHub URL or upload a manifest zip.

### 8.2 Filters

- Category: Report, Connector, Data Source, Automation, Other.
- Source: Official, Community, Installed.

### 8.3 Marketing page

The existing `sidecar.tsx` marketing page should be updated to avoid the word "Sidecar" and instead market the "Smart Report Assistant" as a set of installable report plugins.

### 8.4 Skills market remains separate

The current `/app/plugins` route currently shows skills. After this refactor, `/app/plugins` shows plugins. The skills marketplace can move to `/app/skills` or keep a sub-tab, but it is backed by the existing `skills.router.ts` unchanged.

---

## 9. Security Model

### 9.1 Permission declaration

Every plugin must declare permissions in its manifest. The UI must surface these clearly before installation.

### 9.2 Tenant isolation

- Plugin containers receive a `TENANT_PREFIX` derived from `userId` (and later `workspaceId`).
- All S3 object keys include this prefix.
- Plugin containers run with no access to the Control Plane database.

### 9.3 Secret management

- S3 credentials and plugin-specific secrets are injected as environment variables when the container starts.
- Secrets are never returned to the frontend or stored in the job payload.
- Plugin-specific settings marked `format: "secret"` are encrypted at rest.

### 9.4 Audit

Every plugin invocation writes a row to `PluginAuditLog` with user, plugin, tool, job id, duration, and status. Error messages must not contain PHI.

---

## 10. Migration Plan

### Phase 1 — Plugin foundation + 5 official plugins + streaming UI

1. Add `PluginCatalog`, `PluginInstallation`, `PluginAuditLog` tables.
2. Create `packages/server-ts/src/modules/plugins/` services and router.
3. Seed official catalog with 5 built-in container plugins.
4. Build 5 plugin container images (`heurion/plugin-docx`, etc.) by extracting logic from `sidecar.py`.
5. Refactor worker to run plugin containers.
6. Refactor chat routing to use plugin triggers.
7. Add SSE reasoning-trace events for intent detection, plugin selection, job status, and file readiness.
8. Refactor `plugins.tsx` into the new marketplace UI.
9. Add backward-compatibility shims for old job types and old `/execution/render` endpoint.

### Phase 2 — Third-party plugins, UI plugins, WASM, and external API

1. **Third-party plugin support**: `heurion-plugin-sdk` Python package, install from GitHub URL / manual upload, community registry API, automated manifest validation.
2. **UI Plugin runtime**: React dynamic loading with Shadow DOM, runtime API, signed bundles, and extension points (panel, toolbar, dashboard card, settings page).
3. **WASM runtime**: Integrate `wasmtime`/`wasmer`, define host function interface, provide Rust/Go SDK, add WASM plugins to catalog.
4. **External API**: OAuth2 client credentials, external app registration, `/external/v1/*` endpoints for catalog, installation, invocation, and job polling.

### Phase 3 — Workspace-level plugins

Once workspace concept is introduced:

1. Add `workspaceId` to `PluginInstallation`.
2. Support workspace-wide mandatory plugins (admin installs for all members).
3. Add workspace-level plugin settings.

### Phase 4 — Deprecation cleanup

1. Remove old `sidecar-chat-handler.ts` hard-coded logic.
2. Remove old job type aliases after clients are migrated.
3. Remove standalone Sidecar marketing page or redirect to plugin marketplace.

---

## 11. UI Plugin / React Dynamic Loading

Plugins should be able to extend the Heurion frontend without requiring a full web-app deployment. Examples:

- A risk-stratification panel on the patient detail page.
- A "summarize thread" button in the chat toolbar.
- A custom dashboard card showing enrollment status.
- A plugin-specific settings page.

### 11.1 Manifest schema

```json
"ui": {
  "bundle_url": "https://cdn.heurion.io/plugins/heurion-risk-panel/dist/index.js",
  "integrity": "sha384-...",
  "extension_points": [
    { "type": "panel", "target": "patient_detail", "id": "risk-panel", "label": "Risk Stratification" },
    { "type": "toolbar_action", "target": "chat", "id": "summarize-thread", "label": "Summarize thread" },
    { "type": "dashboard_card", "id": "enrollment-status", "label": "Enrollment Status" },
    { "type": "settings_page", "id": "my-plugin-settings", "label": "My Plugin Settings" }
  ],
  "permissions": ["read_patient", "read_chat", "call_api"]
}
```

### 11.2 Loading mechanism

1. When a user installs a UI plugin, the web app records its extension points in a client-side `PluginUIRegistry`.
2. When the user navigates to a route that matches a `target`, the app lazy-loads the bundle via `import(bundle_url)` (ESM) or injects a `<script type="module">` tag.
3. The bundle registers itself by calling `HeurionPluginRuntime.register(extensionPointId, factory)`.
4. The app renders the registered component inside a **Shadow DOM** container to isolate CSS.
5. If a plugin fails integrity checks or is from an untrusted source, the app falls back to an iframe sandbox.

### 11.3 Runtime API

The web app exposes a controlled runtime object to the plugin:

```ts
interface HeurionPluginRuntime {
  register: (extensionPointId: string, factory: ComponentFactory) => void;
  api: {
    fetch: (path: string, init?: RequestInit) => Promise<Response>;
  };
  context: {
    userId: string;
    workspaceId?: string;
    patientHash?: string;
    route: string;
  };
  events: {
    on: (event: string, handler: (payload: any) => void) => () => void;
    emit: (event: string, payload: any) => void;
  };
  storage: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
  };
  ui: {
    toast: (message: string, type?: 'info' | 'success' | 'error') => void;
    modal: (config: ModalConfig) => void;
    navigate: (path: string) => void;
  };
}
```

Rules:

- `api.fetch` always attaches the current user's auth token and only allows paths declared in `permissions`.
- `context` is limited to the data the plugin declared it needs.
- `storage` is namespaced by plugin id.
- Plugins cannot access global Redux/Zustand stores directly.

### 11.4 Security

| Mechanism | Description |
|---|---|
| Integrity hash | `ui.integrity` must match the downloaded bundle; otherwise reject. |
| CSP | Plugin scripts must be loaded from an allow-listed CDN or the marketplace's own asset host. |
| Permission consent | UI permissions are shown at install time; users must approve. |
| Shadow DOM | Isolates CSS to prevent style leakage. |
| Iframe fallback | Untrusted or legacy plugins run in a sandboxed iframe with `sandbox="allow-scripts"` and a unique origin. |
| API proxy | All backend calls go through `HeurionPluginRuntime.api.fetch`, which enforces path allow-lists. |

### 11.5 Developer SDK

`heurion-ui-plugin-sdk` (npm) provides:

- TypeScript definitions for `HeurionPluginRuntime`.
- `registerPanel`, `registerToolbarAction`, `registerDashboardCard`, `registerSettingsPage` helpers.
- A build helper that outputs an ESM bundle with React marked as external.
- A local dev server that mocks the runtime API.

---

## 12. WASM Runtime

In addition to containerized plugins, Heurion supports plugins compiled to WebAssembly. WASM plugins start faster, use less memory, and provide strong memory-safety isolation.

### 12.1 Use cases

- Data transformation and validation.
- Lightweight clinical calculators (e.g., BSA, BMI, EGFR, risk scores).
- Rule-based eligibility checks.
- Simple connector logic that only needs HTTP egress.

WASM is **not** suitable for plugins that need heavy native libraries (e.g., `python-docx`, `matplotlib`). Those remain container plugins.

### 12.2 Manifest runtime type

```json
"runtime": {
  "type": "wasm",
  "module": "plugin.wasm",
  "resources": {
    "max_execution_seconds": 30
  }
}
```

### 12.3 Worker integration

The worker uses a WASM runtime such as `wasmtime` (recommended) or `wasmer`.

Plugin module exports:

```wat
(func (export "manifest") (result i32))   ;; returns pointer to JSON string
(func (export "invoke") (param i32 i32 i32) (result i32))  ;; tool, args, context
```

Host functions provided by the worker:

| Host function | Capability |
|---|---|
| `heurion_log(level, message)` | Structured logging |
| `heurion_http_request(method, url, body, headers)` | HTTP egress with allowlist |
| `heurion_storage_upload(name, bytes)` | Upload a generated file |
| `heurion_get_setting(key)` | Read plugin settings |
| `heurion_get_context()` | Read invocation context (user, tenant) |

Invocation flow:

1. Worker resolves job type to a WASM plugin.
2. Loads the module (cached per plugin id).
3. Allocates a WASI context with a tenant-scoped `/tmp` and injected env vars.
4. Calls `invoke(tool_name_json, arguments_json, context_json)`.
5. Parses the returned JSON result and updates job status / file metadata.

### 12.4 Security

- WASI capability model restricts filesystem access to declared paths.
- Network egress is mediated by the host function and filtered by the manifest allowlist.
- CPU and memory limits are enforced by the WASM runtime.
- Modules are validated (signature/whitelist) before loading.

### 12.5 Developer SDK

- `heurion-plugin-sdk-rust` — Rust crate with macros for exports and host function bindings.
- `heurion-plugin-sdk-go` — Go package using TinyGo WASM target.
- Example plugins: `heurion/bsa-calculator`, `heurion/eligibility-check`.

---

## 13. External API / Standalone Marketplace

The Plugin Marketplace can be exposed as a standalone product. Other agents, partner applications, or hospital systems can discover, install, and invoke plugins through a public API.

### 13.1 External application model

| Entity | Description |
|---|---|
| `ExternalApplication` | A registered third-party agent or app. Has `client_id`, `client_secret`, scopes, and quotas. |
| `ExternalUserMapping` | Maps an external app's user id to a Heurion user account (created on first use). |
| `ExternalPluginInstallation` | Which plugins are installed for which `(externalAppId, externalUserId)`. |

### 13.2 Authentication

- **OAuth 2.0 client credentials** for app-level actions (catalog listing, app-wide quotas).
- **Delegated token** for user-scoped actions (install, invoke). The external app requests consent on behalf of the user.
- Optional **mTLS** for high-trust hospital integrations.

Scopes:

| Scope | Allows |
|---|---|
| `marketplace:read` | Browse catalog |
| `plugins:install` | Install/uninstall for a user |
| `plugins:invoke` | Invoke plugin tools |
| `jobs:read` | Poll job status and download files |

### 13.3 External API endpoints

Base path: `/api/external/v1/marketplace`

| Method | Endpoint | Description |
|---|---|---|
| GET | `/catalog` | Browse plugins. Query: `?category=`, `?runtime=`, `?query=` |
| GET | `/catalog/:id` | Plugin details and manifest |
| POST | `/installations` | Install for a user: `{ plugin_id, external_user_id, config? }` |
| GET | `/installations` | List installations for an external app or user |
| POST | `/installations/:id/enable` | Enable plugin |
| POST | `/installations/:id/disable` | Disable plugin |
| DELETE | `/installations/:id` | Uninstall plugin |
| POST | `/invoke` | Invoke a plugin tool synchronously or enqueue a job |
| GET | `/jobs/:id` | Poll job status |
| GET | `/jobs/:id/download` | Get presigned download URL for generated file |

Example invocation request:

```json
POST /api/external/v1/marketplace/invoke
{
  "plugin_id": "heurion/docx",
  "tool": "generate",
  "external_user_id": "hos_user_42",
  "arguments": {
    "template_id": "case_summary",
    "data": { "patient_initials": "ZQ", "diagnosis": "NSCLC" },
    "output_name": "ZQ_Summary"
  },
  "callback_url": "https://hospital-system.io/webhooks/heurion-plugin"
}
```

Response:

```json
{
  "job_id": "job_abc123",
  "status": "pending",
  "poll_url": "/api/external/v1/marketplace/jobs/job_abc123"
}
```

### 13.4 Multi-tenancy and isolation

- Each external app is a tenant.
- Object storage prefix includes `external_apps/{appId}/users/{externalUserId}`.
- Plugin containers/WASM modules receive a tenant context derived from the external app and user.
- Quotas are enforced per external app and per user.

### 13.5 Standalone marketplace web UI

A separate deployable frontend (`marketplace.heurion.io`) allows:

- Browsing the catalog without logging into the Heurion clinical app.
- Developer submission portal.
- Admin review dashboard.
- Plugin analytics (downloads, active installs, ratings).

It reuses the same Control Plane marketplace API but is not tied to the clinical UI.

### 13.6 Billing and metering

- Metering records per external app / user / plugin invocation.
- Quotas: max invocations per minute/hour/day, max concurrent jobs, max file storage.
- Paid plugins are listed in the catalog; actual billing integration is deferred.

---

## 14. Open Questions & Risks

| # | Question / Risk | Mitigation |
|---|---|---|
| 1 | Container cold-start latency (pull + start) for every job | Pre-pull official images on worker startup; consider warm pool later |
| 2 | Third-party image registry auth | Support Docker Hub + private registry credentials configured per deployment |
| 3 | PDF conversion engine choice | Keep `pypandoc` as default in `heurion/plugin-pdf`; allow override via settings |
| 4 | Generic LLM payload builder may produce bad JSON for complex templates | Built-in plugins include `inputExample`; iterate on prompt |
| 5 | Plugin containers need S3 egress | Whitelist internal S3 endpoint in `heurion-plugins` network |
| 6 | Backward compatibility during rollout | Keep old endpoints and job type aliases until Phase 4 |

---

## 15. Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Plugin installation is per-user | Workspace concept not yet introduced; per-user is simplest |
| 2 | Container runtime from day one | Aligns with long-term security model; built-in plugins simply become reference containers |
| 3 | Skills marketplace stays separate | Skills are prompt-based, plugins are runtime-based; unification deferred |
| 4 | Job type convention: `sidecar.<plugin_id>.<tool_name>` | Namespaced, extensible, backwards-compatible with old `sidecar.*` prefix |
| 5 | Plugin container uploads file directly to S3 | Keeps worker stateless; S3 credentials are scoped to plugin runtime |
| 6 | Start container on demand per job | Simplest MVP; warm pool is an optimization for later |
| 7 | UI Plugins use React dynamic loading + Shadow DOM | Heurion is React-based; Shadow DOM isolates styles; iframe fallback for untrusted code |
| 8 | WASM runtime uses `wasmtime` with WASI + host functions | Strong isolation, fast startup, supports Rust/Go/TinyGo |
| 9 | Marketplace exposes external OAuth2 API | Allows other agents and partner systems to use the same plugin ecosystem |
| 10 | Streaming reasoning trace emitted over SSE | Users can see plugin calls and intermediate steps as they happen |

---

## 16. Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `EXECUTION_PLANE_URL` | Control Plane | Base URL of the Python execution plane (e.g. `http://localhost:8000`) |
| `WORKER_API_TOKEN` | Control Plane + Execution Plane | Shared secret for job enqueue/status/download calls |
| `PLUGIN_RUNNER` | Worker | `local` (in-process fallback), `docker` (container), or `auto` (default) |
| `PLUGIN_LOCAL_OUTPUT_DIR` | Worker + plugin handlers | When S3 is unavailable, write rendered files to this directory |
| `PLUGIN_LOCAL_URL_PREFIX` | Worker + Execution Plane | Public URL prefix for locally saved files (e.g. `http://localhost:8000/plugin-outputs`) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Worker + plugin handlers | Object storage configuration for production file outputs |
| `PLUGIN_NETWORK` | Worker (Docker) | Docker network used for plugin containers (default: `heurion-plugins`) |
