import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'
import { regenerateSummaryWithLlm } from '../../src/modules/knowledge/summary-synthesis.service.js'

/**
 * #中-11 — 摘要「重新生成」不得在没有来源事实时伪造新鲜度：sourceFacts
 * 全部被替换/删除时返回 ok:false，且不得调用 editSummary（editSummary 会
 * 无条件把 status 标回 current，旧内容+清掉过期标记 = 内容没变却显示最新）。
 */
function makeSummary(over: Record<string, unknown> = {}): any {
  return {
    id: 'sum_1_v1',
    stableId: 'sum_1',
    type: 'summary',
    status: 'stale',
    version: 1,
    title: '旧标题',
    content: '旧正文',
    sourceFacts: [{ nodeId: 'sum_1_v1', stableId: 'fact_gone', version: 1, snapshot: '旧快照' }],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('#中-11 regenerateSummaryWithLlm — 无来源事实不伪造新鲜度', () => {
  beforeEach(() => vi.clearAllMocks())

  test('所有 sourceFacts 已删除 → ok:false 且不调用 editSummary', async () => {
    const memory: any = {
      graph: { getLatestByStableId: () => undefined },
      editSummary: vi.fn(),
    }
    const res = await regenerateSummaryWithLlm(makeSummary(), memory, 'u1')
    expect(res.ok).toBe(false)
    expect(memory.editSummary).not.toHaveBeenCalled()
  })

  test('sourceFacts 指向已 superseded 的节点 → 同样拒绝', async () => {
    const memory: any = {
      graph: {
        getLatestByStableId: () => ({ type: 'fact', stableId: 'fact_gone', status: 'superseded', content: 'x' }),
      },
      editSummary: vi.fn(),
    }
    const res = await regenerateSummaryWithLlm(makeSummary(), memory, 'u1')
    expect(res.ok).toBe(false)
    expect(memory.editSummary).not.toHaveBeenCalled()
  })

  test('有存活来源事实 → 正常走 LLM 并 editSummary', async () => {
    vi.mocked(deepseekChat).mockResolvedValueOnce(JSON.stringify({ title: '新标题', content: '新正文' }))
    const memory: any = {
      graph: {
        getLatestByStableId: () => ({ type: 'fact', stableId: 'fact_ok', status: 'current', content: '存活事实', importance: 4, sourceType: 'doctor' }),
      },
      editSummary: vi.fn(() => ({ ok: true, value: { stableId: 'sum_1' } })),
    }
    const summary = makeSummary({ sourceFacts: [{ nodeId: 'sum_1_v1', stableId: 'fact_ok', version: 1, snapshot: 's' }] })
    const res = await regenerateSummaryWithLlm(summary, memory, 'u1')
    expect(res.ok).toBe(true)
    expect(memory.editSummary).toHaveBeenCalledTimes(1)
  })
})
