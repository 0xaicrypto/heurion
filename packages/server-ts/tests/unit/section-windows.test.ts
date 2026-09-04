import { describe, expect, test } from 'vitest'
import { buildSectionWindows } from '../../src/lib/section-windows.js'

const doc = [
  '前言文字。',
  '# 第一章',
  'A'.repeat(150),
  '## 1.1 背景',
  'B'.repeat(150),
  '# 第二章',
  'C'.repeat(150),
  '# 第三章',
  'D'.repeat(150),
].join('\n')

describe('buildSectionWindows', () => {
  test('无标题短文档退化为单窗口', () => {
    const windows = buildSectionWindows('一段没有标题的文字。', 6000, 12)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('一段没有标题的文字。')
  })

  test('按 markdown 标题切章节,短章节各占一窗(h2 也开新节)', () => {
    const windows = buildSectionWindows(doc, 6000, 12)
    // 前言 / 第一章 / 1.1 小节 / 第二章 / 第三章
    expect(windows).toHaveLength(5)
    expect(windows[0]).toContain('前言文字。')
    expect(windows[1]).toContain('# 第一章')
    expect(windows[2]).toContain('## 1.1 背景')
    expect(windows[4]).toContain('# 第三章')
  })

  test('round-robin:预算不足时摊到各章节,尾部章节不被丢弃', () => {
    // 顺序取窗会全砸进第一章;轮转保证 round0 各章节各得一窗
    const long = ['# 一', 'x'.repeat(100), '# 二', 'y'.repeat(100), '# 三', 'z'.repeat(100)].join('\n')
    const windows = buildSectionWindows(long, 40, 4)
    expect(windows).toHaveLength(4)
    expect(windows[0]).toContain('# 一')
    expect(windows[1]).toContain('# 二')
    expect(windows[2]).toContain('# 三')
    // 第 4 窗进入 round1(第一章的第二个滑窗)
    expect(windows[3]).not.toContain('# 二')
    expect(windows[3].length).toBeGreaterThan(0)
  })

  test('预算耗尽即停,不超过 maxWindows', () => {
    const windows = buildSectionWindows(doc, 10, 2)
    expect(windows).toHaveLength(2)
  })

  test('标题前文字归入前言节,不丢失内容', () => {
    const windows = buildSectionWindows('前言。', 6000, 12)
    expect(windows[0]).toContain('前言。')
  })
})
