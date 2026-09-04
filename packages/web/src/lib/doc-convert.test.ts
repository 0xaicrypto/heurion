import { describe, test, expect } from 'vitest'
import { markdownToHtml, htmlToMarkdown } from './doc-convert'

/**
 * #837 — md ↔ HTML 往返回归保护。
 * 审阅机制的全部落地路径都经过 markdownToHtml → tiptap → htmlToMarkdown;
 * 往返不保值时,接受 AI 修改就会破坏文档结构(生产事故:\## 逃逸、标题
 * 粘进段落)。以下为结构不变量(非逐字节等价)。
 */
function roundTrip(md: string): string {
  return htmlToMarkdown(markdownToHtml(md))
}

describe('doc-convert markdown round-trip (#837)', () => {
  test('标题层级保持块结构 — 不粘连、无 \\/# 逃逸', () => {
    const md = '# 主标题\n\n## Introduction\n\nEGFR mutations occur in NSCLC.\n\n### 子节\n\n正文段落。'
    const out = roundTrip(md)
    expect(out).toMatch(/(^|\n)#{1,6}\s*Introduction/)
    expect(out).toMatch(/(^|\n)#{1,3}\s*子节/)
    expect(out).not.toContain('\\#')
    // 标题与正文分属不同行
    expect(out).toMatch(/Introduction\n\n?EGFR mutations/)
    expect(out).toMatch(/子节\n\n?正文段落/)
  })

  test('列表与有序列表保持', () => {
    const md = '- 列表项一\n- 列表项二\n\n1. 有序一\n2. 有序二'
    const out = roundTrip(md)
    expect(out).toContain('列表项一')
    expect(out).toContain('列表项二')
    expect(out).toContain('有序一')
    expect(out).toContain('有序二')
  })

  test('GFM 表格往返保持管道结构', () => {
    const md = '| 药物 | 剂量 |\n|---|---|\n| A | 100mg |\n| B | 200mg |'
    const out = roundTrip(md)
    expect(out).toContain('|')
    expect(out).toContain('A')
    expect(out).toContain('100mg')
    expect(out).toContain('B')
  })

  test('行内样式(加粗/斜体/行内代码/链接)保持', () => {
    const md = '含**加粗**、*斜体*、`代码`与[链接](https://example.com)的段落。'
    const out = roundTrip(md)
    expect(out).toContain('**加粗**')
    expect(out).toContain('链接')
  })

  test('多段落后往返不合并成一段', () => {
    const md = '第一段。\n\n第二段。\n\n第三段。'
    const out = roundTrip(md)
    expect(out).toMatch(/第一段。\n\n?第二段。/)
    expect(out).toMatch(/第二段。\n\n?第三段。/)
  })

  test('AI 写回典型形态(标题+小节+列表)整篇往返', () => {
    const md = [
      '# 论文标题',
      '',
      '## Introduction',
      '',
      '背景段落一。',
      '',
      '### EGFR-Mutant NSCLC and the TKI Era',
      '',
      'EGFR mutations occur in approximately 15–50% of patients.',
      '',
      '- 首次应用',
      '- 填补空白',
      '',
      '## Methods',
      '',
      '回顾性真实世界研究。',
    ].join('\n')
    const out = roundTrip(md)
    expect(out).toMatch(/### EGFR-Mutant NSCLC and the TKI Era/)
    expect(out).toMatch(/Era\n\n?EGFR mutations occur/)
    expect(out).not.toContain('\\#')
    expect(out).toMatch(/-\s+首次应用/)
  })
})
