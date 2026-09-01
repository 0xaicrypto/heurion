import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRawSseSender } from '../../src/modules/chat/chat-sse.js'

/**
 * #fix: SSE 心跳 — 工具执行（render_scene / generate_image / edit_document /
 * delegate）期间没有任何事件下发，Cloudflare/网关 ~100s 空闲即掐断连接，
 * 浏览器端表现为 "网络连接中断（服务器可能已重启或网络不稳定）"。
 */

function fakeReply() {
  const written: string[] = []
  const listeners: Record<string, Array<() => void>> = {}
  const raw: any = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { written.push(chunk); return true }),
    end: vi.fn(() => { raw.writableEnded = true }),
    on: vi.fn((ev: string, cb: () => void) => { (listeners[ev] ??= []).push(cb) }),
  }
  return { reply: { raw } as any, written, listeners }
}

describe('chat-sse heartbeat (#fix)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('writes an SSE comment every 15s; data events flow through untouched', () => {
    const { reply, written } = fakeReply()
    const sender = createRawSseSender(reply)

    sender.send({ type: 'tool_call' } as any)
    expect(written).toEqual([`data: ${JSON.stringify({ type: 'tool_call' })}\n\n`])

    vi.advanceTimersByTime(15_000)
    expect(written.filter((c) => c === ': ping\n\n')).toHaveLength(1)
    vi.advanceTimersByTime(45_000)
    expect(written.filter((c) => c === ': ping\n\n')).toHaveLength(4)
  })

  test('end() stops the heartbeat', () => {
    const { reply, written } = fakeReply()
    const sender = createRawSseSender(reply)
    sender.end()
    vi.advanceTimersByTime(60_000)
    expect(written.filter((c) => c === ': ping\n\n')).toHaveLength(0)
  })

  test('socket close stops the heartbeat and fires the abort signal', () => {
    const { reply, written, listeners } = fakeReply()
    const sender = createRawSseSender(reply)
    for (const cb of listeners.close ?? []) cb()
    expect(sender.signal.aborted).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(written.filter((c) => c === ': ping\n\n')).toHaveLength(0)
  })

  test('heartbeat skips writes once the socket is destroyed', () => {
    const { reply, written } = fakeReply()
    createRawSseSender(reply)
    reply.raw.destroyed = true
    vi.advanceTimersByTime(45_000)
    expect(written).toHaveLength(0)
  })
})
