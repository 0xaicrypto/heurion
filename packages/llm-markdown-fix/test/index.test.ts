import { describe, test, expect } from 'vitest'
import { fixMarkdown, fixSingleLineTables, fixTableHeadersAndColumns, fixNonStandardSeparator, fixPunctuationCode } from '../src/index.js'

describe('fixSingleLineTables', () => {
  test('整表挤成一行 → 按分隔行列数拆分', () => {
    const md = "On-Chain Reality| Asset | Gross | Debt | Net ||---|---|---|---|| WETH | $3.93M | $3.80M | $0.13M || Total | $321.6M | $141.2M | $180.4M |## Root Cause"
    const out = fixSingleLineTables(md)
    const table = out.split('\n').filter((l) => l.includes('|'))
    expect(table.length).toBeGreaterThanOrEqual(4) // 表头+分隔+数据
    expect(table[0]).toMatch(/^\| On-Chain Reality \|/)
    expect(table[1]).toContain('| --- | --- | --- | --- |')
  })

  test('普通含|行不被误判', () => {
    const md = '使用 | 符号表示或,例如 A | B'
    expect(fixSingleLineTables(md)).toBe(md)
  })
})

describe('fixTableHeadersAndColumns', () => {
  test('表头缺前导 | → 补全并强制分隔行列数一致', () => {
    const md = "On-Chain Reality| Asset | Debt |\n|---|---|---|\n| WETH | $3.93M | $3.80M |"
    const out = fixTableHeadersAndColumns(md)
    expect(out).toContain('| On-Chain Reality| Asset | Debt |')
    expect(out).toContain('| --- | --- | --- |')
  })

  test('hr(---) 不受影响', () => {
    const md = '## h2\n\n---\n\nbody'
    expect(fixTableHeadersAndColumns(md)).toBe(md)
  })
})

describe('fixNonStandardSeparator', () => {
  test('|--| 规范化为 | --- | --- |', () => {
    const md = '| A | B |\n|--|\n| 1 | 2 |'
    const out = fixNonStandardSeparator(md)
    expect(out).toContain('| --- | --- |')
  })

  test('标准分隔行保留', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    expect(fixNonStandardSeparator(md)).toBe(md)
  })
})

describe('fixPunctuationCode', () => {
  test('围栏包裹单个标点 → 还原普通文本', () => {
    const md = '句尾应为```\n.\n```'
    expect(fixPunctuationCode(md)).toBe('句尾应为.')
  })

  test('长代码块保留', () => {
    const md = '```python\nprint(1)\n```'
    expect(fixPunctuationCode(md)).toBe(md)
  })
})

describe('fixMarkdown 管线集成', () => {
  test('真实脏输出全流程修复', () => {
    const dirty = "On-Chain Reality| Asset | Gross Deposits | Debt | Net ||---|---|---|---|| WETH | $3.93M | $3.80M | $0.13M || Total | $321.6M | $141.2M | $180.4M |"
    const out = fixMarkdown(dirty)
    expect(out.split('\n').filter((l) => l.includes('|')).length).toBeGreaterThanOrEqual(3)
    expect(out).not.toContain('|---|---|')
  })

  test('空输入返回空', () => {
    expect(fixMarkdown('')).toBe('')
  })

  test('规则可选择性启用', () => {
    const dirty = "A| B |\n|--|\n| 1 | 2 |"
    // 只启用 punctuationCode → 表格不修
    expect(fixMarkdown(dirty, { rules: ['punctuationCode'] })).toBe(dirty)
    // 启用 nonStandardSeparator(标准表头)→ 分隔行修复为 2 列
    const out = fixMarkdown('| A | B |\n|--|\n| 1 | 2 |', { rules: ['nonStandardSeparator'] })
    expect(out).toContain('| --- | --- |')
  })
})

/**
 * #1149 — 表格规则三修:
 *  - 无尾部管道的表头列数按单元格计(旧实现管道数-1 少算列);
 *  - 代码围栏内不改表格;
 *  - 分隔行对齐冒号保留。
 */
describe('#1149 表格规则正确性', () => {
  test('无尾部管道表头 → 列数按单元格计（3 列不再截成 2 列）', () => {
    const md = 'A | B | C\n|:--|--:|:-:|\n| 1 | 2 | 3 |'
    const out = fixTableHeadersAndColumns(md)
    expect(out).toContain('| A | B | C')
    expect(out).toContain('| :--- | ---: | :---: |')
  })

  test('代码围栏内的表格样文本不被修改', () => {
    const fenced = '```md\nA | B\n---|---\n| 1 | 2 |\n```'
    expect(fixTableHeadersAndColumns(fenced)).toBe(fenced)
    expect(fixNonStandardSeparator(fenced)).toBe(fenced)
    expect(fixSingleLineTables(fenced)).toBe(fenced)
    // 围栏外的同类脏表格仍照修
    const outside = 'A | B\n---|---\n| 1 | 2 |'
    expect(fixTableHeadersAndColumns(outside)).toContain('| --- | --- |')
  })

  test('非标准分隔行保留对齐冒号', () => {
    const md = '| A | B |\n|:--|--:\n| 1 | 2 |'
    const out = fixNonStandardSeparator(md)
    expect(out).toContain('| :--- | ---: |')
  })
})
