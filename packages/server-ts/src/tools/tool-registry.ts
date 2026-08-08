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
import { McpListToolsTool, McpCallToolTool } from './mcp-tools.js'
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

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map()
  /** #107: tool name → current registration version (bumped on replace). */
  private versions: Map<string, number> = new Map()
  private ctx: ToolContext

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
    this.register(new McpListToolsTool())
    this.register(new McpCallToolTool())
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

  get definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
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
    if (!tool) return { success: false, error: `Unknown tool: ${name}` }

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
