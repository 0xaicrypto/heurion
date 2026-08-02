import prisma from '../../common/prisma.js'

export type ApprovalTargetType = 'MedicalRecordEntry' | 'MemoryProposal' | 'Skill' | 'Persona' | 'Fact' | 'ResearchRule'

export interface ApprovalRequestInput {
  targetType: ApprovalTargetType
  targetId: string
  payload: Record<string, any>
  diff?: Record<string, any>
}

export async function createApprovalRequest(
  userId: string,
  input: ApprovalRequestInput,
) {
  const now = new Date().toISOString()
  return await (prisma as any).approvalRequest.create({
    data: {
      userId,
      targetType: input.targetType,
      targetId: input.targetId,
      status: 'pending',
      payload: JSON.stringify(input.payload),
      diff: input.diff ? JSON.stringify(input.diff) : null,
      createdAt: now,
    },
  })
}

export async function listPendingApprovals(userId: string, targetType?: string, isAdmin = false) {
  const where: any = { status: 'pending' }
  if (!isAdmin) where.userId = userId
  if (targetType) where.targetType = targetType
  const rows = await (prisma as any).approvalRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(serializeApproval)
}

export async function getApprovalRequest(userId: string, id: string, isAdmin = false) {
  const where: any = { id }
  if (!isAdmin) where.userId = userId
  const row = await (prisma as any).approvalRequest.findFirst({ where })
  return row ? serializeApproval(row) : null
}

export async function confirmApproval(userId: string, id: string, isAdmin = false) {
  const where: any = { id, status: 'pending' }
  if (!isAdmin) where.userId = userId
  const req = await (prisma as any).approvalRequest.findFirst({ where })
  if (!req) throw new Error('Approval request not found')

  const now = new Date().toISOString()

  await applyTargetUpdate(req.targetType, req.targetId, { status: 'confirmed' }, userId, now)

  const updated = await (prisma as any).approvalRequest.update({
    where: { id },
    data: { status: 'approved', actorId: userId, resolvedAt: now },
  })

  await writeAuditLog({
    actor: userId,
    action: 'approval.confirmed',
    targetType: req.targetType,
    targetId: req.targetId,
    before: { status: 'pending_review' },
    after: { status: 'confirmed' },
    reason: undefined,
    createdAt: now,
  })

  return serializeApproval(updated)
}

export async function rejectApproval(userId: string, id: string, reason: string, isAdmin = false) {
  if (!reason) throw new Error('rejectedReason required')
  const where: any = { id, status: 'pending' }
  if (!isAdmin) where.userId = userId
  const req = await (prisma as any).approvalRequest.findFirst({ where })
  if (!req) throw new Error('Approval request not found')

  const now = new Date().toISOString()

  await applyTargetUpdate(req.targetType, req.targetId, { status: 'rejected', rejectedReason: reason }, userId, now)

  const updated = await (prisma as any).approvalRequest.update({
    where: { id },
    data: { status: 'rejected', actorId: userId, reason, resolvedAt: now },
  })

  await writeAuditLog({
    actor: userId,
    action: 'approval.rejected',
    targetType: req.targetType,
    targetId: req.targetId,
    before: { status: 'pending_review' },
    after: { status: 'rejected', rejectedReason: reason },
    reason,
    createdAt: now,
  })

  return serializeApproval(updated)
}

async function applyProposalViaGateway(userId: string, row: any): Promise<any> {
  const { getUserContext } = await import('../chat/user-context.js')
  const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
  const ctx = getUserContext(userId)
  const gateway = new MemoryGraphGateway(
    userId,
    ctx.memory,
    ctx.facts,
    ctx.episodes,
    ctx.skills,
    ctx.knowledge,
  )
  const proposal = {
    id: row.id,
    userId: row.userId,
    scopeType: row.scopeType,
    patientHash: row.patientHash,
    studyId: row.studyId,
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    reason: row.reason,
    sourceRange: row.sourceRange,
    status: row.status,
    rejectedReason: row.rejectedReason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  }
  return gateway.applyApproved(proposal)
}

async function applyTargetUpdate(
  targetType: string,
  targetId: string,
  updates: any,
  actorId: string,
  now: string,
) {
  if (targetType === 'MedicalRecordEntry') {
    const data: any = { ...updates }
    if (data.status === 'confirmed') {
      data.confirmedAt = now
      data.confirmedBy = actorId
    }
    await (prisma as any).medicalRecordEntry.update({
      where: { id: targetId },
      data,
    })
    return
  }
  if (targetType === 'MemoryProposal') {
    const row = await (prisma as any).memoryProposal.findFirst({
      where: { id: targetId },
    })
    if (!row) throw new Error('Memory proposal not found')

    // Rejection path: record the reason, do not touch the graph.
    if (updates.status === 'rejected') {
      await (prisma as any).memoryProposal.update({
        where: { id: targetId },
        data: { status: 'rejected', rejectedReason: updates.rejectedReason, resolvedAt: now, resolvedBy: actorId },
      })
      return
    }

    const node = await applyProposalViaGateway(row.userId, row)
    if (!node) throw new Error('Memory proposal could not be applied')
    await (prisma as any).memoryProposal.update({
      where: { id: targetId },
      data: { status: 'approved', resolvedAt: now, resolvedBy: actorId },
    })
    return
  }
  throw new Error(`Unsupported approval target type: ${targetType}`)
}

export async function listAuditLogs(filters: { targetType?: string; targetId?: string; actor?: string }, viewerUserId?: string, isAdmin = false) {
  const where: any = {}
  if (!isAdmin && viewerUserId) where.actor = viewerUserId
  if (filters.targetType) where.targetType = filters.targetType
  if (filters.targetId) where.targetId = filters.targetId
  if (filters.actor) where.actor = filters.actor
  const rows = await (prisma as any).auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  const entryIds = rows
    .filter((r: any) => r.targetType === 'MedicalRecordEntry')
    .map((r: any) => r.targetId)
  const entries = entryIds.length > 0
    ? await (prisma as any).medicalRecordEntry.findMany({
        where: { id: { in: entryIds } },
        select: { id: true, patientHash: true, title: true, type: true },
      })
    : []
  const entryByTarget = new Map(entries.map((e: any) => [e.id, e]))

  const proposalIds = rows
    .filter((r: any) => r.targetType === 'MemoryProposal')
    .map((r: any) => r.targetId)
  const proposals = proposalIds.length > 0
    ? await (prisma as any).memoryProposal.findMany({
        where: { id: { in: proposalIds } },
        select: { id: true, kind: true, content: true, importance: true, confidence: true },
      })
    : []
  const proposalByTarget = new Map(proposals.map((p: any) => [p.id, p]))

  return rows.map((r: any) => {
    const base: any = {
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
      reason: r.reason,
      createdAt: r.createdAt,
    }
    const entry = entryByTarget.get(r.targetId)
    if (entry) base.entry = entry
    const proposal = proposalByTarget.get(r.targetId)
    if (proposal) base.memoryProposal = proposal
    return base
  })
}

export async function writeAuditLog(entry: {
  actor: string
  action: string
  targetType: string
  targetId: string
  before?: any
  after?: any
  reason?: string
  createdAt: string
}) {
  await (prisma as any).auditLog.create({
    data: {
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before ? JSON.stringify(entry.before) : null,
      after: entry.after ? JSON.stringify(entry.after) : null,
      reason: entry.reason,
      createdAt: entry.createdAt,
    },
  })
}

function serializeApproval(r: any) {
  return {
    id: r.id,
    userId: r.userId,
    targetType: r.targetType,
    targetId: r.targetId,
    status: r.status,
    payload: r.payload ? JSON.parse(r.payload) : null,
    diff: r.diff ? JSON.parse(r.diff) : null,
    reason: r.reason,
    actorId: r.actorId,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  }
}
