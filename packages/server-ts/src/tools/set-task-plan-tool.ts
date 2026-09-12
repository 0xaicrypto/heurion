import { BaseTool, ToolResult } from './base-tool.js'
import {
  createPlan,
  advanceStep,
  failStep,
  retryStep,
  skipStep,
  completePlan,
  cancelPlan,
  planBacklog,
} from '../common/plan-store.js'
import type { TaskPlan, PlanUpdatedEvent } from '@heurion/contracts'

/**
 * #976 — set_task_plan: 会话级任务清单工具（agent todo-list 模式）。
 *
 * 三道闸门（用户约束：简单问题必须简化，不得建清单）：
 * 1. 步数硬闸 — create 时 steps < 3 直接拒绝（简单任务请直接执行对应工具）。
 * 2. 清单是执行的账本不是前置确认 — create 成功即返回「立即开始第一项」。
 * 3. 反编造 — steps[].tool 标注的写回步骤由系统在工具执行成功时自动推进
 *    （tool-loop finishCall 联动），模型手动 advance 写回步骤会被拒绝。
 *
 * 步骤状态：pending | done | failed | skipped（+ retry_count ≤ 2）。
 * 失败不阻塞：可显式 skip 继续后续步骤；收口（complete）在有 pending/failed
 * 时拒绝 — 诚实收口。
 */
export class SetTaskPlanTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'set_task_plan' }

  get description(): string {
    return [
      'Create and maintain a structured task plan (todo list) for the CURRENT session when a complex task decomposes into ≥3 independent steps.',
      "Actions: 'create' (title + steps[{title, tool?, note?}]) — HARD RULE: fewer than 3 steps is REJECTED; simple tasks (1-2 steps) must execute the corresponding tool directly instead of creating a plan. Do NOT pause for confirmation after creating — start the first step immediately in the same turn.",
      "'advance' (step_index, note?) marks an ANALYSIS/reporting step done — steps whose tool is edit_document/edit_deck/insert_asset/fix_document_images are WRITE steps: the system auto-advances them when the tool actually succeeds, so you CANNOT advance them by hand (fabricating completion is impossible).",
      "'fail' (step_index, failure_note) marks a step failed; 'retry' (step_index) re-opens a failed step (max 2 auto-retries, then escalate to the user); 'skip' (step_index, note?) skips it and continues; 'complete' closes the plan (refuses while steps remain pending/failed — report honestly instead); 'cancel' abandons the plan.",
      'Use when: multi-section document filling, ≥3 numbered review comments, multi-phase analysis. Do NOT use for: single-question answers, one-line edits, polish of one selection, or any 1-2 step task.',
      'A plan is a ledger of execution, NOT a pre-execution checklist to wait on — create it, then immediately execute step 1.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'advance', 'fail', 'retry', 'skip', 'complete', 'cancel'], description: 'Plan action.' },
        title: { type: 'string', description: 'create: plan title.' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Step title (one actionable item).' },
              tool: { type: 'string', description: 'Write tools (edit_document/edit_deck/insert_asset/fix_document_images): the system advances this step when that tool succeeds — do NOT hand-advance.' },
              note: { type: 'string', description: 'Step detail/progress note.' },
              section: { type: 'string', description: '#989: target section id ([sec:...] from the injected document, e.g. s_xxx) when the step maps to a document section — keeps the ledger aligned with document structure.' },
            },
            required: ['title'],
          },
          description: 'create: the ordered steps (≥3, ≤20).',
        },
        step_index: { type: 'number', description: '1-based step for advance/fail/retry/skip.' },
        note: { type: 'string', description: 'advance/skip/fail: progress or failure note.' },
      },
      required: ['action'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId) return { success: false, error: 'set_task_plan 需要会话上下文' }
    const userId = this.ctx.userId
    // #979 意图推断（生产实证：模型发完整 create 参数但漏 action 字段）—
    // 从参数形态推断：steps 数组=create；step_index=advance；否则可读报错。
    const action = String(args.action || '')
      || (Array.isArray(args.steps) && args.steps.length ? 'create' : '')
      || (Number.isInteger(Number(args.step_index)) && Number(args.step_index) >= 1 ? 'advance' : '')

    try {
      if (action === 'create') {
        // #979:title 缺省推断（第一步标题 → 「任务清单」）
        const rawSteps = Array.isArray(args.steps) ? args.steps : []
        const title = (String(args.title || '').trim() || (rawSteps[0] as any)?.title || '任务清单').slice(0, 500)
        const steps = rawSteps.slice(0, 20).map((s: unknown) => {
          const o = (s ?? {}) as Record<string, unknown>
          return {
            title: String(o.title || '').trim(),
            ...(o.tool ? { tool: String(o.tool).slice(0, 100) } : {}),
            ...(o.note ? { note: String(o.note).slice(0, 500) } : {}),
            // #989: 步骤×节对账 — 目标节 ID 随步骤入账本。
            ...(o.section ? { section: String(o.section).slice(0, 48) } : {}),
          }
        }).filter((s) => s.title)
        // 闸门 1 — 步数硬闸（机读可测，防 #806 打太极复发）。
        if (steps.length < 3) {
          return { success: false, error: '任务步骤不足 3 步 — 简单任务（1-2 步）请直接执行对应工具（如 edit_document），不要建清单。仅在任务确实拆解为 ≥3 个独立步骤时创建。' }
        }
        if (!title) return { success: false, error: 'create 需要 title' }
        const plan = await createPlan(userId, sessionId, title, steps)
        return this.emit(plan, 'created', `已创建任务清单「${title}」（${plan.steps.length} 步）— 清单是执行的账本：立即开始第一项，不要等待确认。`)
      }

      if (action === 'advance') {
        const stepIndex = Number(args.step_index)
        if (!Number.isInteger(stepIndex) || stepIndex < 1) return { success: false, error: 'step_index 必须是 ≥1 的整数' }
        const r = await advanceStep(userId, sessionId, stepIndex, String(args.note || '') || undefined)
        if ('error' in r) return { success: false, error: r.error }
        return this.emit(r.plan, 'advanced')
      }

      if (action === 'fail') {
        const stepIndex = Number(args.step_index)
        if (!Number.isInteger(stepIndex) || stepIndex < 1) return { success: false, error: 'fail 需要 step_index' }
        const r = await failStep(userId, sessionId, stepIndex, String(args.note || '执行失败'))
        if ('error' in r) return { success: false, error: r.error }
        return this.emit(r.plan, 'failed', '已标记失败')
      }

      if (action === 'retry') {
        const stepIndex = Number(args.step_index)
        if (!Number.isInteger(stepIndex) || stepIndex < 1) return { success: false, error: 'retry 需要 step_index' }
        const r = await retryStep(userId, sessionId, stepIndex)
        if ('error' in r) return { success: false, error: r.error }
        return this.emit(r.plan, 'advanced')
      }

      if (action === 'skip') {
        const stepIndex = Number(args.step_index)
        if (!Number.isInteger(stepIndex) || stepIndex < 1) return { success: false, error: 'skip 需要 step_index' }
        const r = await skipStep(userId, sessionId, stepIndex, String(args.note || '') || undefined)
        if ('error' in r) return { success: false, error: r.error }
        return this.emit(r.plan, 'skipped')
      }

      if (action === 'complete') {
        const r = await completePlan(userId, sessionId)
        if ('error' in r) return { success: false, error: r.error }
        return this.emit(r.plan, 'completed', '任务清单已全部完成')
      }

      if (action === 'cancel') {
        await cancelPlan(userId, sessionId)
        return { success: true, output: JSON.stringify({ plan: null, summary: '任务清单已取消' }) }
      }

      return { success: false, error: 'action 必须是 create | advance | fail | retry | skip | complete | cancel' }
    } catch (err) {
      return { success: false, error: `set_task_plan failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 带缺口校验的收口/推进输出 — plan + progress + summary。 */
  private emit(plan: TaskPlan, kind: PlanUpdatedEvent['kind'], extraSummary?: string): ToolResult {
    const progress = { done: plan.steps.filter((s) => s.status === 'done').length, total: plan.steps.length }
    const summary = extraSummary || `清单进度 ${progress.done}/${progress.total}${planBacklog(plan) > 0 ? `（剩余 ${planBacklog(plan)} 步）` : ''}`
    return { success: true, output: JSON.stringify({ plan, kind, summary }) }
  }

}

/** 供 tool-loop presenter 使用的 SSE 事件构造（contracts PlanUpdatedEvent）。 */
export function buildPlanUpdatedEvent(plan: TaskPlan, kind: PlanUpdatedEvent['kind'], source: 'model' | 'system'): PlanUpdatedEvent {
  return {
    type: 'plan_updated',
    plan,
    kind,
    source,
    progress: { done: plan.steps.filter((s) => s.status === 'done').length, total: plan.steps.length },
  }
}
