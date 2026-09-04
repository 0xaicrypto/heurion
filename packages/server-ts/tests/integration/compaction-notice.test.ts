import { describe, test, expect } from 'vitest'
import { buildCompactionNotice } from '../../src/modules/chat/history-budget.js'
import type { CompactionOutcome } from '../../src/memory/compaction/index.js'

/**
 * #display — 压缩结果对用户可见。此前 LLM 摘要失败/为空时压缩"无声消失";
 * 现在 done/failed 都有如实通知,noop 不打扰。
 */
const outcome = (over: Partial<CompactionOutcome>): CompactionOutcome => ({
  kind: 'done', summary: '', prevCoveredIdx: 0, coveredIdx: 50, events: 24,
  ...over,
})

describe('buildCompactionNotice', () => {
  test('done + 本次摘要 → 通知含条数与要点', () => {
    const n = buildCompactionNotice(outcome({ summary: '- 确诊 EGFR 突变\n- 启动奥希替尼' }), '')
    expect(n).toContain('📋 已压缩前序对话（24 条消息）')
    expect(n).toContain('EGFR 突变')
    expect(n).toContain('奥希替尼')
  })

  test('done + 本次摘要为空 → 回退 episodes 全量摘要', () => {
    const n = buildCompactionNotice(outcome({ summary: '' }), '既有会话摘要要点')
    expect(n).toContain('既有会话摘要要点')
    expect(n).toContain('24 条消息')
  })

  test('done + 摘要全空 → 仍通知压缩发生(不再无声消失)', () => {
    const n = buildCompactionNotice(outcome({ summary: '' }), '')
    expect(n).toContain('已压缩前序对话')
    expect(n).toContain('未生成摘要')
  })

  test('failed → 明确告知失败与自动重试(游标未推进)', () => {
    const n = buildCompactionNotice(outcome({ kind: 'failed', events: 30, summary: '' }), '不该出现的旧摘要')
    expect(n).toContain('⚠️')
    expect(n).toContain('30 条消息')
    expect(n).toContain('自动重试')
    expect(n).not.toContain('不该出现的旧摘要') // 失败不得把旧摘要当本次结果展示
  })

  test('noop → null(不打扰)', () => {
    expect(buildCompactionNotice(outcome({ kind: 'noop', events: 0 }), 'x')).toBeNull()
  })
})
