import { describe, test, expect, vi, afterEach } from 'vitest'
import { parseEnvInt } from '../../src/common/env-int.js'

/**
 * #1146 — env 整数解析:`5m`/`abc` 等 parseInt → NaN 曾静默生效
 * （setInterval(NaN) ≈ 1ms 热循环）。非法值 warn + 回退默认。
 */
describe('#1146 parseEnvInt', () => {
  afterEach(() => vi.restoreAllMocks())

  test('合法值透传；未设/空 → 默认', () => {
    expect(parseEnvInt('X', 300_000, '1500')).toBe(1500)
    expect(parseEnvInt('X', 5, '1')).toBe(1)
    expect(parseEnvInt('X', 42, undefined)).toBe(42)
    expect(parseEnvInt('X', 42, '   ')).toBe(42)
  })

  test('非法值（含审计实例 5m/abc/0/负）→ warn + 回退默认', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of ['5m', 'abc', '0', '-5', 'NaN']) {
      expect(parseEnvInt('GAP_RESEARCH_INTERVAL_MS', 300_000, raw)).toBe(300_000)
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GAP_RESEARCH_INTERVAL_MS'))
  })

  test('从 process.env 读取（name 键）', () => {
    process.env.__TEST_ENV_INT = '1234'
    expect(parseEnvInt('__TEST_ENV_INT', 1)).toBe(1234)
    delete process.env.__TEST_ENV_INT
  })
})
