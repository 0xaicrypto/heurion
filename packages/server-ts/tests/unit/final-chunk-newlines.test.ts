import { describe, test, expect } from 'vitest'

/**
 * #fix 2026-09 — final_answer_chunk 分块换行保真回归。
 * 旧写法 `.{1,80}/g` 无 /s 标志: `.` 不匹配 \n,分块把整个回答的换行
 * 全部丢弃 — 前端 markdown 渲染时表格行粘连(||、|##)、列表/标题崩坏。
 */
describe('final_answer_chunk newline fidelity', () => {
  test('`.}` without /s drops newlines — documents the root cause', () => {
    const md = '| 会议 | 时间 |\n| -- | -- |\n| AACR | 5.30 |'
    const chunks = md.match(/.{1,80}/g) || []
    expect(chunks.join('')).not.toContain('\n') // 旧行为:换行蒸发
  })

  test('`[\\s\\S]{1,80}/gs` preserves newlines exactly', () => {
    const md = [
      '## 会议一览',
      '',
      '| 会议 | 时间 | 地点 |',
      '| -- | -- | -- |',
      '| AACR 年会 | 2025.4.25-30 | 芝加哥 |',
      '| ASCO 年会 | 2025.5.30-6.3 | 芝加哥 |',
      '',
      '正文段落。',
    ].join('\n')
    const chunks = md.match(/[\s\S]{1,80}/gs) || []
    // 分块拼接必须与原文逐字符一致(含全部换行)。
    expect(chunks.join('')).toBe(md)
    expect(chunks.every((c) => c.length <= 80)).toBe(true)
  })
})
