/**
 * #976 — 会话级任务清单状态（task_plans 表 + 渲染/对账纯函数）。
 *
 * 设计约束（用户明确要求）：
 * 1. 简单问题不建清单 — 步数硬闸在 set_task_plan 工具侧（<3 步拒绝）。
 * 2. 清单是执行的账本，不是执行的前置确认 — 建完立即执行第一项。
 * 3. 写回步骤（steps[].tool 字段）由系统在工具真实执行成功时自动推进
 *    （tool-loop finishCall 联动 autoAdvanceWriteStep）— 模型无法声称
 *    写回步骤完成（#967 编造路径机制性封死）。
 *
 * common 层（分层 #672）：仅依赖 prisma/logger/contracts，tools 与
 * modules/chat 均可引用。
 */
import prisma from './prisma.js'
import { taskPlanSchema, type TaskPlan, type TaskPlanStep, type TaskPlanStepStatus } from '@heurion/contracts'
import { makeLogger } from './logger.js'

const log = makeLogger('chat.plan-store')
void log

const STEP_MARK: Record<TaskPlanStepStatus, string> = { done: 'x', pending: ' ', failed: '!', skipped: '-' }

function parseSteps(stepsJson: string): TaskPlanStep[] {
  try {
    const parsed = JSON.parse(stepsJson)
    if (Array.isArray(parsed)) return parsed as TaskPlanStep[]
  } catch { /* 损坏 → 空 */ }
  return []
}

function toWire(row: { id: string; sessionId: string; title: string; stepsJson: string; status: string; createdAt: string; updatedAt: string }): TaskPlan {
  const plan = {
    plan_id: row.id,
    session_id: row.sessionId,
    title: row.title,
    steps: parseSteps(row.stepsJson),
    status: row.status as TaskPlan['status'],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
  const check = taskPlanSchema.safeParse(plan)
  return check.success ? (check.data as TaskPlan) : plan
}

/** 当前会话的活跃清单（一活跃：status='active' 最新一条）。 */
export async function loadActivePlan(userId: string, sessionId: string): Promise<TaskPlan | null> {
  const row = await prisma.taskPlan.findFirst({
    where: { userId, sessionId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null)
  if (!row) return null
  const plan = toWire(row)
  return plan.steps.length > 0 ? plan : null
}

/** 创建清单（同会话旧活跃清单置 cancelled — 新 create 语义上取代）。 */
export async function createPlan(userId: string, sessionId: string, title: string, steps: Array<{ title: string; tool?: string; note?: string }>): Promise<TaskPlan> {
  await prisma.taskPlan.updateMany({
    where: { userId, sessionId, status: 'active' },
    data: { status: 'cancelled', updatedAt: new Date().toISOString() },
  }).catch(() => undefined)
  const now = new Date().toISOString()
  const planSteps: TaskPlanStep[] = steps.map((s, i) => ({
    index: i + 1,
    title: s.title.slice(0, 500),
    status: 'pending' as const,
    ...(s.tool ? { tool: s.tool.slice(0, 100) } : {}),
    ...(s.note ? { note: s.note.slice(0, 500) } : {}),
  }))
  const row = await prisma.taskPlan.create({
    data: {
      userId,
      sessionId,
      title: title.slice(0, 500),
      stepsJson: JSON.stringify(planSteps),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  })
  return toWire(row)
}

async function updateSteps(userId: string, sessionId: string, mutate: (steps: TaskPlanStep[]) => { steps: TaskPlanStep[]; status?: TaskPlan['status'] } | null): Promise<TaskPlan | null> {
  const row = await prisma.taskPlan.findFirst({
    where: { userId, sessionId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null)
  if (!row) return null
  const steps = parseSteps(row.stepsJson)
  const mutated = mutate(steps)
  if (!mutated) return null
  const updated = await prisma.taskPlan.update({
    where: { id: row.id },
    data: {
      stepsJson: JSON.stringify(mutated.steps),
      ...(mutated.status ? { status: mutated.status } : {}),
      updatedAt: new Date().toISOString(),
    },
  }).catch(() => null)
  return updated ? toWire(updated) : null
}

/** 模型推进非写回步骤（advance）— 写回步骤（带 tool）由系统推进，手动 advance 静默 no-op。 */
export async function advanceStep(userId: string, sessionId: string, stepIndex: number, note?: string): Promise<{ plan: TaskPlan } | { error: string }> {
  const plan = await updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === stepIndex)
    if (!step || step.status === 'done') return null
    if (step.tool) return { steps }
    step.status = 'done'
    if (note) step.note = note.slice(0, 500)
    return { steps }
  })
  if (!plan) return { error: `无法推进第 ${stepIndex} 步（不存在或已完成）` }
  const step = plan.steps.find((s) => s.index === stepIndex)
  if (step && step.status !== 'done') {
    return { error: `第 ${stepIndex} 步是写回步骤（${step.tool}）— 由系统在工具执行成功后自动推进，无法手动声明完成` }
  }
  return { plan }
}

/** 步骤失败标记（fail action — 重试计数供预算控制）。 */
export async function failStep(userId: string, sessionId: string, stepIndex: number, failureNote: string): Promise<{ plan: TaskPlan } | { error: string }> {
  const plan = await updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === stepIndex)
    if (!step || step.status === 'done') return null
    step.status = 'failed'
    step.failure_note = failureNote.slice(0, 500)
    return { steps }
  })
  if (!plan) return { error: `无法标记第 ${stepIndex} 步为失败（不存在或已完成）` }
  return { plan }
}

/** 重试失败步骤 — retry_count 上限 2（超限拒绝，交还用户）。 */
export async function retryStep(userId: string, sessionId: string, stepIndex: number): Promise<{ plan: TaskPlan } | { error: string }> {
  const plan = await updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === stepIndex)
    if (!step) return null
    if (step.status !== 'failed') return null
    if ((step.retry_count || 0) >= 2) return { steps }
    step.retry_count = (step.retry_count || 0) + 1
    step.status = 'pending'
    return { steps }
  })
  if (!plan) return { error: `无法重试第 ${stepIndex} 步（不存在或已完成）` }
  const step = plan.steps.find((s) => s.index === stepIndex)
  if (step && step.status === 'failed') {
    return { error: `第 ${stepIndex} 步已重试 2 次仍失败 — 请改用选区润色或手动处理该步骤` }
  }
  return { plan }
}

/** 跳过步骤（失败不阻塞后续，收口时如实汇报）。 */
export async function skipStep(userId: string, sessionId: string, stepIndex: number, note?: string): Promise<{ plan: TaskPlan } | { error: string }> {
  const plan = await updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === stepIndex)
    if (!step || step.status === 'done') return null
    step.status = 'skipped'
    if (note) step.failure_note = note.slice(0, 500)
    return { steps }
  })
  if (!plan) return { error: `无法跳过第 ${stepIndex} 步（不存在或已完成）` }
  return { plan }
}

/** 收口清单 — 仍有 pending/failed 步骤时拒绝（诚实收口）。 */
export async function completePlan(userId: string, sessionId: string): Promise<{ plan: TaskPlan } | { error: string }> {
  const active = await loadActivePlan(userId, sessionId)
  if (!active) return { error: '无活跃清单' }
  const pending = active.steps.filter((s) => s.status === 'pending' || s.status === 'failed')
  if (pending.length > 0) {
    return { error: `清单仍有 ${pending.length} 步未完成（第 ${pending.map((s) => s.index).join(',')} 步）— 请继续执行或用 skip 标注放弃的步骤，严禁把未执行步骤汇报为已完成` }
  }
  const plan = await updateSteps(userId, sessionId, (steps) => ({ steps, status: 'completed' as const }))
  return plan ? { plan } : { error: '无活跃清单' }
}

export async function cancelPlan(userId: string, sessionId: string): Promise<void> {
  await prisma.taskPlan.updateMany({
    where: { userId, sessionId, status: 'active' },
    data: { status: 'cancelled', updatedAt: new Date().toISOString() },
  }).catch(() => undefined)
}

/**
 * 闸门 3 — 写回步骤系统自动推进：tool-loop 在写回工具执行成功后调用。
 * 命中规则：活跃清单中第一个 pending 且 tool === 执行工具名的步骤。
 * 返回更新后的 plan（无活跃清单/无命中步骤 → null，调用方不发 SSE）。
 */
export async function autoAdvanceWriteStep(userId: string, sessionId: string, toolName: string): Promise<TaskPlan | null> {
  const active = await loadActivePlan(userId, sessionId)
  if (!active) return null
  const target = active.steps.find((s) => s.status === 'pending' && s.tool === toolName)
  if (!target) return null
  return updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === target.index)
    if (!step || step.status !== 'pending') return null
    step.status = 'done'
    return { steps }
  })
}

/** 写回步骤失败标记（tool-loop 在写回失败时标注 — 重试计数供预算控制）。 */
export async function markWriteStepFailed(userId: string, sessionId: string, toolName: string, failureNote: string): Promise<TaskPlan | null> {
  const active = await loadActivePlan(userId, sessionId)
  if (!active) return null
  const target = active.steps.find((s) => s.status === 'pending' && s.tool === toolName)
  if (!target) return null
  return updateSteps(userId, sessionId, (steps) => {
    const step = steps.find((s) => s.index === target.index)
    if (!step || step.status !== 'pending') return null
    step.status = 'failed'
    step.failure_note = failureNote.slice(0, 200)
    return { steps }
  })
}

/** 对账口径（#972）：failed 与 pending 都算缺口 — 收尾时不可能带着失败步骤声称全完成。 */
export function planBacklog(plan: TaskPlan | null): number {
  if (!plan) return 0
  return plan.steps.filter((s) => s.status === 'pending' || s.status === 'failed').length
}

export function planProgress(plan: TaskPlan): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.status === 'done').length, total: plan.steps.length }
}

/**
 * 上下文注入稳定段（#971）—「当前任务清单（第 K/M 步已完成）」。
 * 超预算折叠：超过 24 行只展示未完成步骤 + 完成计数。
 */
export function renderPlanBlock(plan: TaskPlan | null): string {
  if (!plan) return ''
  const progress = planProgress(plan)
  const lines: string[] = [`## 当前任务清单（第 ${progress.done}/${progress.total} 步已完成）`]
  const MARK_LIMIT = 24
  let shown = 0
  for (const s of plan.steps) {
    if (shown >= MARK_LIMIT) {
      lines.push(`…（其余 ${plan.steps.length - shown} 步已折叠）`)
      break
    }
    shown++
    const failure = s.status === 'failed' ? ` — 失败${s.failure_note ? `：${s.failure_note}` : '，可重试或跳过'}` : ''
    lines.push(`- [${STEP_MARK[s.status]}] ${s.index}. ${s.title}${failure}`)
  }
  lines.push('（逐项执行任务清单；每完成一项会自动勾选；用户回复「继续」时从第一个未完成步骤接着做；未完成的步骤严禁声称已完成。）')
  return `\n${lines.join('\n')}\n`
}

/** doc-executor 接力既定方案段（#973）— 只列未完成步骤。 */
export function renderPendingSteps(plan: TaskPlan | null): string {
  if (!plan) return ''
  const pending = plan.steps.filter((s) => s.status === 'pending' || s.status === 'failed')
  if (pending.length === 0) return ''
  return pending
    .map((s) => `${s.index}. ${s.title}${s.status === 'failed' ? `（上次失败：${s.failure_note || '重试'}）` : ''}${s.tool ? ` [工具: ${s.tool}]` : ''}`)
    .join('\n')
}
