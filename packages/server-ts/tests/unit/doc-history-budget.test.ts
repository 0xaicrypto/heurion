import { describe, test, expect } from 'vitest'
import { loadHistoryBudget } from '../../src/modules/chat/history-budget.js'
import { selectProjectionInputs } from '../../src/modules/shared/chat-context.js'
import { CONTEXT_CONFIG } from '../../src/common/context-config.js'

/**
 * P0 hotfix 2026-09 — doc 会话上下文瘦身断言:
 * - history-budget: doc- 会话 6 轮 / 1.5k(非 doc 保持 20 轮 / 32k);
 * - layer3 facts: doc- 会话(无患者上下文)注入封顶 10 条(非 doc 50 条)。
 * 实测 27k+ 上下文下 glm 工具调用可靠性坍塌、≤10k 全正常 — 历史/facts
 * 灌水是主凶,瘦身断言钉死回归线。
 */

const VALID_SESSION = 'doc-doc_00aa11bb22cc33dd'

/** 15 轮用户/助手消息(30 条事件,idx 单调交错 + 降序 = EventLog.query 口径)。 */
function makeHistoryEvents(): any[] {
  const events: any[] = []
  for (let i = 0; i < 15; i++) {
    events.push({ idx: i * 2, eventType: 'user_message', content: `用户消息 ${i}:帮我把第 ${i} 段整理润色一下,并保持原有结构。` })
    events.push({ idx: i * 2 + 1, eventType: 'assistant_response', content: `助手回复 ${i}:已完成第 ${i} 段的润色并写回。` })
  }
  return events.sort((a, b) => b.idx - a.idx)
}

const historyCtx: any = { eventLog: { query: () => makeHistoryEvents() } }

describe('doc 会话历史封顶(history-budget)', () => {
  test('doc- 会话:6 轮窗口 / 1.5k token 预算', async () => {
    const res = await loadHistoryBudget(historyCtx, VALID_SESSION, 'user_1')
    expect(res.historyTurns).toBe(CONTEXT_CONFIG.docHistoryTurns)
    expect(res.historyTurns).toBe(6)
    expect(res.maxHistoryTokens).toBe(CONTEXT_CONFIG.docHistoryTokens)
    expect(res.maxHistoryTokens).toBe(1500)
    // 6 轮 = 至多 12 条 user/assistant 消息进入历史
    expect(res.historyMessages.length).toBeLessThanOrEqual(12)
  })

  test('非 doc 会话:保持 20 轮 / 32k 不变(零行为回归)', async () => {
    const res = await loadHistoryBudget(historyCtx, 'session_plain', 'user_1')
    expect(res.historyTurns).toBe(20)
    expect(res.maxHistoryTokens).toBe(CONTEXT_CONFIG.maxHistoryTokens)
    expect(res.maxHistoryTokens).toBe(32000)
    expect(res.historyMessages.length).toBeLessThanOrEqual(40)
  })

  test('doc 会话只保留最近 6 轮(旧轮次被裁剪)', async () => {
    const res = await loadHistoryBudget(historyCtx, VALID_SESSION, 'user_1')
    const contents = res.historyMessages.map((m) => String(m.content))
    expect(contents.some((c) => c.includes('用户消息 14'))).toBe(true)
    expect(contents.some((c) => c.includes('用户消息 0:'))).toBe(false)
  })
})

describe('doc 会话 layer3 facts 注入封顶(10 条)', () => {
  const makeFactCtx = (n: number): any => ({
    facts: { all: () => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, content: `全局事实 ${i}`, category: 'fact', importance: 3 })) },
    episodes: { all: () => [] },
    skills: { all: () => [] },
  })

  test('doc- 会话(无患者上下文):15 条 facts → 注入封顶 10 条', () => {
    const out = selectProjectionInputs({ intent: 'mixed' } as any, makeFactCtx(15), null, VALID_SESSION)
    expect(out.facts).toHaveLength(10)
  })

  test('非 doc 会话行为不变 — 15 条 facts 全注入(factsCap=50)', () => {
    const out = selectProjectionInputs({ intent: 'mixed' } as any, makeFactCtx(15), null, 'session_plain')
    expect(out.facts).toHaveLength(15)
  })

  test('vector 意图同样封顶', () => {
    const out = selectProjectionInputs({ intent: 'vector' } as any, makeFactCtx(30), null, VALID_SESSION)
    expect(out.facts).toHaveLength(10)
  })
})
