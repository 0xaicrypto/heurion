import { resolveTierModel } from '../common/llm-gateway.js'
import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import type { SubagentEvent } from '@heurion/contracts'

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
        { model: resolveTierModel('fast'), maxTokens: 2048, signal: this.ctx.signal, telemetryContext: { userId: this.ctx.userId, workspaceId: this.ctx.userId, action: 'tool.delegate' } },
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
 *
 * #830: batch fan-out — `tasks` runs N sub-agents with a concurrency cap
 * (SUBAGENT_CONCURRENCY env, default 3); each sub-agent is failure-isolated
 * and reported with its own visibility id.
 * #831: started/progress/done flow through the ctx.emitSubagentEvent port
 * (silent when the port is absent).
 */
export class SpawnSubagentTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'spawn_subagent' }
  get description(): string {
    return 'Spawn constrained read-only sub-agent(s) to complete deep task(s) (literature review, focused patient analysis, parallel research). Use for tasks needing multiple tool steps or isolation; do NOT use for simple questions. Pass `tasks` (array) to run several IN PARALLEL — e.g. one per research angle. Returns {summary, turns, cost} for a single task or {results:[...], ok_count, failed_count} for a batch.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Single task mode: clear, self-contained task description' },
        context: { type: 'string', description: 'Optional background the sub-agent should know' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool white-list (default: read-only research/stat tools)' },
        scope: { type: 'string', description: "'global' or 'patient:<hash>' — default global" },
        max_turns: { type: 'integer', default: 4, description: 'Max tool-loop turns (1-8)' },
        tasks: {
          type: 'array',
          description: 'Batch mode: run several sub-agents in parallel (concurrency-capped). Each item is self-contained.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Self-contained task description' },
              tools: { type: 'array', items: { type: 'string' } },
              scope: { type: 'string' },
              max_turns: { type: 'integer' },
              context: { type: 'string' },
            },
            required: ['task'],
          },
        },
      },
    }
  }

  /** #831: one visibility id per sub-agent run. */
  private emit(ev: SubagentEvent): void {
    try { this.ctx.emitSubagentEvent?.(ev) } catch { /* visibility is best-effort */ }
  }

  private async runOne(
    item: { task: string; tools?: string[]; scope?: string; max_turns?: number; context?: string },
    id: string,
  ): Promise<{ success: boolean; summary: string; turns: number; cost_tokens: number; tool_calls: number; error?: string }> {
    const task = String(item.task || '').trim()
    if (!task) return { success: false, summary: '', turns: 0, cost_tokens: 0, tool_calls: 0, error: 'task required' }
    this.emit({ type: 'subagent_started', id, task: task.slice(0, 200), scope: item.scope || 'global' })
    try {
      const { runSubAgent } = await import('./subagent-runner.js')
      const result = await runSubAgent(
        {
          task,
          id,
          context: item.context ? String(item.context) : undefined,
          tools: Array.isArray(item.tools) ? (item.tools as string[]).map(String) : undefined,
          scope: item.scope ? String(item.scope) : undefined,
          maxTurns: Number(item.max_turns) || 4,
        },
        this.ctx,
      )
      this.emit({
        type: 'subagent_done', id, task: task.slice(0, 200), success: true,
        cost_tokens: result.costTokens, turns: result.turns, tool_calls: result.toolCalls,
        summary_preview: result.summary.slice(0, 200),
      })
      // #831-持久化: 摘要落事件日志 — 刷新后可从 history 重建，不再黑盒蒸发。
      try {
        this.ctx.eventLog.append({
          timestamp: Date.now() / 1000,
          eventType: 'subagent_result',
          content: result.summary.slice(0, 3000),
          metadata: {
            id, task: task.slice(0, 200), scope: item.scope || 'global', success: true,
            turns: result.turns, costTokens: result.costTokens, toolCalls: result.toolCalls,
          },
          agentId: this.ctx.userId,
          sessionId: this.ctx.sessionId || '',
        })
      } catch { /* persistence is best-effort */ }
      return { success: true, summary: result.summary, turns: result.turns, cost_tokens: result.costTokens, tool_calls: result.toolCalls }
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200)
      // 失败详情走 tool_result 事件（tool-loop 投影），这里只报状态。
      this.emit({ type: 'subagent_done', id, task: task.slice(0, 200), success: false })
      return { success: false, summary: `FAILED: ${msg}`, turns: 0, cost_tokens: 0, tool_calls: 0, error: msg }
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rawTasks = args.tasks
    if (Array.isArray(rawTasks) && rawTasks.length > 0) {
      // #830: batch fan-out with a concurrency cap — wall time ≈ slowest
      // sub-agent instead of the sum; 429 storms are capped by the pool.
      const items = (rawTasks as Array<Record<string, unknown>>).map((t) => ({
        task: String(t?.task || ''),
        tools: Array.isArray(t?.tools) ? (t!.tools as string[]).map(String) : undefined,
        scope: t?.scope ? String(t.scope) : undefined,
        max_turns: Number(t?.max_turns) || undefined,
        context: t?.context ? String(t.context) : undefined,
      }))
      const concurrency = Math.max(1, Math.min(6, Number(process.env.SUBAGENT_CONCURRENCY) || 3))
      const results = await runPool(items, concurrency, (item, idx) =>
        this.runOne(item, `sub_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`),
      )
      const okCount = results.filter((r) => r.success).length
      return {
        success: okCount > 0,
        output: JSON.stringify({
          results: results.map((r, idx) => ({
            task: items[idx].task.slice(0, 200),
            success: r.success,
            summary: r.summary,
            turns: r.turns,
            cost_tokens: r.cost_tokens,
            tool_calls: r.tool_calls,
            ...(r.error ? { error: r.error } : {}),
          })),
          ok_count: okCount,
          failed_count: results.length - okCount,
        }, null, 2),
      }
    }

    // Single-task mode (back-compat shape for the model).
    const res = await this.runOne({
      task: String(args.task || ''),
      tools: Array.isArray(args.tools) ? (args.tools as string[]).map(String) : undefined,
      scope: args.scope ? String(args.scope) : undefined,
      max_turns: Number(args.max_turns) || undefined,
      context: args.context ? String(args.context) : undefined,
    }, `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    return {
      success: res.success,
      output: JSON.stringify({
        summary: res.summary,
        turns: res.turns,
        cost_tokens: res.cost_tokens,
        tool_calls: res.tool_calls,
      }, null, 2),
    }
  }
}

/** #830: fixed-size worker pool preserving result order. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}
