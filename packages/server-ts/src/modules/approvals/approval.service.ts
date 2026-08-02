import prisma from '../../common/prisma.js'

export type ApprovalTargetType = 'MedicalRecordEntry' | 'Skill' | 'Persona' | 'Fact' | 'ResearchRule'

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

export async function listPendingApprovals(userId: string, targetType?: string) {
  const where: any = { userId, status: 'pending' }
  if (targetType) where.targetType = targetType
  const rows = await (prisma as any).approvalRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(serializeApproval)
}

export async function getApprovalRequest(userId: string, id: string) {
  const row = await (prisma as any).approvalRequest.findFirst({
    where: { id, userId },
  })
  return row ? serializeApproval(row) : null
}

export async function confirmApproval(userId: string, id: string) {
  const req = await (prisma as any).approvalRequest.findFirst({
    where: { id, userId, status: 'pending' },
  })
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

export async function rejectApproval(userId: string, id: string, reason: string) {
  if (!reason) throw new Error('rejectedReason required')
  const req = await (prisma as any).approvalRequest.findFirst({
    where: { id, userId, status: 'pending' },
  })
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
  throw new Error(`Unsupported approval target type: ${targetType}`)
}

export async function listAuditLogs(filters: { targetType?: string; targetId?: string; actor?: string }) {
  const where: any = {}
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
