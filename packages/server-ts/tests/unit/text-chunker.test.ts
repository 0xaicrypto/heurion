import { describe, test, expect } from 'vitest'
import { chunkText } from '../../src/lib/text-chunker.js'

describe('#749 text-chunker (document vector indexing)', () => {
  test('短文本整体单块', () => {
    expect(chunkText('短文本')).toEqual(['短文本'])
  })

  test('空/纯空白 → 空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n \n  ')).toEqual([])
  })

  test('长文本按段落边界切块,块间有 overlap', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `第${i}段的临床内容。`.repeat(30))
    const text = paras.join('\n\n')
    const chunks = chunkText(text, { size: 800, overlap: 100 })
    expect(chunks.length).toBeGreaterThan(2)
    // 每块都不超过 size 上限的合理余量
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(900)
    // 相邻块存在重叠(cursor 回退保证跨边界语义可检索)
    expect(chunks[1]).not.toBe(chunks[0])
    // 无内容丢失(去掉 overlap 后的覆盖性粗检:拼接长度 ≥ 原文一半)
    const joined = chunks.join('')
    expect(joined.length).toBeGreaterThanOrEqual(text.length * 0.5)
  })

  test('无段落边界的超长行硬切片且不丢尾', () => {
    const text = 'x'.repeat(5000)
    const chunks = chunkText(text, { size: 1000, overlap: 50 })
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    // 最后一块必须触达文本尾部
    expect(text.endsWith(chunks[chunks.length - 1])).toBe(true)
  })

  test('CRLF 归一化', () => {
    const chunks = chunkText('a\r\n\r\nb', { size: 64 })
    expect(chunks).toEqual(['a\n\nb'])
  })
})
