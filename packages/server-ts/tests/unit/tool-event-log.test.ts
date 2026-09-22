import { describe, test, expect, vi, beforeEach } from 'vitest'
import { createToolEventAppender, TOOL_EVENT_TRUNCATE_CHARS } from '../../src/modules/chat/tool-event-log.js'
import { twinsRoot } from '../../src/lib/upload-path.js'
import fs from 'fs'
import path from 'path'

/**
 * #1106 — 工具事件留痕通道单元测试（#658 write-time truncation）。
 *
 * tool_result 事件超过 500 字符 → 正文截断为预览 + 溢写文件落
 * twinsRoot/<userId>/truncation/,metadata 记录 truncatedTo + spillFile;
 * 其他事件类型不截断;溢写失败(目录不可写)降级为硬切片。
 * 原实现内联在 tool-loop,提取后语义零变更(本文件即行为锚)。
 */

const makeCtx = (): any => ({ eventLog: { append: vi.fn(), query: () => [], count: () => 0 } })

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('#1106 tool-event-log — tool_result 写时截断/溢写', () => {
  test('短输出原样落 eventLog,无溢写痕迹', async () => {
    const ctx = makeCtx()
    const append = createToolEventAppender({ ctx, userId: 'user_ev1', sessionId: 'sess_ev1' })
    await append('tool_result', 'hits', { toolCallId: 1, success: true })

    const ev = ctx.eventLog.append.mock.calls[0][0]
    expect(ev.content).toBe('hits')
    expect(ev.metadata).toEqual({ toolCallId: 1, success: true })
    expect(ev.eventType).toBe('tool_result')
    expect(ev.agentId).toBe('user_ev1')
    expect(ev.sessionId).toBe('sess_ev1')
  })

  test('超长 tool_result → 预览正文 + 溢写文件(metadata.truncatedTo/spillFile)', async () => {
    const ctx = makeCtx()
    const append = createToolEventAppender({ ctx, userId: 'user_ev2', sessionId: 'sess_ev2' })
    const big = 'x'.repeat(TOOL_EVENT_TRUNCATE_CHARS + 200)

    await append('tool_result', big, { toolCallId: 2, success: true })

    const ev = ctx.eventLog.append.mock.calls[0][0]
    expect(ev.metadata.truncatedTo).toBe(TOOL_EVENT_TRUNCATE_CHARS)
    expect(typeof ev.metadata.spillFile).toBe('string')
    expect(ev.content.startsWith(`[Tool output truncated to ${TOOL_EVENT_TRUNCATE_CHARS} chars — full output spilled to ${ev.metadata.spillFile}]`)).toBe(true)
    expect(ev.content.endsWith(big.slice(0, TOOL_EVENT_TRUNCATE_CHARS))).toBe(true)

    // 溢写文件真实存在且含完整原文
    const spillPath = path.join(twinsRoot(), 'user_ev2', 'truncation', ev.metadata.spillFile)
    expect(fs.existsSync(spillPath)).toBe(true)
    expect(fs.readFileSync(spillPath, 'utf-8')).toBe(big)
    fs.rmSync(spillPath, { force: true })
  })

  test('超长的非 tool_result 事件(tool_call)不截断', async () => {
    const ctx = makeCtx()
    const append = createToolEventAppender({ ctx, userId: 'user_ev3', sessionId: 'sess_ev3' })
    const big = 'y'.repeat(TOOL_EVENT_TRUNCATE_CHARS + 100)

    await append('tool_call', big, { tool: 'probe', status: 'pending', seq: 3 })

    const ev = ctx.eventLog.append.mock.calls[0][0]
    expect(ev.content).toBe(big)
    expect(ev.metadata.truncatedTo).toBeUndefined()
  })

  test('溢写失败 → 降级为硬切片,事件仍落库', async () => {
    const ctx = makeCtx()
    const append = createToolEventAppender({ ctx, userId: 'user_ev4', sessionId: 'sess_ev4' })
    const big = 'z'.repeat(TOOL_EVENT_TRUNCATE_CHARS + 100)
    // mkdir 失败 → catch 分支
    vi.doMock('fs/promises', () => ({ mkdir: vi.fn(async () => { throw new Error('EACCES') }) }))

    await append('tool_result', big, { toolCallId: 4 })

    const ev = ctx.eventLog.append.mock.calls[0][0]
    expect(ev.content).toBe(big.slice(0, TOOL_EVENT_TRUNCATE_CHARS))
    expect(ev.metadata.truncatedTo).toBeUndefined()
    vi.doUnmock('fs/promises')
  })
})
