import { describe, test, expect } from 'vitest'
import { resolvePolishMaxTokens, resolvePolishDeadlineMs } from '../../src/modules/documents/document-writing.service.js'
import { estimateTokens } from '../../src/common/token-estimate.js'

/**
 * #869 — 气泡润色预算/超时随选区自适应。
 * 旧固定 maxTokens=4096 与 MAX_POLISH_CHARS=50000 不匹配(思维链共享
 * 预算,大选区高截断);glm-5.3-flash 预算 96000 可自适应。
 */
describe('resolvePolishMaxTokens (#869)', () => {
  test('小选区 → 下限 4096', () => {
    expect(resolvePolishMaxTokens('短句', 'glm-5.3-flash')).toBe(4096)
  })

  test('大选区 → 随选区 tokens × 2 放大', () => {
    const big = '这是一段用于撑大体积的选中文本。'.repeat(400) // ≈ 7.6K 字
    const t = resolvePolishMaxTokens(big, 'glm-5.3-flash')
    expect(t).toBeGreaterThan(4096)
    expect(t).toBeLessThanOrEqual(96000)
  })

  test('超大选区 → 钳制在模型原生预算内', () => {
    const huge = 'x'.repeat(50000) // MAX_POLISH_CHARS 上限(ASCII ≈ 12.5K tokens)
    const need = estimateTokens(huge) * 2
    expect(resolvePolishMaxTokens(huge, 'glm-5.3-flash')).toBe(Math.min(96000, need))
    // 小预算模型(deepseek-chat 8192)同样被钳制
    expect(resolvePolishMaxTokens(huge, 'deepseek-chat')).toBe(Math.min(8192, need))
  })
})

describe('resolvePolishDeadlineMs (#869)', () => {
  test('随字符放宽:150s 基线 + 10ms/字符', () => {
    expect(resolvePolishDeadlineMs(100)).toBe(151_000)
    expect(resolvePolishDeadlineMs(20_000)).toBe(350_000)
  })

  test('上限 600s', () => {
    expect(resolvePolishDeadlineMs(50_000)).toBe(600_000)
  })
})
