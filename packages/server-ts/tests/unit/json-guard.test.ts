import { describe, test, expect } from 'vitest'
import { safeJsonParse } from '../../src/common/llm-json.js'
import { parseAuthorsColumn } from '../../src/modules/submission/submission.router.js'
import { buildPatientProfile } from '../../src/modules/research/eligibility-screening.service.js'

/**
 * #911 — 裸 JSON.parse 收口家族:DB 列 / 外部 HTTP body / env 的坏 JSON
 * 一律降级不抛。单行/单请求损坏不得炸全列表、全筛查或计费主路径。
 */

describe('safeJsonParse(#911 统一入口)', () => {
  test('坏 JSON 返回 null 不抛;合法输入原样返回', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
    expect(safeJsonParse('not-json{{')).toBeNull()
    expect(safeJsonParse('{"a":')).toBeNull()
    expect(safeJsonParse('')).toBeNull()
    expect(safeJsonParse(null)).toBeNull()
    expect(safeJsonParse(undefined)).toBeNull()
  })
})

describe('submission authors 列(#911)', () => {
  test('坏 JSON / 非数组降级 [],合法数组透传', () => {
    expect(parseAuthorsColumn('["张三","李四"]')).toEqual(['张三', '李四'])
    expect(parseAuthorsColumn('not-json{')).toEqual([])
    expect(parseAuthorsColumn('{"name":"意外对象"}')).toEqual([])
    expect(parseAuthorsColumn(null)).toEqual([])
    expect(parseAuthorsColumn(undefined)).toEqual([])
  })
})

describe('eligibility sections 列(#911)', () => {
  test('单行坏 sections 跳过不中断,其余行照常进档案', () => {
    const records = [
      { title: '良好病历', sections: JSON.stringify({ 主诉: '咳嗽 3 天' }) },
      { title: '损坏病历', sections: '{"主诉": "截断的 JSON' },
      { title: '对象病历', sections: { 主诉: '发热' } },
    ]
    const profile = buildPatientProfile(null, [], records)
    expect(profile).toContain('良好病历')
    expect(profile).toContain('咳嗽 3 天')
    expect(profile).toContain('发热')
    expect(profile).not.toContain('损坏病历')
  })

  test('全部行损坏也不抛,返回可用的档案文本', () => {
    const records = [
      { title: '坏1', sections: '{{{' },
      { title: '坏2', sections: '][' },
    ]
    expect(() => buildPatientProfile(null, [], records)).not.toThrow()
  })
})
