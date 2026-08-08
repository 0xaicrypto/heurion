import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

export class DeferToBackgroundTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'defer_to_background' }
  get description(): string {
    return 'Defer a non-urgent task to background processing. Use this when the user asks for something that will take significant time (research, batch processing, long document analysis). The result will be available in a future conversation turn.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task to process in background.' },
        input_data: { type: 'string', description: 'Input data for the task.' },
        task_type: { type: 'string', description: 'Type: research / analyze / summarize / batch', enum: ['research', 'analyze', 'summarize', 'batch'] },
      },
      required: ['task', 'task_type'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = String(args.task || '')
    const inputData = args.input_data ? String(args.input_data) : ''
    const taskType = String(args.task_type || 'analyze')

    this.ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'background_task',
      content: `Background task: ${task}`,
      metadata: { task, inputData, taskType },
      agentId: this.ctx.userId,
      sessionId: 'background',
    })

    ;(async () => {
      try {
        const { deepseekChat, getApiKey } = await import('../common/llm.js')
        const prompt = `Process this background task. Type: ${taskType}\n\nTask: ${task}\n${inputData ? `Data: ${inputData}` : ''}`
        const result = await deepseekChat(
          [{ role: 'user', content: prompt }],
          getApiKey(),
          { model: (await import('../common/llm.js')).DEEPSEEK_CHAT_MODEL, maxTokens: 4096, telemetryContext: { userId: this.ctx.userId, workspaceId: this.ctx.userId, action: 'tool.background' } },
        )
        this.ctx.eventLog.append({
          timestamp: Date.now() / 1000,
          eventType: 'background_result',
          content: result.slice(0, 500),
          metadata: { task, result },
          agentId: this.ctx.userId,
          sessionId: 'background',
        })
      } catch (err: any) {
        console.log('[BACKGROUND] Task failed:', err.message)
      }
    })()

    return {
      success: true,
      output: `Background task "${task}" has been queued. The result will be available in a future conversation. You can continue helping the user without waiting.`,
    }
  }
}
