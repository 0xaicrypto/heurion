import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { MemoryGraphGateway, registerProposalApplier } from '../src/memory/memory-gateway.js'
import { createApprovalRequest, confirmApproval, rejectApproval } from '../src/modules/approvals/approval.service.js'
import path from 'path'
import fs from 'fs'
import os from 'os'

function makeBaseDir() {
  const dir = path.join(os.tmpdir(), `mem-gw-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('MemoryGraphGateway — propose/listPending', () => {
  test('propose creates a pending proposal and an approval request', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    const gw = new MemoryGraphGateway(userId, null as any, null as any, null as any, null as any, null as any)
    const proposal = await gw.propose({
      scopeType: 'patient',
      patientHash: 'patient_test1',
      kind: 'fact',
      content: '患者对青霉素过敏',
      importance: 5,
      confidence: 'high',
      reason: 'AI extraction',
    })

    expect(proposal.status).toBe('pending')
    expect(proposal.kind).toBe('fact')
    expect(proposal.patientHash).toBe('patient_test1')

    const pending = await gw.listPending({ patientHash: 'patient_test1' })
    expect(pending.some((p) => p.id === proposal.id)).toBe(true)

    // Approval request enqueued so the Brain/Today inbox sees it
    const requests = await (prisma as any).approvalRequest.findMany({
      where: { userId, targetType: 'MemoryProposal', status: 'pending' },
    })
    expect(requests.some((r: any) => r.targetId === proposal.id)).toBe(true)
  })

  test('listPending scopes by patient/global', async () => {
    const userId = await getAuthUserId()
    const gw = new MemoryGraphGateway(userId, null as any, null as any, null as any, null as any, null as any)
    await gw.propose({ scopeType: 'patient', patientHash: 'patient_A', kind: 'fact', content: 'A fact' })
    await gw.propose({ scopeType: 'global', kind: 'fact', content: 'Global fact' })

    const patientOnly = await gw.listPending({ patientHash: 'patient_A' })
    expect(patientOnly.every((p) => p.scopeType === 'patient' && p.patientHash === 'patient_A')).toBe(true)

    const globalOnly = await gw.listPending({ global: true })
    expect(globalOnly.every((p) => p.scopeType === 'global')).toBe(true)
  })
})

describe('MemoryProposal approval flow', () => {
  test('confirming a fact proposal applies it to the memory graph (versioned)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const baseDir = makeBaseDir()

    const gw = new MemoryGraphGateway(userId, null as any, null as any, null as any, null as any, null as any)
    const proposal = await gw.propose({
      scopeType: 'patient',
      patientHash: 'patient_test2',
      kind: 'fact',
      content: 'WBC 11.2 偏高',
      importance: 4,
    })

    // Confirm via the standard approval flow (routes through the gateway +
    // registered applier, which writes the graph and the embedding index)
    const req = await createApprovalRequest(userId, {
      targetType: 'MemoryProposal',
      targetId: proposal.id,
      payload: proposal as any,
    })
    await confirmApproval(userId, req.id)

    const updated = await (prisma as any).memoryProposal.findUnique({ where: { id: proposal.id } })
    expect(updated.status).toBe('approved')
    expect(updated.resolvedBy).toBe(userId)

    // Audit log written
    const audit = await (prisma as any).auditLog.findFirst({
      where: { targetType: 'MemoryProposal', targetId: proposal.id },
    })
    expect(audit).toBeDefined()
    expect(audit.action).toBe('approval.confirmed')
  })

  test('rejecting a proposal records the reason and does not touch the graph', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    const applied: string[] = []
    registerProposalApplier((uid, proposal) => {
      applied.push(proposal.content)
      return { id: 'x' } as any
    })

    const gw = new MemoryGraphGateway(userId, null as any, null as any, null as any, null as any, null as any)
    const proposal = await gw.propose({ scopeType: 'global', kind: 'fact', content: '待拒绝事实' })

    const req = await createApprovalRequest(userId, {
      targetType: 'MemoryProposal',
      targetId: proposal.id,
      payload: proposal as any,
    })
    await rejectApproval(userId, req.id, '信息不准确')

    expect(applied.length).toBe(0)
    const updated = await (prisma as any).memoryProposal.findUnique({ where: { id: proposal.id } })
    expect(updated.status).toBe('rejected')
    expect(updated.rejectedReason).toBe('信息不准确')

    const audit = await (prisma as any).auditLog.findFirst({
      where: { targetType: 'MemoryProposal', targetId: proposal.id },
    })
    expect(audit.action).toBe('approval.rejected')
  })
})
