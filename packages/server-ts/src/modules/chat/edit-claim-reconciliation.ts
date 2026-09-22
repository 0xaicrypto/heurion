/**
 * #1106 — 声明-执行对账守卫（收尾段提取，自 tool-loop.ts）。
 *
 * 原 #892（零写回守卫）/#967（部分执行对账）/#972（清单 backlog）/
 * #979（文本计划表守卫）的收尾对账块在 runToolCallLoop 内联了 ~90 行。
 * 本模块把它提取为独立可单测单元：输入收尾文本 + 写回口径 + 清单状态，
 * 输出 SSE 警示 + edit_claim_unbacked 事件留痕 + 对账缺口数。行为与
 * 原内联实现逐字一致（锚定测试闸门）。
 */
import { detectUnbackedEditClaim, countClaimedEditItems, detectTextOnlyPlan } from './edit-reconciliation.js'
// #976: 任务清单状态（common 层）。
import { loadActivePlan, planBacklog, renderPendingSteps } from '../../common/plan-store.js'
import type { TurnIO } from './tool-loop.js'

export interface EditClaimReconciliationInput {
  sessionId: string
  userId: string
  /** 收尾回复文本（finalContent）。 */
  finalContent: string
  /** #979: 本回合是否执行过 set_task_plan（文本计划表守卫豁免依据）。 */
  planWasManaged: boolean
  /** #892: 写回工具执行次数（成功或失败）。 */
  docWriteExecuted: number
  /** #977: 成功写回次数（守卫口径）。 */
  docWriteSucceeded: number
  io: TurnIO
  /** 事件留痕通道（tool-loop 的 appendToolEvent，含截断落盘语义）。 */
  appendEvent: (eventType: string, content: string, metadata: Record<string, unknown>) => Promise<void>
}

export interface EditClaimReconciliationResult {
  /** #967: 对账缺口（claimed 数），0 = 对账一致。 */
  unbackedClaimCount: number
  /** #972: 活跃清单缺口（pending+failed 步数）。 */
  planBacklogCount: number
  /** 接力方案段（清单 pending 步骤渲染）。 */
  planPendingText: string
}

const EMPTY_RESULT: EditClaimReconciliationResult = { unbackedClaimCount: 0, planBacklogCount: 0, planPendingText: '' }

export async function runEditClaimReconciliation(
  input: EditClaimReconciliationInput,
): Promise<EditClaimReconciliationResult> {
  const { sessionId, userId, finalContent, io, appendEvent } = input
  if (!sessionId.startsWith('doc-')) return EMPTY_RESULT
  // 注：本函数不做外层兜底 try/catch — 原内联实现中 io.send/appendEvent
  // 的异常会照常上抛中断回合，提取后保持同一语义（loadActivePlan 的
  // catch 兜底在原实现即存在）。
  // #972: 活跃任务清单收尾对账 — backlog（pending+failed 步）> 0 且
  // 收尾命中完成声明 → 警示 + 事件 + 接力材料（替代文本解析启发式）。
  const activePlan = await loadActivePlan(userId, sessionId).catch(() => null)
  const backlog = planBacklog(activePlan)
  const planPendingText = renderPendingSteps(activePlan)
  const claimedCount = countClaimedEditItems(finalContent)
  // #977: 守卫口径统一为「成功写回」——失败执行不算写回（文档未被修改的
  // 事实依据）。#979 文本计划表守卫 — 收尾输出 ≥3 个编号步骤的文本计划/
  // 对照表且本轮无 set_task_plan 调用 → 逼向结构化账本。
  if (!input.planWasManaged) {
    const textPlan = detectTextOnlyPlan(finalContent)
    if (process.env.DEBUG_GUARD) console.log('GUARD_DBG numbered=' + textPlan.numberedStepLines + ' tableLike=' + textPlan.tableLike + ' len=' + finalContent.length + ' sess=' + sessionId)
    if (textPlan.hit) {
      await appendEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
        kind: 'text_plan',
        numberedStepLines: textPlan.numberedStepLines,
        note: 'text-only plan table without set_task_plan',
      })
      io.send({
        type: 'context_info',
        text: '⚠️ 检测到文本版计划表 — 文本清单无法自动推进与进度追踪，请让 AI 用 set_task_plan 建立正式清单（回复「开始」即可）',
        kind: 'warning',
      })
    }
  }

  // 分支序：零写回（最严重）→ 清单 backlog → 文本计数部分执行。
  // #976 补丁：backlog > 0 且零成功写回 → 无条件警示（建了清单没执行的
  // 空转形态——收尾文本是「回复开始」类等待确认话术，不命中声明词）。
  if (input.docWriteSucceeded === 0 && backlog > 0 && !detectUnbackedEditClaim(finalContent)) {
    await appendEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
      kind: 'plan_backlog',
      planId: activePlan?.plan_id,
      backlog,
      docWriteSucceeded: input.docWriteSucceeded,
      note: 'plan created but no write executed this turn',
    })
    io.send({
      type: 'context_info',
      text: `⚠️ 任务清单已建立但本轮尚未执行任何写回（${backlog} 步待办）— 可回复「开始」或「继续」让 AI 接力执行`,
      kind: 'warning',
    })
    return { unbackedClaimCount: backlog, planBacklogCount: backlog, planPendingText }
  }
  if (input.docWriteSucceeded === 0 && detectUnbackedEditClaim(finalContent)) {
    await appendEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
      claimedEdit: true,
      docWriteExecuted: input.docWriteExecuted,
      docWriteSucceeded: input.docWriteSucceeded,
      ...(backlog > 0 ? { planBacklog: backlog } : {}),
    })
    io.send({
      type: 'context_info',
      text: backlog > 0
        ? `⚠️ 上面的回复声称已完成文档编辑，但本轮无成功写回，且任务清单仍有 ${backlog} 步未完成 — 文档未被修改`
        : '⚠️ 上面的回复声称已完成文档编辑，但本轮未产生任何成功写回，文档未被修改',
      kind: 'warning',
    })
    return { unbackedClaimCount: Math.max(claimedCount, backlog), planBacklogCount: backlog, planPendingText }
  }
  if (backlog > 0 && detectUnbackedEditClaim(finalContent)) {
    await appendEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
      kind: 'plan_backlog',
      planId: activePlan?.plan_id,
      backlog,
      docWriteSucceeded: input.docWriteSucceeded,
    })
    io.send({
      type: 'context_info',
      text: `⚠️ 上面的回复声称已完成文档编辑，但任务清单仍有 ${backlog} 步未完成 — 可回复「继续」从剩余步骤接着执行`,
      kind: 'warning',
    })
    return { unbackedClaimCount: backlog, planBacklogCount: backlog, planPendingText }
  }
  if (claimedCount > input.docWriteSucceeded) {
    await appendEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
      claimedCount,
      docWriteSucceeded: input.docWriteSucceeded,
      kind: 'partial',
    })
    io.send({
      type: 'context_info',
      text: `⚠️ 上面的回复声称已完成 ${claimedCount} 处编辑，但本轮实际写回 ${input.docWriteSucceeded} 处 — 其余条目未写入文档。可回复「继续」让 AI 执行剩余部分`,
      kind: 'warning',
    })
    return { unbackedClaimCount: claimedCount, planBacklogCount: backlog, planPendingText }
  }
  return { unbackedClaimCount: 0, planBacklogCount: backlog, planPendingText }
}
