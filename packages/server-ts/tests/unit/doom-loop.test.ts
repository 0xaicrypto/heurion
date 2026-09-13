import { describe, test, expect } from 'vitest'
import { classifyToolFailure, detectFailureStreak, type ToolFailureEntry } from '../../src/tools/doom-loop.js'

/** #1024 — 工具失败语义分类 + 同工具同分类连续失败熔断判定。 */
describe('#1024 classifyToolFailure — 错误文本 → 稳定分类', () => {
  test('锚点类:未找到 / 多次命中 分开归类', () => {
    expect(classifyToolFailure('old_text 在文档中未找到(已忽略空格/换行差异后仍不匹配)')).toBe('anchor_not_found')
    expect(classifyToolFailure('old_text 在文档中出现多次,请包含更多上下文让锚点唯一')).toBe('ambiguous_anchor')
  })

  test('节/参数/并发/超时/预算分类', () => {
    expect(classifyToolFailure('section s_x 在当前文档投影中不存在（ID 已失效）')).toBe('section_invalid')
    expect(classifyToolFailure('本次调用没有任何参数（参数在传输中丢失或未生成）')).toBe('empty_args')
    expect(classifyToolFailure('文档已被并发修改，本次写回基于过期内容被拒绝')).toBe('conflict')
    expect(classifyToolFailure('工具 execute 执行超过 30s 被中止')).toBe('timeout')
    expect(classifyToolFailure('推理量已达上限（约 150k 字）')).toBe('budget')
  })

  test('空/未知错误 → tool_error(不误判)', () => {
    expect(classifyToolFailure(undefined)).toBe('tool_error')
    expect(classifyToolFailure('')).toBe('tool_error')
    expect(classifyToolFailure('unexpected internal failure')).toBe('tool_error')
  })
})

describe('#1024 detectFailureStreak — 连续同类失败判定', () => {
  const entry = (tool: string, cls: ToolFailureEntry['failureClass']): ToolFailureEntry => ({ tool, failureClass: cls })

  test('末尾(含本次)连续 3 条同工具同分类 → true', () => {
    const h = [entry('edit_document', 'anchor_not_found'), entry('edit_document', 'anchor_not_found'), entry('edit_document', 'anchor_not_found')]
    expect(detectFailureStreak(h, 'edit_document', 'anchor_not_found')).toBe(true)
  })

  test('不足 3 条或分类中断 → false', () => {
    expect(detectFailureStreak([entry('edit_document', 'anchor_not_found')], 'edit_document', 'anchor_not_found')).toBe(false)
    const mixed = [entry('edit_document', 'anchor_not_found'), entry('edit_document', 'timeout'), entry('edit_document', 'anchor_not_found')]
    expect(detectFailureStreak(mixed, 'edit_document', 'anchor_not_found')).toBe(false)
  })

  test('不同工具各自独立:同分类但工具不同不熔断', () => {
    const h = [entry('edit_document', 'timeout'), entry('edit_document', 'timeout'), entry('insert_asset', 'timeout')]
    expect(detectFailureStreak(h, 'insert_asset', 'timeout')).toBe(false)
  })
})
