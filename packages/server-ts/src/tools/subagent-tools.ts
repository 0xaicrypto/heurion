import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

export class DelegateTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'delegate' }
  get description(): string {
    return 'Delegate a sub-task to a specialized sub-agent. Use this when a request requires a skill you do not have, or when multi-step research/analysis would benefit from parallel exploration. The sub-agent has access to web search, knowledge base, and chat memory.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear description of the task the sub-agent should perform.' },
        context: { type: 'string', description: 'Optional context or background information the sub-agent needs.' },
        skill: { type: 'string', description: 'Optional skill name to constrain the sub-agent (e.g., "literature-review", "clinical-summary").' },
      },
      required: ['task'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = String(args.task || '')
    const context = args.context ? String(args.context) : ''
    if (!task) return { success: false, error: 'task required' }

    const prompt = `You are a helpful sub-agent. Complete the following task concisely.

Task: ${task}
${context ? `Context: ${context}` : ''}

Provide your response.`
    try {
      const { deepseekChat, getApiKey } = await import('../common/llm.js')
      const result = await deepseekChat(
        [{ role: 'user', content: prompt }],
        getApiKey(),
        { model: (await import('../common/llm.js')).DEEPSEEK_CHAT_MODEL, maxTokens: 2048, telemetryContext: { userId: this.ctx.userId, workspaceId: this.ctx.userId, action: 'tool.delegate' } },
      )
      return { success: true, output: result }
    } catch (err: any) {
      return { success: false, error: `Sub-agent failed: ${err.message}` }
    }
  }
}

/**
 * #288: spawn_subagent — the full constrained sub-agent (tools + scope +
 * turn cap + structured result), superseding the plain delegate() call for
 * deep tasks. The main agent folds {summary, turns, cost} into its answer.
 */
export class SpawnSubagentTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'spawn_subagent' }
  get description(): string {
    return 'Spawn a constrained read-only sub-agent to complete a deep task (literature review, focused patient analysis, parallel research). Use for tasks needing multiple tool steps or isolation; do NOT use for simple questions. Returns {summary, turns, cost}. The sub-agent runs only read-only tools, respects a scope (global or patient), and is capped in turns.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, self-contained task description' },
        context: { type: 'string', description: 'Optional background the sub-agent should know' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool white-list (default: read-only research/stat tools)' },
        scope: { type: 'string', description: "'global' or 'patient:<hash>' — default global" },
        max_turns: { type: 'integer', default: 4, description: 'Max tool-loop turns (1-8)' },
      },
      required: ['task'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = String(args.task || '').trim()
    if (!task) return { success: false, error: 'task required' }
    try {
      const { runSubAgent } = await import('./subagent-runner.js')
      const result = await runSubAgent(
        {
          task,
          context: args.context ? String(args.context) : undefined,
          tools: Array.isArray(args.tools) ? (args.tools as string[]).map(String) : undefined,
          scope: args.scope ? String(args.scope) : undefined,
          maxTurns: Number(args.max_turns) || 4,
        },
        this.ctx,
      )
      return {
        success: true,
        output: JSON.stringify({
          summary: result.summary,
          turns: result.turns,
          cost_tokens: result.costTokens,
          tool_calls: result.toolCalls,
        }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `spawn_subagent failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
