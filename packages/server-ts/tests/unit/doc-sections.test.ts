import { describe, test, expect } from 'vitest'
import { splitDocumentSections, resolveDocumentFocus, type DocSection } from '../../src/lib/doc-sections.js'

describe('#fix 长文档分段 splitDocumentSections', () => {
  test('heading 模式:按 ## 标题切分,含标题行与后续内容', () => {
    const body = '# 论文标题\n\n## 摘要\n\n这是摘要内容。\n\n## 方法\n\n这是方法内容。\n\n## 结论\n\n这是结论。'
    const res = splitDocumentSections(body)
    expect(res.mode).toBe('heading')
    // 仅标题行的大标题(# 论文标题)被过滤,不产生空段。
    expect(res.sections.length).toBe(3)
    expect(res.sections[0].title).toBe('摘要')
    expect(res.sections[0].content).toContain('这是摘要内容。')
    expect(res.sections[1].title).toBe('方法')
    expect(res.sections[1].content).toContain('这是方法内容。')
    expect(res.sections[2].title).toBe('结论')
    // 段内容不含下一段标题
    expect(res.sections[0].content).not.toContain('方法')
  })

  test('heading 模式:三级标题(#/###)也作为段边界', () => {
    const body = '## A\n\naaaa\n\n### A1\n\nbbbb\n\n### A2\n\ncccc'
    const res = splitDocumentSections(body)
    expect(res.mode).toBe('heading')
    expect(res.sections.map((s) => s.title)).toEqual(['A', 'A1', 'A2'])
  })

  test('length 模式:无标题连续长文按段落+token 兜底,段落不被切开', () => {
    const body = Array.from({ length: 40 }, (_, i) => `段落 ${i} 的内容。`.repeat(20)).join('\n\n')
    const res = splitDocumentSections(body, 200)
    expect(res.mode).toBe('length')
    expect(res.sections.length).toBeGreaterThan(1)
    // 段落完整性:每个块由完整的"段落 N 的内容。"单元组成,不从中切开。
    for (const s of res.sections) {
      const units = s.content.split('\n\n')
      expect(units.length).toBeGreaterThan(0)
      for (const u of units) expect(/^(?:段落 \d+ 的内容。)+$/.test(u)).toBe(true)
    }
  })

  test('length 模式:超大单段落按句子边界硬切', () => {
    const bigParagraph = '第一句内容。第二句内容。第三句内容。第四句内容。第五句内容。'.repeat(30)
    const res = splitDocumentSections(bigParagraph, 150)
    expect(res.mode).toBe('length')
    expect(res.sections.length).toBeGreaterThan(1)
    // 硬切不产生空块
    for (const s of res.sections) expect(s.content.trim().length).toBeGreaterThan(0)
  })

  test('空文档返回空段列表', () => {
    expect(splitDocumentSections('').sections.length).toBe(0)
    expect(splitDocumentSections('   ').sections.length).toBe(0)
  })

  test('仅一个标题时回退 length 模式(标题不足 2 个无法分段)', () => {
    const res = splitDocumentSections('# 标题\n\n只有一段正文。')
    expect(res.mode).toBe('length')
  })
})

describe('resolveDocumentFocus 段落焦点解析', () => {
  const sections: DocSection[] = [
    { index: 1, title: '摘要', content: 'x' },
    { index: 2, title: '方法', content: 'x' },
    { index: 3, title: '结果', content: 'x' },
  ]

  test('显式"第 N 段/节/部分"', () => {
    expect(resolveDocumentFocus('请编辑第 2 段', sections)).toBe(2)
    expect(resolveDocumentFocus('第 3 节怎么改', sections)).toBe(3)
    expect(resolveDocumentFocus('先改第一部分', sections)).toBe(1)
  })

  test('章节标题匹配', () => {
    expect(resolveDocumentFocus('把方法部分润色一下', sections)).toBe(2)
    expect(resolveDocumentFocus('润色摘要', sections)).toBe(1)
  })

  test('"继续"→ 上一条助手消息提到的段 + 1', () => {
    expect(resolveDocumentFocus('继续', sections, '已完成 第 2/3 段「方法」的润色')).toBe(3)
    expect(resolveDocumentFocus('继续', sections, '第 1 段处理完成')).toBe(2)
    // 无历史 → 第 1 段
    expect(resolveDocumentFocus('继续', sections)).toBe(1)
  })

  test('越界钳制与默认值', () => {
    expect(resolveDocumentFocus('第 99 段', sections)).toBe(3)
    expect(resolveDocumentFocus('随便聊聊', sections)).toBe(1)
    expect(resolveDocumentFocus('', sections)).toBe(1)
  })
})
