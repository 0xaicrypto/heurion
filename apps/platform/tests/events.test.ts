import { describe, expect, it } from 'vitest'
import { describeToolError } from '../src/harness/events.ts'

describe('工具失败的原因（对话里显示给用户）', () => {
  it('平台 MCP 工具的 {code, message, hint}（dsh 包成 Error: …）', () => {
    const content = [{ type: 'text', text: 'Error: {\n  "code": "render_unavailable",\n  "message": "幻灯片渲染不可用：需要 LibreOffice",\n  "hint": "改用 layout_check 检查版面。"\n}' }]
    expect(describeToolError(content)).toEqual({ code: 'render_unavailable', message: '幻灯片渲染不可用：需要 LibreOffice', hint: '改用 layout_check 检查版面。' })
  })
  it('参数校验失败给出人话；其他错误取第一行；没有内容时为空', () => {
    expect(describeToolError([{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool deck_edit: [...]' }])).toEqual({ code: 'validation_error', message: '参数格式不符合要求' })
    expect(describeToolError('Error: ENOENT no such file\n    at …')).toEqual({ message: 'ENOENT no such file' })
    expect(describeToolError(undefined)).toEqual({})
  })
})
