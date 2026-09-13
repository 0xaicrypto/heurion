import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1006 — 主 chat 会话引用材料段：写作会话短路；无挂载空串；
 * 有挂载时经统一注入实现产出 system 段；分类器注入给装载器。
 */
const loadMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/lib/reference-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/reference-store.js')>()),
  loadSessionReferenceItems: loadMock,
}))

import { buildSessionReferencesBlock } from '../../src/modules/chat/session-refs-builder.js'

beforeEach(() => {
  loadMock.mockReset()
  loadMock.mockResolvedValue([])
})

describe('#1006 buildSessionReferencesBlock', () => {
  test('写作会话（doc-*）短路：不加载、返回空串', async () => {
    const out = await buildSessionReferencesBlock({ userId: 'u1', sessionId: 'doc-abc', messageText: 'x' })
    expect(out).toBe('')
    expect(loadMock).not.toHaveBeenCalled()
  })

  test('无挂载 → 空串（合法降级）', async () => {
    const out = await buildSessionReferencesBlock({ userId: 'u1', sessionId: 'sess_1', messageText: 'x' })
    expect(out).toBe('')
    expect(loadMock).toHaveBeenCalledWith('u1', 'sess_1', expect.objectContaining({ classifyGuideline: expect.any(Function) }))
  })

  test('有挂载 → 产出 Reference Materials 段（复用统一注入实现）', async () => {
    loadMock.mockResolvedValue([
      { id: 'ref_1', kind: 'pasted_text', sourceRef: null, label: '材料A', snapshot: '这是正文内容', addedAt: 't', source: 'manual' },
    ])
    const out = await buildSessionReferencesBlock({ userId: 'u1', sessionId: 'sess_1', messageText: '问题' })
    expect(out).toContain('## Reference Materials')
    expect(out).toContain('### 材料A')
    expect(out).toContain('这是正文内容')
  })
})
