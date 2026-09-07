import { describe, test, expect, vi } from 'vitest'
import { appendTurnInterruptedMarker } from '../../src/modules/chat/chat-handler.js'

/**
 * #883 — 回合中断标记。SSE close(页面刷新/手动停止)时落一条助手侧提示,
 * 历史重放可见中断点与「继续」入口,不再是悬空的用户消息。
 */
describe('appendTurnInterruptedMarker (#883)', () => {
  test('追加 assistant_response 标记:内容带继续入口,metadata.interrupted', () => {
    const append = vi.fn()
    appendTurnInterruptedMarker({ eventLog: { append } }, 'user_1', 'doc-doc1')

    expect(append).toHaveBeenCalledTimes(1)
    const e = append.mock.calls[0][0] as any
    expect(e.eventType).toBe('assistant_response')
    expect(e.content).toContain('页面刷新或手动停止被中断')
    expect(e.content).toContain('回复「继续」')
    expect(e.metadata.interrupted).toBe(true)
    expect(e.agentId).toBe('user_1')
    expect(e.sessionId).toBe('doc-doc1')
  })

  test('append 抛错不影响中断处理(静默)', () => {
    const append = vi.fn(() => { throw new Error('disk full') })
    expect(() => appendTurnInterruptedMarker({ eventLog: { append } }, 'user_1', 'doc-doc1')).not.toThrow()
  })
})
