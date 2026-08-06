import { describe, test, expect, beforeEach } from 'vitest'
import { resolvePermission, type PermissionRule } from '../../src/common/permission.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #105: configurable permission rules — allow/deny/ask.
 */
const rule = (partial: Partial<PermissionRule>): PermissionRule => ({
  id: 'r', action: 'approve', resource: '*', effect: 'ask', role: '*', priority: 0,
  ...partial,
})

describe('resolvePermission (#105)', () => {
  test('no rules → ask (default, backward compatible)', () => {
    expect(resolvePermission([], { userId: 'u', role: 'doctor', action: 'approve', resource: 'Skill' })).toBe('ask')
  })

  test('exact rule wins over wildcard (later wins)', () => {
    const rules = [
      rule({ id: 'a', resource: '*', effect: 'allow' }),
      rule({ id: 'b', resource: 'Skill', effect: 'ask' }),
    ]
    expect(resolvePermission(rules, { userId: 'u', role: 'doctor', action: 'approve', resource: 'Skill' })).toBe('ask')
    expect(resolvePermission(rules, { userId: 'u', role: 'doctor', action: 'approve', resource: 'MemoryProposal' })).toBe('allow')
  })

  test('role-specific rule applies only to that role', () => {
    const rules = [rule({ role: 'admin', effect: 'allow' })]
    expect(resolvePermission(rules, { userId: 'u', role: 'admin', action: 'approve', resource: '*' })).toBe('allow')
    expect(resolvePermission(rules, { userId: 'u', role: 'doctor', action: 'approve', resource: '*' })).toBe('ask')
  })

  test('action is scoped', () => {
    const rules = [rule({ action: 'approve', effect: 'deny' })]
    expect(resolvePermission(rules, { userId: 'u', role: '*', action: 'approve', resource: '*' })).toBe('deny')
    expect(resolvePermission(rules, { userId: 'u', role: '*', action: 'view', resource: '*' })).toBe('ask')
  })
})

describe('approval rules API (#105)', () => {
  beforeEach(async () => {
    await (prisma as any).approvalRule.deleteMany({})
  })

  test('allow rule auto-approves; deny rejects; ask queues (service level)', async () => {
    const { createApprovalRequest, decideApproval } = await import('../../src/modules/approvals/approval.service.js')
    const userId = await getAuthUserId()
    const now = new Date().toISOString()
    await (prisma as any).approvalRule.createMany({
      data: [
        { id: 'r1', action: 'approve', resource: 'Skill', effect: 'allow', role: '*', priority: 0, enabled: 1, createdAt: now, updatedAt: now },
        { id: 'r2', action: 'approve', resource: 'Lab', effect: 'deny', role: '*', priority: 0, enabled: 1, createdAt: now, updatedAt: now },
      ],
    })

    expect(await decideApproval(userId, 'doctor', 'approve', 'Skill')).toBe('allow')
    expect(await decideApproval(userId, 'doctor', 'approve', 'Lab')).toBe('deny')
    expect(await decideApproval(userId, 'doctor', 'approve', 'MemoryProposal')).toBe('ask')

    const allowed = await createApprovalRequest(userId, { targetType: 'Skill', targetId: 'skill_1', payload: { name: 'x' } })
    expect((allowed as any).status).toBe('auto_allowed')
    const denied = await createApprovalRequest(userId, { targetType: 'Lab', targetId: 'lab_1', payload: {} })
    expect((denied as any).status).toBe('auto_denied')
    const queued = await createApprovalRequest(userId, { targetType: 'MemoryProposal', targetId: 'mp_1', payload: { content: 'y' } })
    expect((queued as any).status).toBe('pending')
    expect((queued as any).id).toBeTruthy()
    await (prisma as any).approvalRule.deleteMany({})
    await (prisma as any).approvalRequest.deleteMany({})
  })

  test('non-admin cannot manage rules (403)', async () => {
    const app = await getApp()
    // The default test user is admin; simulate a non-admin via role mismatch is
    // not possible with the shared token — verify the endpoint requires admin
    // by checking the admin user can access and 403 path exists for others.
    const { registerSecondUser } = await import('../setup.js')
    const b = await registerSecondUser()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/approvals/rules',
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  test('rule listing via service reflects stored rules', async () => {
    const { listPermissionRules } = await import('../../src/modules/approvals/approval.service.js')
    const now = new Date().toISOString()
    await (prisma as any).approvalRule.create({
      data: { id: 'r3', action: 'view', resource: '*', effect: 'deny', role: '*', priority: 1, enabled: 1, createdAt: now, updatedAt: now },
    })
    const rules = await listPermissionRules()
    expect(rules.some((r) => r.id === 'r3')).toBe(true)
    await (prisma as any).approvalRule.deleteMany({})
  })
})
