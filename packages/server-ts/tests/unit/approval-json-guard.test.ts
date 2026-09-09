import { describe, test, expect, beforeEach } from 'vitest'
import prisma from '../../src/common/prisma.js'
import { listAuditLogs, serializeApproval } from '../../src/modules/approvals/approval.service.js'

/**
 * #911 — 审批/审计 DB 列 JSON 容错:before/after/payload/diff 列的
 * 单行坏 JSON 降级 null,列表与其余行照常渲染,不再整表炸掉。
 */

const ACTOR = 'u_json_guard'

function auditRow(over: Record<string, unknown> = {}) {
  return {
    actor: ACTOR,
    action: 'approval.confirmed',
    targetType: 'MemoryProposal',
    targetId: `tgt_${Math.random().toString(36).slice(2, 8)}`,
    before: JSON.stringify({ status: 'pending_review' }),
    after: JSON.stringify({ status: 'confirmed' }),
    reason: null,
    createdAt: new Date().toISOString(),
    ...over,
  }
}

describe('#911 审批/审计 DB 列坏 JSON 降级', () => {
  beforeEach(async () => {
    await (prisma as any).auditLog.deleteMany({ where: { actor: ACTOR } })
  })

  test('listAuditLogs:单行 before/after 损坏 → 该行降级 null,其余行正常解析', async () => {
    await (prisma as any).auditLog.create({ data: auditRow() })
    await (prisma as any).auditLog.create({
      data: auditRow({
        targetId: 'tgt_corrupt',
        before: '{"status": "截断的 JSON',
        after: 'not-json{{',
      }),
    })
    const rows: any[] = await listAuditLogs({}, ACTOR, false)
    expect(rows).toHaveLength(2)

    const corrupt = rows.find((r) => r.targetId === 'tgt_corrupt')
    expect(corrupt.before).toBeNull()
    expect(corrupt.after).toBeNull()
    expect(corrupt.action).toBe('approval.confirmed') // 行本身照常渲染

    const good = rows.find((r) => r.targetId !== 'tgt_corrupt')
    expect(good.before).toEqual({ status: 'pending_review' })
    expect(good.after).toEqual({ status: 'confirmed' })
  })

  test('serializeApproval:payload/diff 列损坏 → null 降级,合法列透传', () => {
    const corrupt = serializeApproval({
      id: 'a1', userId: ACTOR, targetType: 'MemoryProposal', targetId: 't1', status: 'pending',
      payload: '{"skillCard": "截断', diff: 'not-json{{', reason: null, actorId: null,
      createdAt: 'now', resolvedAt: null,
    })
    expect(corrupt.payload).toBeNull()
    expect(corrupt.diff).toBeNull()
    expect(corrupt.status).toBe('pending')

    const good = serializeApproval({
      id: 'a2', userId: ACTOR, targetType: 'MemoryProposal', targetId: 't2', status: 'pending',
      payload: JSON.stringify({ skillCard: { name: 'x' } }), diff: null, reason: null, actorId: null,
      createdAt: 'now', resolvedAt: null,
    })
    expect(good.payload).toEqual({ skillCard: { name: 'x' } })
    expect(good.diff).toBeNull()
  })
})
