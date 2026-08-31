import { describe, test, expect } from 'vitest'
import { toSlides, slidesToMarkdown } from './deck'

/**
 * #770 — deck.ts 单测：切分语义与后端 buildPresentationContent
 * （packages/server-ts/src/tools/insert-asset-tool.ts，#767）锁定一致。
 * 后端对同输入产出的 slides 断言见 tests/e2e/insert-asset.test.ts
 * （buildPresentationContent describe：['概述','结果','讨论'] 切页）。
 */
describe('#770 toSlides（与后端 buildPresentationContent 语义锁定）', () => {
  test('# → 文档标题不成页；## → 页；正文行 → 段落；- → bullet', () => {
    const body = '# EGFR 研究\n\n## 结果\n\n中位 PFS 5.2 个月。\n\n- PD-L1 ≥50% 获益\n- HR 0.48\n\n## 讨论\n\n获益人群需筛选。'
    const deck = toSlides(body)
    expect(deck.title).toBe('EGFR 研究')
    expect(deck.slides.map((s) => s.title)).toEqual(['结果', '讨论'])
    expect(deck.slides[0].blocks).toEqual([
      { type: 'paragraph', text: '中位 PFS 5.2 个月。' },
      { type: 'bullet', text: 'PD-L1 ≥50% 获益' },
      { type: 'bullet', text: 'HR 0.48' },
    ])
  })

  test('无 ## 结构 → 单页「概述」（与后端一致）', () => {
    const deck = toSlides('第一段正文。\n\n第二段正文。')
    expect(deck.title).toBe('')
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].title).toBe('概述')
    expect(deck.slides[0].blocks.map((b) => b.text)).toEqual(['第一段正文。', '第二段正文。'])
  })

  test('首个 # 之前不能有 ##（h1 仅在无页时是标题 — 与后端判定一致）', () => {
    const deck = toSlides('## 前言\n\n正文。\n\n# 不是标题')
    expect(deck.title).toBe('')
    expect(deck.slides.map((s) => s.title)).toEqual(['前言', '不是标题'])
  })

  test('#773 预留：headingRaw 保留原始行，锚定回文档用', () => {
    const deck = toSlides('## 结果')
    expect(deck.slides[0].headingRaw).toBe('## 结果')
    expect(toSlides('概述正文。').slides[0].headingRaw).toBe('')
  })

  test('图片行 → image 块（卡片缩略图；markdown 行保留可逆）', () => {
    const deck = toSlides('## 结果\n\n![图 1](/api/v1/files/download/a.png?token=x)\n\n结论。')
    expect(deck.slides[0].blocks[0]).toEqual({ type: 'image', text: '图 1', url: '/api/v1/files/download/a.png?token=x', caption: '图 1' })
    expect(deck.slides[0].blocks[1]).toEqual({ type: 'paragraph', text: '结论。' })
  })

  test('上限：30 页 / 每页 50 块（契约 presentationContentSchema 上限对齐）', () => {
    const manyPages = Array.from({ length: 40 }, (_, i) => `## 页${i + 1}\n\n内容${i + 1}`).join('\n\n')
    expect(toSlides(manyPages).slides).toHaveLength(30)

    const manyBlocks = `## 页\n\n${Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join('\n')}`
    const blocks = toSlides(manyBlocks).slides[0].blocks
    expect(blocks).toHaveLength(51)
    expect(blocks[50].text).toContain('其余段落已省略')
  })

  test('#773 slidesToMarkdown 双向重组（语义层可逆）', () => {
    const body = '# 标题\n\n## 结果\n\n中位 PFS 5.2 个月。\n\n- HR 0.48\n\n![图 1](/api/v1/files/download/a.png?token=x)'
    const roundTrip = slidesToMarkdown(toSlides(body))
    expect(roundTrip).toBe('# 标题\n\n## 结果\n\n中位 PFS 5.2 个月。\n\n- HR 0.48\n\n![图 1](/api/v1/files/download/a.png?token=x)')
  })
})
