import { describe, test, expect } from 'vitest'
import { normalizePage, normalizeLimit, paginate } from '../../src/lib/paginate.js'

/** #922 — 分页唯一实现(lib/paginate):knowledge-gap 与 skills.router 共用。 */
describe('normalizePage / normalizeLimit(#922 严格防护)', () => {
  test('page 非法回落 1', () => {
    expect(normalizePage('abc')).toBe(1)
    expect(normalizePage(undefined)).toBe(1)
    expect(normalizePage('')).toBe(1)
    expect(normalizePage('0')).toBe(1)
    expect(normalizePage('-2')).toBe(1)
    expect(normalizePage(NaN)).toBe(1)
    expect(normalizePage(-5)).toBe(1)
  })

  test('page 合法保留(含 parseInt 口径:前缀数字/小数截断)', () => {
    expect(normalizePage('3')).toBe(3)
    expect(normalizePage('2abc')).toBe(2)
    expect(normalizePage('1.5')).toBe(1)
    expect(normalizePage(7)).toBe(7)
  })

  test('limit clamp 1..100,非法回落 fallback', () => {
    expect(normalizeLimit('abc', 10)).toBe(10)
    expect(normalizeLimit('0', 10)).toBe(10)
    expect(normalizeLimit('-1', 10)).toBe(10)
    expect(normalizeLimit('200', 10)).toBe(100)
    expect(normalizeLimit('50', 10)).toBe(50)
    expect(normalizeLimit('2', 10, 2)).toBe(2)
  })
})

describe('paginate(#922 切片唯一实现)', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)

  test('正常切片 + page clamp 进有效区间(knowledge-gap 口径)', () => {
    const r = paginate(items, 2, 10)
    expect(r.items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(r.page).toBe(2)
    expect(r.total).toBe(25)
    expect(r.totalPages).toBe(3)
    // 越界大页 → 收进最后页(gap 列表行为)。
    const far = paginate(items, 99, 10)
    expect(far.page).toBe(3)
    expect(far.items).toEqual([20, 21, 22, 23, 24])
  })

  test('clampPageToTotal:false 保持 skills 旧行为(越界页回显 + 空结果)', () => {
    const r = paginate(items, 99, 10, { clampPageToTotal: false })
    expect(r.page).toBe(99)
    expect(r.items).toEqual([])
    expect(r.total).toBe(25)
    expect(r.totalPages).toBe(3)
  })

  test('totalPages 为 ceil 口径(空集为 0,由调用方决定是否 max(1,·))', () => {
    expect(paginate([], 1, 10).totalPages).toBe(0)
    expect(paginate([1], 1, 10).totalPages).toBe(1)
  })
})
