import prisma from '../../common/prisma.js'
import { resolvePermission, type PermissionRule } from '../../common/permission.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('knowledge')

export type ApprovalTargetType = 'MedicalRecordEntry' | 'MemoryProposal' | 'Skill' | 'Persona' | 'Fact' | 'ResearchRule'

export interface ApprovalRequestInput {
  targetType: ApprovalTargetType
  targetId: string
  payload: Record<string, any>
  diff?: Record<string, any>
}

/** Load enabled permission rules, most specific last (later wins). */
export async function listPermissionRules(): Promise<PermissionRule[]> {
  try {
    const rows = await (prisma as any).approvalRule.findMany({
      where: { enabled: 1 },
      orderBy: { priority: 'asc' },
    })
    return rows.map((r: any) => ({
      id: r.id,
      action: r.action,
      resource: r.resource,
      effect: r.effect,
      role: r.role,
      priority: r.priority,
    }))
  } catch {
    // approval_rules table may not exist in older databases
    return []
  }
}

/**
 * #105: decide whether an approval request is auto-allowed / denied by the
 * configured rules, or must go through the review queue.
 *   allow → the request never enters the queue (auto-approved)
 *   deny  → the request is rejected outright
 *   ask   → pending review (default when no rule matches)
 */
export async function decideApproval(
  userId: string,
  role: string,
  action: string,
  resource: string,
): Promise<'allow' | 'deny' | 'ask'> {
  const rules = await listPermissionRules()
  if (rules.length === 0) return 'ask'
  return resolvePermission(rules, { userId, role, action, resource })
}

export async function createApprovalRequest(
  userId: string,
  input: ApprovalRequestInput,
) {
  const now = new Date().toISOString()
  // #105: rule-based auto decision before anything enters the queue.
  const decision = await decideApproval(userId, 'doctor', 'approve', input.targetType)
  if (decision === 'allow') {
    return { status: 'auto_allowed', targetType: input.targetType, targetId: input.targetId }
  }
  if (decision === 'deny') {
    return { status: 'auto_denied', targetType: input.targetType, targetId: input.targetId }
  }
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

/**
 * 13.4D — auto-archive stale pending proposals:
 *  - summaries (episode_summary / compaction_summary) and low-importance
 *    facts (<= 2) pending for > 7 days are archived (hidden from the queue,
 *    not deleted — a manual reject/approve still works via API).
 *  - high-importance facts (>= 4) stay pending (pinned, surfaced as
 *    "待关注" by the frontend from createdAt).
 * Runs lazily on every pending list (cheap updateMany) — no scheduler needed.
 */
export async function archiveStaleProposals(): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
  const stale = await (prisma as any).memoryProposal.findMany({
    where: { status: 'pending', archivedAt: null, createdAt: { lt: sevenDaysAgo } },
  })
  let archived = 0
  for (const p of stale) {
    const autoArchive = p.kind !== 'fact' || (p.importance ?? 3) <= 2
    if (!autoArchive) continue
    await (prisma as any).memoryProposal.update({
      where: { id: p.id },
      data: { archivedAt: new Date().toISOString() },
    })
    archived++
  }
  return archived
}

/**
 * #794: pending approvals are user-scoped by default for everyone (admin
 * included — the inbox must never mix tenants). Cross-user visibility is an
 * explicit API opt-in: `scopeAll=true`, which the router only sets for admin
 * callers passing ?scope=all.
 */
export async function listPendingApprovals(userId: string, targetType?: string, scopeAll = false) {
  // Lazy archival keeps the queue current without a background job —
  // awaited so the returned list is always post-archival.
  try {
    await archiveStaleProposals()
  } catch {
    // archival is best-effort; listing must not fail
  }

  const where: any = { status: 'pending', userId }
  if (scopeAll) delete where.userId
  if (targetType) where.targetType = targetType
  const rows = await (prisma as any).approvalRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  // Exclude archived MemoryProposals (the outer request has no archive flag).
  const proposalRows = rows.filter((r: any) => r.targetType === 'MemoryProposal')
  const archivedIds = new Set<string>()
  if (proposalRows.length > 0) {
    const archived = await (prisma as any).memoryProposal.findMany({
      where: { id: { in: proposalRows.map((r: any) => r.targetId) }, archivedAt: { not: null } },
      select: { id: true },
    })
    for (const a of archived) archivedIds.add(a.id)
  }
  return rows
    .filter((r: any) => !(r.targetType === 'MemoryProposal' && archivedIds.has(r.targetId)))
    .map(serializeApproval)
}

export async function confirmApproval(userId: string, id: string) {
  // #794: writes are always owner-scoped — no admin bypass. An approval may
  // only be resolved by the user whose context produced it.
  const where: any = { id, status: 'pending', userId }
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

export async function rejectApproval(userId: string, id: string, reason: string | null) {
  // Reason is OPTIONAL — rejecting without a note is allowed.
  // #794: owner-scoped like confirmApproval.
  const where: any = { id, status: 'pending', userId }
  const req = await (prisma as any).approvalRequest.findFirst({ where })
  if (!req) throw new Error('Approval request not found')

  const now = new Date().toISOString()

  await applyTargetUpdate(req.targetType, req.targetId, { status: 'rejected', rejectedReason: reason || null }, userId, now)

  const updated = await (prisma as any).approvalRequest.update({
    where: { id },
    data: { status: 'rejected', actorId: userId, reason: reason || null, resolvedAt: now },
  })

  await writeAuditLog({
    actor: userId,
    action: 'approval.rejected',
    targetType: req.targetType,
    targetId: req.targetId,
    before: { status: 'pending_review' },
    after: { status: 'rejected', rejectedReason: reason || null },
    reason: reason || undefined,
    createdAt: now,
  })

  return serializeApproval(updated)
}

async function applyProposalViaGateway(userId: string, row: any): Promise<any> {
  // #679: resolve the per-user memory via the registry hook (registered by
  // user-context.ts) instead of importing the chat module — removes the
  // approvals ↔ user-context import cycle.
  const { getContextResolver } = await import('../../memory/registry.js')
  const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
  const ctx = getContextResolver()?.(userId)
  if (!ctx) return null
  const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.episodes)
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
    category: row.category,
    conflictsWith: row.conflictsWith,
    status: row.status,
    rejectedReason: row.rejectedReason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  }
  const node = await gateway.applyApproved(proposal)
  // K4: once a fact is confirmed, check whether a new knowledge summary can
  // be synthesized from >= 3 unused confirmed facts of the same category.
  if (node && row.kind === 'fact') {
    const { maybeSynthesizeSummary } = await import('../../memory/knowledge-synthesis.js')
    maybeSynthesizeSummary(userId, { patientHash: row.patientHash || undefined, studyId: row.studyId || undefined }, ctx.memory)
      .catch((err: Error) => log.info('[KNOWLEDGE] Summary check skipped:', err.message.slice(0, 120)))
  }
  return node
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

    // Summaries are context memory, not graph nodes: approving records the
    // human verdict on the content without a graph write (the applier only
    // supports fact/summary).
    if (row.kind === 'episode_summary' || row.kind === 'compaction_summary') {
      await (prisma as any).memoryProposal.update({
        where: { id: targetId },
        data: { status: 'approved', resolvedAt: now, resolvedBy: actorId },
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

/**
 * #794: audit reads are actor-scoped by default for everyone. Two fixes:
 *  - the old `if (filters.actor)` OVERWROTE the forced self-scope, so any
 *    user could read another user's audit log via ?actor=<victim>;
 *  - admins now also default to their own feed, with cross-user visibility
 *    only behind the explicit `?scope=all` opt-in (router gates on role).
 */
export async function listAuditLogs(filters: { targetType?: string; targetId?: string; actor?: string; scope?: string }, viewerUserId?: string, isAdmin = false) {
  const seeAll = isAdmin && filters.scope === 'all'
  const where: any = {}
  if (!seeAll) {
    if (viewerUserId) where.actor = viewerUserId
  } else if (filters.actor) {
    where.actor = filters.actor
  }
  if (filters.targetType) where.targetType = filters.targetType
  if (filters.targetId) where.targetId = filters.targetId
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
