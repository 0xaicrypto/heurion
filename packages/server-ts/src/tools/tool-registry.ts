import { BaseTool, ToolDefinition, ToolResult } from './base-tool.js'
import { SearchNodeTool, SearchEncounterTool } from './clinical-graph-tools.js'
import { ReadCalendarTool, ComposeEmailDraftTool, SendEmailNowTool } from './calendar-tools.js'
import { SearchPastChatsTool } from './memory-tools.js'
import { DelegateTool, SpawnSubagentTool } from './subagent-tools.js'
import { DeferToBackgroundTool } from './async-tools.js'
import { OCRImageTool } from './ocr-tools.js'
import { EditDocumentTool } from './edit-document-tool.js'
import { LoadSkillTool } from './skill-tools.js'
import { RenderChartTool } from './render-chart-tool.js'
import { SearchMedicalWebTool, FetchArticleSummaryTool, VisitMedicalSiteTool, ExtractFulltextTool } from './medical-web-tools.js'
import { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool, StatPlotTool, StatAdvisorTool } from './stat-tools.js'
import { RunStatsAnalysisTool } from './stats-analysis-tool.js'
import { LoadDataTableTool } from './data-table-tool.js'
import { RenderSceneTool } from './bioscene/render-scene-tool.js'
import { BrowserTaskTool } from './browser-agent-tool.js'
import { McpListToolsTool, McpCallToolTool } from './mcp-tools.js'
import { GenerateImageTool } from './generate-image-tool.js'
import type { MemoryService } from '../memory/memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores.js'
import type { EventLog } from '../core/event-log.js'

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
    this.register(new EditDocumentTool(ctx))
    // #454-followup: plugin-gated renderers — registered so execute() can
    // give a clear error, but excluded from definitions unless installed.
    this.register(new RenderChartTool(ctx))
    this.register(new LoadSkillTool(ctx))
    this.register(new SearchMedicalWebTool(ctx))
    this.register(new FetchArticleSummaryTool(ctx))
    this.register(new VisitMedicalSiteTool(ctx))
    this.register(new ExtractFulltextTool(ctx))
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
    let available = false
    try {
      const { listInstalledPlugins } = await import('../modules/plugins/plugin-installation.service.js')
      const installed = await listInstalledPlugins(this.ctx.userId)
      available = installed.some((i) => i.pluginId === pluginId && i.enabled)
    } catch {
      available = false
    }
    this.gatedAvailability[name] = available
    return available
  }

  /**
   * #454-followup: definitions for THIS user — plugin-gated tools are
   * omitted while the owning plugin is not installed/enabled. Async because
   * availability is read from the installation store.
   * #510: scene-scoped omissions (patient retrieval in non-patient scenes).
   */
  async getDefinitionsForUser(scene: string = 'patient'): Promise<ToolDefinition[]> {
    const omit = SCENE_OMIT_TOOLS[scene]
    const out: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
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
    let result: ToolResult
    try {
      result = await tool.execute(this.sanitizeArgs(tool, args))
    } catch (err) {
      return { success: false, error: `Tool ${name} failed: ${(err as Error).message.slice(0, 300)}` }
    }

    // T1: bound large outputs uniformly — every tool result that goes back
    // into the LLM round passes through the limiter.
    if (result.success && result.output) {
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
        console.log('[TOOLS] Output bounding skipped:', (err as Error).message.slice(0, 100))
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
