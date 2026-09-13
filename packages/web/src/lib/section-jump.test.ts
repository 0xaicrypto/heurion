import { describe, test, expect } from 'vitest'
import { resolveSectionJumpTarget, normalizeHeadingText } from './section-jump'

/** #1021 — 稳定 id 优先的节跳转定位（重名标题/改名回退）。 */
describe('#1021 resolveSectionJumpTarget', () => {
  const sections = [
    { id: 's_intro', heading: 'Introduction' },
    { id: 's_notes_1', heading: 'Notes' },
    { id: 's_methods', heading: 'Methods' },
    { id: 's_notes_2', heading: 'Notes' },
  ]
  const headings = [
    { text: 'Introduction', level: 2 },
    { text: 'Notes', level: 2 },
    { text: 'Methods', level: 2 },
    { text: 'Notes', level: 2 },
  ]

  test('重名标题:第二个 Notes 的 id 落到第二个同名标题(不再取首个)', () => {
    const t1 = resolveSectionJumpTarget(sections, headings, 's_notes_1')
    const t2 = resolveSectionJumpTarget(sections, headings, 's_notes_2')
    expect(t1).toEqual({ index: 1, exact: true })
    expect(t2).toEqual({ index: 3, exact: true })
  })

  test('id 不存在 → null（调用方提示"该节已不存在"）', () => {
    expect(resolveSectionJumpTarget(sections, headings, 's_gone')).toBeNull()
  })

  test('标题改名/编辑器标题有差异 → 返回最接近标题并标记 exact=false', () => {
    const t = resolveSectionJumpTarget(sections, [
      { text: 'Introduction', level: 2 },
      { text: 'Method', level: 2 }, // 改名后残留
    ], 's_methods')
    expect(t).toEqual({ index: 1, exact: false })
  })

  test('标题完全对不上 → null（调用方提示定位失败,而不是乱跳）', () => {
    const t = resolveSectionJumpTarget(sections, [{ text: '完全不同的一段', level: 2 }], 's_methods')
    expect(t).toBeNull()
  })

  test('markdown 强调/空白差异仍视为精确命中', () => {
    const t = resolveSectionJumpTarget(
      [{ id: 's_x', heading: '**Deep**  Note' }],
      [{ text: 'Deep Note', level: 3 }],
      's_x',
    )
    expect(t).toEqual({ index: 0, exact: true })
  })

  test('normalizeHeadingText 同口径', () => {
    expect(normalizeHeadingText(' **Methods** ')).toBe('methods')
  })
})
