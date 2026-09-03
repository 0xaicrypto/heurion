import { resolveTierModel } from '../common/llm-gateway.js'
/**
 * #288: SubAgentRunner — a constrained, read-only sub-agent loop.
 * Synchronous strategy A: run(task) → { summary, cost, turns }. The sub
 * agent gets a white-listed tool set, an optional scope (patient/global)
 * that is forced onto patient-scoped tools, a turn cap and an output cap.
 * The result is a structured summary the main agent folds into its answer.
 *
 * #831: progress hooks — every turn/tool step is reported through the
 * ctx.emitSubagentEvent port so the UI can show live sub-agent activity.
 * #830: batch fan-out lives in SpawnSubagentTool; this runner stays
 * single-task (one id per run).
 */
import { deepseekChat, getApiKey} from '../common/llm.js'
import { ToolRegistry, type ToolContext } from './tool-registry.js'

export interface SubAgentInput {
  task: string
  context?: string
  /** Tool white-list (names). Read-only defaults when omitted. */
  tools?: string[]
  /** Scope: 'global' or 'patient:<hash>' — forced onto patient tools. */
  scope?: string
  maxTurns?: number
  /**
   * #831: visibility id for the ctx.emitSubagentEvent port. Absent ⇒
   * no progress events.
   */
  id?: string
}

export interface SubAgentResult {
  summary: string
  turns: number
  costTokens: number
  toolCalls: number
}

const DEFAULT_TOOLS = [
  'search_node', 'search_encounter', 'search_medical_web', 'fetch_article_summary',
  'stat_describe', 'stat_ttest', 'stat_chisq', 'stat_km', 'load_skill',
]

/** #510-followup: 患者检索工具仅在患者场景可用 — 通用场景(global)的
 *  深度分析子代理不得检索患者数据(与主 chat 的场景化工具裁剪一致)。 */
const PATIENT_SCOPED_TOOLS = new Set(['search_node', 'search_encounter', 'search_past_chats'])

export async function runSubAgent(input: SubAgentInput, ctx: ToolContext): Promise<SubAgentResult> {
  const maxTurns = Math.min(8, Math.max(1, input.maxTurns || 4))
  const scope = input.scope || 'global'
  const isPatientScope = scope.startsWith('patient:')
  const requested = input.tools && input.tools.length > 0 ? input.tools : DEFAULT_TOOLS
  const toolNames = isPatientScope ? requested : requested.filter((t) => !PATIENT_SCOPED_TOOLS.has(t))

  // #831: progress emitter — silent when no id/port (tests, background runs).
  const startedAt = Date.now()
  const emit = ctx.emitSubagentEvent
  const report = (phase: 'thinking' | 'tool' | 'summarizing', extra: { current_tool?: string; tool_args_preview?: string } = {}) => {
    if (!input.id || !emit) return
    emit({
      type: 'subagent_progress',
      id: input.id,
      task: input.task.slice(0, 200),
      phase,
      turn: Math.min(turns + 1, maxTurns),
      max_turns: maxTurns,
      elapsed_ms: Date.now() - startedAt,
      ...extra,
    })
  }
  let turns = 0

  // Read-only by default: every allowed tool must pass the white-list.
  const registry = new ToolRegistry(ctx)
  const allowed = toolNames.filter((n) => registry.get(n))

  const scopeNote = isPatientScope
    ? `You are LIMITED to the patient ${scope.slice('patient:'.length)} — never mention or use data from other patients.`
    : 'You may use global (user-level) knowledge only.'

  const system = `You are a focused sub-agent of the Heurion clinical assistant.
${scopeNote}
Available tools: ${allowed.join(', ') || 'none (answer from your own knowledge)'}.
Rules:
- Run ONLY read-only tools. Never modify data.
- When a tool returns results, incorporate them and stop unless more investigation is needed.
- Answer concisely with the findings; note gaps as "not found".
- Output must end with a line: SUBAGENT_SUMMARY: <your final summary>`

  let messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `${system}\n\nTask: ${input.task}${input.context ? `\n\nContext:\n${input.context.slice(0, 3000)}` : ''}` },
  ]
  let toolCalls = 0
  let costTokens = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    // #828: stop burning tokens when the client is gone.
    if (ctx.signal?.aborted) throw new Error('Sub-agent aborted: client disconnected')
    report('thinking')
    const result = await deepseekChat(messages, getApiKey(), {
      model: resolveTierModel('fast'),
      maxTokens: 1200,
      signal: ctx.signal,
      telemetryContext: { userId: ctx.userId, workspaceId: ctx.userId, action: 'subagent.turn' },
    })
    costTokens += estimate(result)
    turns = turn + 1

    const calls = Array.from(result.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g))
    if (calls.length === 0) {
      report('summarizing')
      const summary = result.trim()
      const marker = summary.match(/SUBAGENT_SUMMARY:\s*([\s\S]*)$/i)
      return {
        summary: (marker ? marker[1] : summary).trim().slice(0, 3000),
        turns,
        costTokens,
        toolCalls,
      }
    }

    // Execute tool calls in order; failures are recorded, not fatal.
    // #828: registry now owns the per-tool timeout/abort guard.
    const toolResults: string[] = []
    for (const m of calls) {
      if (ctx.signal?.aborted) throw new Error('Sub-agent aborted: client disconnected')
      try {
        const call = JSON.parse(m[1].trim()) as { name: string; arguments: Record<string, unknown> }
        if (!allowed.includes(call.name)) {
          toolResults.push(`Tool ${call.name} is not allowed for this sub-agent`)
          continue
        }
        toolCalls++
        // Scope enforcement: force patient_hash on patient tools.
        const args = { ...(call.arguments || {}) }
        if (scope.startsWith('patient:') && call.name !== 'search_medical_web') {
          args.patient_hash = scope.slice('patient:'.length)
        }
        report('tool', {
          current_tool: call.name,
          tool_args_preview: String(JSON.stringify(args) || '').slice(0, 120),
        })
        const out = await registry.execute(call.name, args)
        toolResults.push(`[${call.name}] ${out.success ? (out.output || 'ok').slice(0, 1500) : `ERROR: ${out.error}`}`)
      } catch (err) {
        toolResults.push(`[tool] ${(err as Error).message.slice(0, 200)}`)
      }
    }
    messages.push({ role: 'assistant', content: result })
    messages.push({ role: 'user', content: `Tool results:\n${toolResults.join('\n')}` })
  }

  // Turn cap reached without a final summary — wrap up from the last state.
  return {
    summary: `(reached ${maxTurns}-turn cap)`,
    turns,
    costTokens,
    toolCalls,
  }
}

function estimate(text: string): number {
  return Math.ceil(text.length / 4)
}
