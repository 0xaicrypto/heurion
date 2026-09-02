import { describe, test, expect } from 'vitest'
import { lintDocument } from '../../src/common/doc-lint.js'

describe('lintDocument (#809 纯规则一致性检查)', () => {
  test('缩写首用未定义 → abbreviation issue', () => {
    const body = 'The patient received EGFR-TKI therapy.\n\nEGFR (epidermal growth factor receptor) mutations are common.'
    const issues = lintDocument(body).filter((i) => i.type === 'abbreviation')
    expect(issues.length).toBeGreaterThanOrEqual(1)
    expect(issues.some((i) => i.message.includes('EGFR'))).toBe(true)
  })

  test('定义前置 → 无 issue', () => {
    const body = 'Progression-free survival (PFS) was the primary endpoint.\nPFS improved significantly.'
    const issues = lintDocument(body).filter((i) => i.type === 'abbreviation' && i.message.includes('PFS'))
    expect(issues).toHaveLength(0)
  })

  test('定义后置 → 提示定义应前置', () => {
    const body = 'PFS improved significantly.\n\nProgression-free survival (PFS) was the primary endpoint.'
    const issues = lintDocument(body).filter((i) => i.type === 'abbreviation' && i.message.includes('PFS'))
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('先于定义')
  })

  test('引用了不存在的图号 → figure-ref issue', () => {
    const body = '如图1所示，剂量分布...\n\n**图2：布拉格峰**\n\n![图2：布拉格峰](/api/v1/files/download/chart_1.svg?token=t)'
    const issues = lintDocument(body).filter((i) => i.type === 'figure-ref')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('图1')
  })

  test('图号与引用一致 → 无 figure-ref issue', () => {
    const body = '如图1所示...\n\n**图1：布拉格峰**\n\n![图1：布拉格峰](/api/v1/files/download/chart_1.svg?token=t)'
    const issues = lintDocument(body).filter((i) => i.type === 'figure-ref')
    expect(issues).toHaveLength(0)
  })

  test('heading 跳级 → heading-skip issue', () => {
    const body = '# Title\n\n## Section\n\n#### Deep subsection'
    const issues = lintDocument(body).filter((i) => i.type === 'heading-skip')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('H2 跳到 H4')
  })

  test('空文档 → 无 issue', () => {
    expect(lintDocument('')).toEqual([])
    expect(lintDocument('   ')).toEqual([])
  })
})
