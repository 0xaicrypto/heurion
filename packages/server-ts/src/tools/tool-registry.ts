import { BaseTool, ToolDefinition, ToolResult } from './base-tool.js'
import { SearchNodeTool, SearchEncounterTool } from './clinical-graph-tools.js'
import { ReadCalendarTool, ComposeEmailDraftTool, SendEmailNowTool } from './calendar-tools.js'
import { SearchPastChatsTool } from './memory-tools.js'
import { DelegateTool } from './subagent-tools.js'
import { DeferToBackgroundTool } from './async-tools.js'
import { OCRImageTool } from './ocr-tools.js'
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
}

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map()

  constructor(ctx: ToolContext) {
    this.register(new SearchNodeTool(ctx))
    this.register(new SearchEncounterTool(ctx))
    this.register(new SearchPastChatsTool(ctx))
    this.register(new DelegateTool(ctx))
    this.register(new DeferToBackgroundTool(ctx))
    this.register(new OCRImageTool(ctx))
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool)
  }

  get definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name)
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { success: false, error: `Unknown tool: ${name}` }
    return tool.execute(args)
  }
}
