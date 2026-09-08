import { BaseTool, ToolDefinition, ToolResult } from './base-tool.js'
import type { SubagentEvent } from '@heurion/contracts'
import { SearchNodeTool, SearchEncounterTool } from './clinical-graph-tools.js'
import { SearchPastChatsTool } from './memory-tools.js'
import { DelegateTool, SpawnSubagentTool } from './subagent-tools.js'
import { DeferToBackgroundTool } from './async-tools.js'
import { OCRImageTool } from './ocr-tools.js'
import { ViewImageTool } from './view-image-tool.js'
import { EditDocumentTool } from './edit-document-tool.js'
import { InsertAssetTool } from './insert-asset-tool.js'
import { FixDocumentImagesTool } from './fix-document-images-tool.js'
import { QueryLogsTool, isUserAdmin } from './query-logs-tool.js'
import { SearchCitationTool } from './search-citation-tool.js'
import { OaPdfLookupTool } from './oa-pdf-tool.js'
import { EditDeckTool } from './edit-deck-tool.js'
import { LoadSkillTool } from './skill-tools.js'
import { RenderChartTool } from './render-chart-tool.js'
import { SearchMedicalWebTool, FetchArticleSummaryTool, VisitMedicalSiteTool, ExtractFulltextTool } from './medical-web-tools.js'
import { SearchOpenAlexTool } from './openalex-search-tool.js'
import { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool, StatPlotTool } from './stat-tools.js'
import { StatAdvisorTool } from './stat-advisor-tool.js'
import { RunStatsAnalysisTool } from './stats-analysis-tool.js'
import { LoadDataTableTool } from './data-table-tool.js'
import { RenderSceneTool } from './bioscene/render-scene-tool.js'
import { BrowserTaskTool } from './browser-agent-tool.js'
import { McpListToolsTool, McpCallToolTool } from './mcp-tools.js'
import { GenerateImageTool } from './generate-image-tool.js'
import type { MemoryService } from '../memory/memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores.js'
import type { EventLog } from '../core/event-log.js'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('tools')

/**
 * #828: registry-level hang backstop — any tool that exceeds its timeout
 * returns a structured error instead of stalling the whole turn. Defaults
 * to 120s (TOOL_TIMEOUT_MS env); long-running tools override either via
 * BaseTool.timeoutMs or the map below (delegate/spawn_subagent make
 * multiple LLM calls; execution-plane renders and doc write-backs involve
 * the worker pipeline).
 */
const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS) || 120_000
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  delegate: 360_000,
  spawn_subagent: 600_000,
  browser_task: 300_000,
  render_scene: 300_000,
  render_chart: 300_000,
  generate_image: 300_000,
  edit_document: 300_000,
  insert_asset: 300_000,
  edit_deck: 300_000,
  fix_document_images: 300_000,
  run_stats_analysis: 300_000,
  ocr_image: 300_000,
}

/** #828: race a tool execution against its timeout / abort signal. */
async function executeWithGuard(
  name: string,
  run: () => Promise<ToolResult>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ToolResult> {
  const signal = opts.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeoutP = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => resolve({
      success: false,
      error: `工具 ${name} 执行超过 ${Math.round(opts.timeoutMs / 1000)}s 被中止（可在重试中让模型换一种做法）`,
    }), opts.timeoutMs)
    timer.unref?.()
  })
  const abortP = signal
    ? new Promise<ToolResult>((resolve) => {
        if (signal.aborted) return resolve({ success: false, error: `Tool ${name} aborted: client disconnected` })
        onAbort = () => resolve({ success: false, error: `Tool ${name} aborted: client disconnected` })
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null
  try {
    // Promise.race attaches handlers to every participant up front, so a
    // late rejection after the timeout resolved is safely dropped.
    return await Promise.race([run(), ...(abortP ? [abortP] : []), timeoutP])
  } finally {
    cleanup()
  }

  function cleanup() {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * #766: execution-plane port (structural — tools stay decoupled from
 * modules/). conversation-turn provides createExecutionPlaneService().
 */
export interface ToolExecutionPlane {
  enqueue(job: { type: string; payload: Record<string, unknown>; tenant?: { userId?: string; workspaceId?: string } }): Promise<{ job_id: string; status: string }>
  getStatus(jobId: string): Promise<{ job_id: string; status: string; error?: unknown; result?: Record<string, unknown> } | null>
  fetchFile?(fileId: string): Promise<Buffer | null>
}

export interface ToolContext {
  userId: string
  memory: MemoryService
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
  eventLog: EventLog
  /** Current session id — write tools (edit_document) derive doc-{docId}. */
  sessionId?: string
  /**
   * #666: plugin availability port — provided by the modules layer
   * (conversation-turn), keeps `tools/` free of `modules/*` imports.
   * Absent port ⇒ gated tools are treated as unavailable.
   */
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
  /**
   * #766: execution-plane port for insert_asset plot rendering
   * (enqueue → poll → fetchFile → chart-token 落盘). Absent ⇒ plot branch
   * degrades to a readable error.
   */
  executionPlane?: ToolExecutionPlane
  /**
   * #666: plugin config port (browser-agent worker url/token/approval) —
   * same layering rationale; absent port ⇒ defaults are used.
   */
  getPluginConfig?: (pluginId: string) => Promise<Record<string, unknown>>
  /**
   * #828: turn abort signal (client disconnect / stop / watchdog) — tools
   * and sub-agents observe it so a dead client stops burning tokens.
   * Absent ⇒ tools run to completion as before.
   */
  signal?: AbortSignal
  /**
   * #831: sub-agent visibility port — spawn_subagent/deep-analysis report
   * started/progress/done through it (typed SubagentEvent from contracts).
   * Absent ⇒ sub-agents run silently (old behavior).
   */
  emitSubagentEvent?: (ev: SubagentEvent) => void
  /**
   * #866-868: 编辑定位提示 — rangeEdit 焦点优先匹配用。conversation-turn
   * 在上下文组装期间回填(组装期写、工具执行期读的 holder),工具层保持
   * 对 modules 层无依赖。Absent ⇒ 全文匹配(旧行为)。
   */
  editHint?: EditHint
}

/** #866-868: 焦点段/选中文本定位提示。 */
export interface EditHint {
  /** 当前焦点段原文(#866 分段内容,未截断版) — rangeEdit 先在段内匹配。 */
  focusSectionContent?: string | null
  focusIndex?: number | null
  focusTitle?: string | null
  /** 用户选中文本(#693) — 比焦点段更具体,匹配优先级最高。 */
  selectionText?: string | null
}

/**
 * #454-followup: tools whose availability is gated by an installable plugin.
 * The renderer implementation stays in-process (zero latency), but the tool
 * only appears in the LLM's tool list while the user has the plugin
 * installed + enabled — everything else (marketplace, uninstall cascade,
 * audit) is the standard plugin lifecycle.
 */
export const PLUGIN_GATED_TOOLS: Record<string, string> = {
  render_chart: 'heurion/chart',
  render_scene: 'heurion/bioscene',
  browser_task: 'heurion/browser-agent',
}

/**
 * #510: per-scene tool surface. Patient-retrieval tools are omitted from
 * non-patient scenes so the model does not search patient records for
 * general/chart/document requests. 'patient' keeps the full surface
 * (backwards compatible with the pre-#510 behavior).
 */
const PATIENT_RETRIEVAL_TOOLS = new Set(['search_node', 'search_encounter', 'search_past_chats'])
export const SCENE_OMIT_TOOLS: Record<string, Set<string>> = {
  general: PATIENT_RETRIEVAL_TOOLS,
  document: PATIENT_RETRIEVAL_TOOLS,
  chart: PATIENT_RETRIEVAL_TOOLS,
}

/**
 * #829: side-effect-free tools — the tool loop may run these in parallel
 * within one model round (they only read external state). Everything else
 * (write-backs, sends, renders that enqueue jobs, sub-agents, background
 * deferrals) stays serial to preserve ordering-sensitive flows.
 */
export const READ_ONLY_TOOLS = new Set([
  'search_node',
  'search_encounter',
  'search_past_chats',
  'search_medical_web',
  'fetch_article_summary',
  'visit_medical_site',
  'extract_fulltext',
  'search_citation',
  'load_data_table',
  'load_skill',
  'query_logs',
  'mcp_list_tools',
  'stat_describe',
  'stat_ttest',
  'stat_chisq',
  'stat_km',
  'stat_plot',
  'stat_ai',
])

/**
 * #835: 尽最大努力检索(best-effort retrieval)策略集 — 这些只读检索工具的
 * 失败不应阻断回合:连续失败 ≥2 次后从后续轮次的 tools 列表移除(模型物理
 * 上无法再重试),配合注入的错误指引,让模型基于已有上下文/自身知识继续
 * 完成任务,而不是烧完 5 轮后空手而归。写回/渲染/子代理工具绝不入集。
 */
export const BEST_EFFORT_RETRIEVAL_TOOLS = new Set([
  'search_node',
  'search_encounter',
  'search_past_chats',
  'search_medical_web',
  'fetch_article_summary',
  'visit_medical_site',
  'extract_fulltext',
  'search_citation',
  'load_data_table',
])

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map()
  /** #107: tool name → current registration version (bumped on replace). */
  private versions: Map<string, number> = new Map()
  private ctx: ToolContext
  /** Cached plugin availability per user (per registry instance = per turn). */
  private gatedAvailability: Record<string, boolean | undefined> = {}

  constructor(ctx: ToolContext) {
    this.ctx = ctx
    this.register(new SearchNodeTool(ctx))
    this.register(new SearchEncounterTool(ctx))
    this.register(new SearchPastChatsTool(ctx))
    this.register(new DelegateTool(ctx))
    this.register(new SpawnSubagentTool(ctx))
    this.register(new DeferToBackgroundTool(ctx))
    this.register(new OCRImageTool(ctx))
    // #fix 2026-09: view_image — 文档内嵌图/截图的按需视觉理解(方案 A)。
    this.register(new ViewImageTool(ctx))
    this.register(new EditDocumentTool(ctx))
    // #765: 写作画布结构化资产工具（表格）— 与 edit_document 同管道
    // （快照 + doc_updated），仅 doc- 会话暴露。
    this.register(new InsertAssetTool(ctx))
    // #773: deck 资产 AI 编辑工具 — 仅 doc- 会话暴露（与 edit_document 同门控）。
    this.register(new EditDeckTool(ctx))
    // #fix 2026-09: 图片链接先审计后修复 — 仅 doc- 会话暴露（与 edit_document 同门控）。
    this.register(new FixDocumentImagesTool(ctx))
    // #801: AI 日志检索 — 排障一等能力,仅 admin 用户暴露。
    this.register(new QueryLogsTool(ctx))
    // #807: 引用实体化 — PubMed 真实检索,治 References 编造。
    this.register(new SearchCitationTool(ctx))    // #454-followup: plugin-gated renderers — registered so execute() can
    // #837: OA 全文获取 — Unpaywall + Crossref combo(阅读全文,非引用编造治理)。
    this.register(new OaPdfLookupTool(ctx))
    // give a clear error, but excluded from definitions unless installed.
    this.register(new RenderChartTool(ctx))
    this.register(new LoadSkillTool(ctx))
    this.register(new SearchMedicalWebTool(ctx))
    this.register(new FetchArticleSummaryTool(ctx))
    this.register(new VisitMedicalSiteTool(ctx))
    this.register(new ExtractFulltextTool(ctx))
    // 方案2: OpenAlex 学术检索 — PubMed 之外的第二路(全文索引/引文量/OA 状态)。
    this.register(new SearchOpenAlexTool(ctx))
    this.register(new StatDescribeTool())
    this.register(new StatTTestTool())
    this.register(new StatChiSqTool())
    this.register(new StatKmTool())
    this.register(new StatPlotTool())
    this.register(new StatAdvisorTool())
    this.register(new RunStatsAnalysisTool())
    this.register(new LoadDataTableTool(ctx))
    this.register(new RenderSceneTool(ctx))
    this.register(new BrowserTaskTool(ctx))
    this.register(new McpListToolsTool())
    this.register(new McpCallToolTool())
    this.register(new GenerateImageTool(ctx))
  }

  /** Is a plugin-gated tool available to this user right now? */
  async isToolAvailable(name: string): Promise<boolean> {
    const pluginId = PLUGIN_GATED_TOOLS[name]
    if (!pluginId) return true
    if (this.gatedAvailability[name] !== undefined) return this.gatedAvailability[name]!
    const port = this.ctx.isPluginInstalled
    let available = false
    if (port) {
      try {
        available = await port(pluginId)
      } catch {
        available = false
      }
    }
    this.gatedAvailability[name] = available
    return available
  }

  /**
   * #454-followup: definitions for THIS user — plugin-gated tools are
   * omitted while the owning plugin is not installed/enabled. Async because
   * availability is read from the installation store.
   * #510: scene-scoped omissions (patient retrieval in non-patient scenes).
   * #580 (TURN_INTENT_DESIGN §8-4): edit_document is exposed ONLY inside a
   * document-writing session (sessionId prefix "doc-"); a non-doc / unknown
   * session must not present a write-back tool the runtime would refuse.
   */
  async getDefinitionsForUser(scene: string = 'patient', sessionId?: string): Promise<ToolDefinition[]> {
    const omit = SCENE_OMIT_TOOLS[scene]
    const isDocSession = Boolean(sessionId?.startsWith('doc-'))
    const out: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (tool.name === 'edit_document' && !isDocSession) continue
      if (tool.name === 'insert_asset' && !isDocSession) continue
      if (tool.name === 'edit_deck' && !isDocSession) continue
      if (tool.name === 'fix_document_images' && !isDocSession) continue
      if (tool.name === 'query_logs' && !(await isUserAdmin(this.ctx.userId))) continue
      if (PLUGIN_GATED_TOOLS[tool.name] && !(await this.isToolAvailable(tool.name))) continue
      if (omit?.has(tool.name)) continue
      out.push(tool.definition)
    }
    return out
  }

  /**
   * Register a tool. Re-registering the same name bumps its version —
   * callers that captured an old instance get a clear 'stale' error (#107).
   */
  register(tool: BaseTool): void {
    const existing = this.tools.get(tool.name)
    const nextVersion = existing ? (this.versions.get(tool.name) ?? 1) + 1 : 1
    this.tools.set(tool.name, tool)
    this.versions.set(tool.name, nextVersion)
  }

  /** #107: the version a tool instance was registered at (1 = first). */
  versionOf(name: string): number {
    return this.versions.get(name) ?? 0
  }

  /** Legacy synchronous view (all tools, un-gated) — test/internal use. */
  get definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name)
  }

  /**
   * Execute a tool. When the caller passes the version of a previously
   * captured definition and the tool has been replaced since, return a
   * stale-tool error instead of silently running the new definition (#107).
   */
  async execute(name: string, args: Record<string, unknown>, expectedVersion?: number): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { success: false, error: `Unknown tool: ${name}` }
    if (expectedVersion !== undefined && this.versions.get(name) !== expectedVersion) {
      return {
        success: false,
        error: `Stale tool call: ${name} was updated, retry with the current definition`,
      }
    }

    // #454-followup: plugin-gated renderers must not run without the plugin.
    const gatePlugin = PLUGIN_GATED_TOOLS[name]
    if (gatePlugin && !(await this.isToolAvailable(name))) {
      return {
        success: false,
        error: `工具 ${name} 需要安装插件「${gatePlugin}」才能使用。请到「插件市场」安装后重试。`,
      }
    }

    // §3.3: a throwing tool must never take down the whole chat turn —
    // surface the failure to the LLM so it can switch strategy.
    // #828: hang backstop — per-tool timeout (BaseTool.timeoutMs → override
    // map → TOOL_TIMEOUT_MS env → 120s) + turn abort awareness.
    let result: ToolResult
    try {
      const timeoutMs = tool.timeoutMs ?? TOOL_TIMEOUT_OVERRIDES[name] ?? DEFAULT_TOOL_TIMEOUT_MS
      result = await executeWithGuard(name, () => tool.execute(this.sanitizeArgs(tool, args)), {
        timeoutMs,
        signal: this.ctx.signal,
      })
    } catch (err) {
      return { success: false, error: `Tool ${name} failed: ${(err as Error).message.slice(0, 300)}` }
    }

    // T1: bound large outputs uniformly — every tool result that goes back
    // into the LLM round passes through the limiter.
    // #693: edit_document 豁免 — 其 output 是承载完整 body 的结构化 JSON,
    // 截断会破坏 doc_updated SSE 的 JSON 解析(大文档写回后画布不更新)。
    // 防上下文膨胀改由 tool-loop 注入时截断(tool-loop.ts 的 messages push)。
    // #765: insert_asset 同理 — 表格写回同样携带完整 body。
    // #773: edit_deck 同理 — deck JSON 随输出返回（doc_updated SSE 需要）。
    if (result.success && result.output && name !== 'edit_document' && name !== 'insert_asset' && name !== 'edit_deck') {
      try {
        const { boundToolOutput } = await import('./tool-output-store.js')
        const { bounded, truncated, filePath } = boundToolOutput(result.output, { userId: this.ctx.userId })
        if (truncated) {
          result.output = bounded
          result.truncated = true
          result.fullOutputPath = filePath
          // Opportunistic retention sweep on the way out.
          const { cleanupToolOutputs } = await import('./tool-output-store.js')
          cleanupToolOutputs()
        }
      } catch (err) {
        log.info('[TOOLS] Output bounding skipped:', (err as Error).message.slice(0, 100))
      }
    }
    return result
  }

  /**
   * §3.3: coerce numeric params passed as strings; non-numeric values
   * become `undefined` so tools fall back to their defaults (no NaN).
   */
  private sanitizeArgs(tool: BaseTool, args: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...args }
    for (const key of ['top_k', 'topK', 'maxResults', 'limit', 'k']) {
      if (key in sanitized && typeof sanitized[key] !== 'number') {
        const n = Number(sanitized[key])
        sanitized[key] = Number.isFinite(n) ? n : undefined
      }
    }
    return sanitized
  }
}
