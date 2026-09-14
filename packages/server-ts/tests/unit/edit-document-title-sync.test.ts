import { describe, test, expect } from 'vitest'
import { leadingTitleHeading, syncLeadingTitleHeading } from '../../src/tools/edit-document-tool.js'

/**
 * #408-followup-2: 标题写回同步正文首行标题 heading 的纯函数护栏。
 * 生产实例:AI 只改 Doc.title 元数据 → 用户在正文看到的标题原样。
 */
describe('#408-followup-2 — 标题 heading 同步', () => {
  test('leadingTitleHeading: 首个非空块是 heading 才返回文本(剥离 [sec:...])', () => {
    expect(leadingTitleHeading('## EGFR 突变晚期 NSCLC [sec:s_title]\n\n正文')).toBe('EGFR 突变晚期 NSCLC')
    expect(leadingTitleHeading('\n\n# 标题\n正文')).toBe('标题')
    expect(leadingTitleHeading('普通段落开头')).toBeNull()
    expect(leadingTitleHeading('')).toBeNull()
  })

  test('首行 heading == 旧标题 → 替换并保留 heading 层级', () => {
    const body = '## 中文旧标题\n\nAbstract\n\n正文。'
    const out = syncLeadingTitleHeading(body, '中文旧标题', 'New English Title')
    expect(out).toBe('## New English Title\n\nAbstract\n\n正文。')
  })

  test('空白/大小写差异视为同一标题;无差异时不改', () => {
    const body = '#  Old   Title \n正文'
    expect(syncLeadingTitleHeading(body, 'old title', 'New')).toBe('# New\n正文')
    // 旧=新 → 无变化
    expect(syncLeadingTitleHeading(body, 'Old Title', 'Old Title')).toBeNull()
  })

  test('首块不是标题 heading / 与旧标题不符 → 不误改正文首节', () => {
    expect(syncLeadingTitleHeading('## Introduction\n\n正文。', 'My Paper', 'New Title')).toBeNull()
    expect(syncLeadingTitleHeading('正文段落。', '旧标题', 'New Title')).toBeNull()
    expect(syncLeadingTitleHeading('', '旧标题', 'New Title')).toBeNull()
  })

  test('前导空行不影响定位', () => {
    const body = '\n\n## 旧标题\n\n内容'
    expect(syncLeadingTitleHeading(body, '旧标题', '新标题')).toBe('\n\n## 新标题\n\n内容')
  })
})
