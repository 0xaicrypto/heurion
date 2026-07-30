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
        { model: 'deepseek-chat', maxTokens: 2048, telemetryContext: { userId: this.ctx.userId, workspaceId: this.ctx.userId, action: 'tool.delegate' } },
      )
      return { success: true, output: result }
    } catch (err: any) {
      return { success: false, error: `Sub-agent failed: ${err.message}` }
    }
  }
}
