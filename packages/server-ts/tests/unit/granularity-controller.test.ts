import { describe, test, expect } from 'vitest'
import { MemoryGranularityController } from '../../src/memory/granularity-controller.js'

/**
 * #1013 — 颗粒度决策集中点：边界与三处既有规则逐字一致（零行为改动）。
 */
const c = new MemoryGranularityController()

describe('#1013 MemoryGranularityController', () => {
  test('情景边界 — 提取 ≥2 / 压缩 ≥4', () => {
    expect(c.shouldConsolidate('episodic', { kind: 'extract_segment', eventCount: 1 })).toBe(false)
    expect(c.shouldConsolidate('episodic', { kind: 'extract_segment', eventCount: 2 })).toBe(true)
    expect(c.shouldConsolidate('episodic', { kind: 'compaction_segment', eventCount: 3 })).toBe(false)
    expect(c.shouldConsolidate('episodic', { kind: 'compaction_segment', eventCount: 4 })).toBe(true)
  })

  test('语义合成 — scoped/unused/最大簇均 ≥3', () => {
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', scopedCount: 2 })).toBe(false)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', scopedCount: 3 })).toBe(true)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', unusedCount: 2 })).toBe(false)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', unusedCount: 3 })).toBe(true)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', bestClusterCount: 2 })).toBe(false)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis', bestClusterCount: 3 })).toBe(true)
    expect(c.shouldConsolidate('semantic', { kind: 'summary_synthesis' })).toBe(false)
  })

  test('K6 缺口 — 未覆盖 + 问题形 + 长度 >5', () => {
    const base = { kind: 'gap' as const, covered: false, questionShaped: true, messageLength: 10 }
    expect(c.shouldPromote(base)).toBe(true)
    expect(c.shouldPromote({ ...base, covered: true })).toBe(false)
    expect(c.shouldPromote({ ...base, questionShaped: false })).toBe(false)
    expect(c.shouldPromote({ ...base, messageLength: 5 })).toBe(false)
    expect(c.shouldPromote({ ...base, messageLength: 6 })).toBe(true)
  })

  test('降级 — Phase A 无既有规则，恒 false（Phase F 再接使用数据）', () => {
    expect(c.shouldDemote({ unitId: 'x' }, { uses: 0 })).toBe(false)
  })
})
