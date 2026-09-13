import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from '../setup.js'

/**
 * #1006 — /api/v1/sessions/:sessionId/references（写作/主 chat 通用）。
 * 取消引用只删会话挂载（ReferenceItem 本体保留），同内容跨会话复用。
 */
describe('#1006 session references endpoint', () => {
  const json = async () => ({ ...await authHeader(), 'content-type': 'application/json' })

  test('挂载→列出→跨会话复用→删除只取消挂载', async () => {
    const app = await getApp()
    const h = await json()
    const sessionA = `sess_a_${Date.now()}`
    const sessionB = `sess_b_${Date.now()}`
    const content = `会话引用正文_${Date.now()}`
    const payload = JSON.stringify({ kind: 'pasted_text', content, label: '通用材料' })

    const postA = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionA}/references`, headers: h, payload })
    expect(postA.statusCode).toBe(200)
    const a = JSON.parse(postA.payload)
    expect(a.kind).toBe('pasted_text')
    expect(a.reference_id).toBeTruthy()

    const postB = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionB}/references`, headers: h, payload })
    const b = JSON.parse(postB.payload)
    expect(b.reference_id).toBe(a.reference_id) // 同内容 → 同一 ReferenceItem

    const { default: prisma } = await import('../../src/common/prisma.js')
    expect(await (prisma as any).referenceItem.count({ where: { snapshot: content } })).toBe(1)
    expect(await (prisma as any).sessionReference.count({ where: { referenceId: a.reference_id } })).toBe(2)

    const listA = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionA}/references`, headers: h })
    const refsA = JSON.parse(listA.payload).references
    expect(refsA.some((r: any) => r.reference_id === a.reference_id && r.content === content)).toBe(true)

    // DELETE 只取消 A 的挂载；本体与 B 的挂载保留。
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${sessionA}/references/${a.reference_id}`, headers: h })
    expect(del.statusCode).toBe(200)
    expect(await (prisma as any).sessionReference.count({ where: { sessionId: sessionA, referenceId: a.reference_id } })).toBe(0)
    expect(await (prisma as any).referenceItem.findUnique({ where: { id: a.reference_id } })).toBeTruthy()
    expect(await (prisma as any).sessionReference.count({ where: { sessionId: sessionB, referenceId: a.reference_id } })).toBe(1)

    // 重复删除未挂载 → 404
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${sessionA}/references/${a.reference_id}`, headers: h })
    expect(again.statusCode).toBe(404)
  })

  test('file kind:source_patient_hash 是真 FileIndex id 时落 source_ref', async () => {
    const app = await getApp()
    const h = await json()
    const { default: prisma } = await import('../../src/common/prisma.js')
    const user = await (prisma as any).user.findFirst({ orderBy: { createdAt: 'desc' } })
    const fileId = `${Date.now()}_seed_ref.txt`
    await (prisma as any).fileIndex.create({
      data: { id: fileId, userId: user.id, sha256: `sha_${Date.now()}`, name: 'seed_ref.txt', mime: 'text/plain', sizeBytes: 1, createdAt: 't', updatedAt: 't' },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/sess_file_${Date.now()}/references`,
      headers: h,
      payload: JSON.stringify({ kind: 'file', label: 'seed_ref.txt', content: 'seed_ref.txt', source_patient_hash: fileId }),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).source_ref).toBe(fileId)
  })

  test('pasted_text 空 content → 400', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sessions/sess_invalid/references',
      headers: await json(),
      payload: JSON.stringify({ kind: 'pasted_text', content: '   ' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

// #1014: 摘要登记为引用材料 → MemoryUsageBus 写 referenced（Facts/Summary 信号先行）。
describe('#1014 reference → usage bus', () => {
  test('POST kb_summary + source_ref → 写 referenced 事件', async () => {
    const app = await getApp()
    const { default: prisma } = await import('../../src/common/prisma.js')
    const userId = (await (prisma as any).user.findFirst({ orderBy: { createdAt: 'desc' } })).id
    const unitId = `sum_usage_${Date.now()}`
    const before = await (prisma as any).memoryUsageEvent.count({ where: { userId, unitId } })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/sess_usage_${Date.now()}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'kb_summary', content: '摘要正文', label: '使用统计测试', source_ref: unitId }),
    })
    expect(res.statusCode).toBe(200)

    // fire-and-forget：轮询等待写入落地（上限 ~1s）。
    let after = before
    for (let i = 0; i < 20 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 50))
      after = await (prisma as any).memoryUsageEvent.count({ where: { userId, unitId, action: 'referenced' } })
    }
    expect(after).toBe(before + 1)
  })
})
