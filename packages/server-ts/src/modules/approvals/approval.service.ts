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
    const rows = await prisma.approvalRule.findMany({
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
  // #845: institution scope 的 skill 提案不受 allow 规则自动放行 —
  // 跨主体数据流动必须机构管理员逐条显式确认,规则引擎只对 personal 生效。
  const payload: any = input.payload
  const institutionSkill = input.targetType === 'MemoryProposal'
    && (payload?.skillCard?.scope === 'institution'
      // 未渲染卡片的调用方(直接传 proposal 行)— 从 payload JSON 兜底识别
      || (typeof payload?.payload === 'string' && payload.payload.includes('"scope":"institution"')))
  // #105: rule-based auto decision before anything enters the queue.
  const decision = institutionSkill ? 'ask' : await decideApproval(userId, 'doctor', 'approve', input.targetType)
  if (decision === 'allow') {
    return { status: 'auto_allowed', targetType: input.targetType, targetId: input.targetId }
  }
  if (decision === 'deny') {
    return { status: 'auto_denied', targetType: input.targetType, targetId: input.targetId }
  }
  return await prisma.approvalRequest.create({
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
  const stale = await prisma.memoryProposal.findMany({
    where: { status: 'pending', archivedAt: null, createdAt: { lt: sevenDaysAgo } },
  })
  let archived = 0
  for (const p of stale) {
    const autoArchive = p.kind !== 'fact' || (p.importance ?? 3) <= 2
    if (!autoArchive) continue
    await prisma.memoryProposal.update({
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
  const rows = await prisma.approvalRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  // Exclude archived MemoryProposals (the outer request has no archive flag).
  const proposalRows = rows.filter((r: any) => r.targetType === 'MemoryProposal')
  const archivedIds = new Set<string>()
  if (proposalRows.length > 0) {
    const archived = await prisma.memoryProposal.findMany({
      where: { id: { in: proposalRows.map((r: any) => r.targetId) }, archivedAt: { not: null } },
      select: { id: true },
    })
    for (const a of archived) archivedIds.add(a.id)
  }

  const serialized = rows
    .filter((r: any) => !(r.targetType === 'MemoryProposal' && archivedIds.has(r.targetId)))
    .map(serializeApproval)
  await enrichProposalProvenance(serialized)
  return serialized
}

/**
 * #836-followup: 提案溯源 — 收件箱此前只有 raw reason 文本,用户无法看出
 * 内容由哪些文档/会话而来。分两类:
 *  - summary 提案:relatedFacts(stableId)→ fact 节点 → provenance.sourceRef
 *    (file: → DocumentNode.name;session: → Session.title;历史事实的
 *    sourceRef 是创建它的 proposal id,回查 memoryProposal 行兜底)。
 *  - fact 提案:sourceRange `session:<id>`(压缩/会话提取)→ Session.title,
 *    供前端按会话聚合;`file:` 前端已有分组逻辑,不在此处理。
 * 全程 best-effort:任何解析失败都只让字段缺失,绝不阻塞审批列表。
 */
async function enrichProposalProvenance(serialized: Array<Record<string, any>>): Promise<void> {
  const summaryRows = serialized.filter(
    (r) => r.targetType === 'MemoryProposal' && r.payload && (r.payload.kind === 'summary' || r.payload.kind === 'article'),
  )
  const sessionFactRows = serialized.filter(
    (r) => r.targetType === 'MemoryProposal' && r.payload?.kind === 'fact' && typeof r.payload.sourceRange === 'string' && r.payload.sourceRange.startsWith('session:'),
  )
  if (summaryRows.length === 0 && sessionFactRows.length === 0) return

  const byUser = new Map<string, Array<Record<string, any>>>()
  const bucket = (userId: string, row: Record<string, any>) => {
    const list = byUser.get(userId)
    if (list) list.push(row)
    else byUser.set(userId, [row])
  }
  for (const r of summaryRows) {
    const ids = parseRelatedFactIds(r.payload.relatedFacts)
    if (ids.length > 0) bucket(r.userId, r)
  }
  for (const r of sessionFactRows) bucket(r.userId, r)
  if (byUser.size === 0) return

  const { getContextResolver } = await import('../../memory/registry.js')
  for (const [ownerId, rows] of byUser) {
    try {
      const ctx = getContextResolver()?.(ownerId)
      if (!ctx?.memory) continue
      const documents = (ctx.memory.graph.getCurrentNodesByType('document') as any[]) ?? []
      const docNameByFileId = new Map<string, string>()
      for (const d of documents) {
        if (d?.fileId && d?.name) docNameByFileId.set(d.fileId, d.name)
      }
      const sessionTitle = await makeSessionTitleResolver()
      // 历史事实:sourceRef = 创建它的 memoryProposal id → 查原始行拿文件信息。
      const originCache = new Map<string, { fileId: string | null; fileName: string | null; sessionId: string | null }>()
      const resolveOrigin = async (ref: string) => {
        const cached = originCache.get(ref)
        if (cached) return cached
        const out = { fileId: null as string | null, fileName: null as string | null, sessionId: null as string | null }
        try {
          const mp = await prisma.memoryProposal.findFirst({
            where: { id: ref },
            select: { sourceRange: true, reason: true },
          })
          if (mp?.sourceRange?.startsWith('file:')) {
            out.fileId = mp.sourceRange.slice('file:'.length).split('#')[0]
          }
          if (mp?.sourceRange?.startsWith('session:')) {
            // #836-followup: session:<id>#<quote> — 引号证据附加在 '#' 之后,
            // 会话标题解析只取 id 部分(sessionId 永不含 '#')。
            out.sessionId = mp.sourceRange.slice('session:'.length).split('#')[0]
          }
          const m = mp?.reason?.match(/^extracted from file (.+)$/)
          if (m) out.fileName = m[1]
        } catch {
          // lookup failure → origin stays unknown
        }
        originCache.set(ref, out)
        return out
      }
      const sessionRefLabel = async (sessionId: string): Promise<string> => {
        const title = await sessionTitle(sessionId)
        return title || `会话 ${sessionId.slice(-8)}`
      }

      for (const row of rows) {
        const payload = row.payload
        if (payload.kind === 'fact') {
          const sessionId = String(payload.sourceRange).slice('session:'.length)
          payload.sourceSession = await sessionRefLabel(sessionId)
          continue
        }
        // summary 提案溯源
        const factIds = parseRelatedFactIds(payload.relatedFacts)
        if (factIds.length === 0) continue
        const sourceFacts: Array<{ stableId: string; content: string; sourceDocument?: string; sourceSession?: string }> = []
        const docNames = new Set<string>()
        const sessionTitles = new Set<string>()
        for (const stableId of factIds.slice(0, 10)) {
          const node = ctx.memory.graph.getLatestByStableId(stableId) as any
          if (!node || node.type !== 'fact') continue
          const ref: string | undefined = node.provenance?.sourceRef
          let fileId: string | null = null
          let fileName: string | null = null
          let refSessionId: string | null = null
          if (ref?.startsWith('file:')) {
            fileId = ref.slice('file:'.length).split('#')[0]
          } else if (ref?.startsWith('session:')) {
            refSessionId = ref.slice('session:'.length).split('#')[0]
          } else if (ref && !ref.startsWith('doc_')) {
            const origin = await resolveOrigin(ref)
            fileId = origin.fileId
            fileName = origin.fileName
            refSessionId = origin.sessionId
          }
          const docName = (fileId && (docNameByFileId.get(fileId) ?? null)) || fileName || null
          const sessionLabel = refSessionId ? await sessionRefLabel(refSessionId) : null
          if (docName) docNames.add(docName)
          if (sessionLabel) sessionTitles.add(sessionLabel)
          sourceFacts.push({
            stableId,
            content: String(node.content || '').slice(0, 120),
            ...(docName ? { sourceDocument: docName } : {}),
            ...(sessionLabel ? { sourceSession: sessionLabel } : {}),
          })
        }
        if (sourceFacts.length > 0) {
          row.payload = {
            ...payload,
            sourceFacts,
            ...(docNames.size > 0 ? { sourceDocuments: Array.from(docNames) } : {}),
            ...(sessionTitles.size > 0 ? { sourceSessions: Array.from(sessionTitles) } : {}),
          }
        }
      }
    } catch (err) {
      log.info('proposal provenance enrichment skipped', { reason: (err as Error).message.slice(0, 120) })
    }
  }
}

function parseRelatedFactIds(raw: unknown): string[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** sessionId → 会话标题(带缓存;查不到回退 null,由调用方拼兜底标签)。 */
async function makeSessionTitleResolver(): Promise<(sessionId: string) => Promise<string | null>> {
  const cache = new Map<string, string | null>()
  return async (sessionId: string) => {
    if (cache.has(sessionId)) return cache.get(sessionId)!
    let title: string | null = null
    try {
      const s = await prisma.session.findFirst({
        where: { id: sessionId },
        select: { title: true },
      })
      title = typeof s?.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 60) : null
    } catch {
      // lookup failure → fallback label
    }
    cache.set(sessionId, title)
    return title
  }
}

export async function confirmApproval(userId: string, id: string) {
  // #794: writes are always owner-scoped — no admin bypass. An approval may
  // only be resolved by the user whose context produced it.
  const where: any = { id, status: 'pending', userId }
  const req = await prisma.approvalRequest.findFirst({ where })
  if (!req) throw new Error('Approval request not found')

  const now = new Date().toISOString()

  await applyTargetUpdate(req.targetType, req.targetId, { status: 'confirmed' }, userId, now)

  const updated = await prisma.approvalRequest.update({
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
  const req = await prisma.approvalRequest.findFirst({ where })
  if (!req) throw new Error('Approval request not found')

  const now = new Date().toISOString()

  await applyTargetUpdate(req.targetType, req.targetId, { status: 'rejected', rejectedReason: reason || null }, userId, now)

  const updated = await prisma.approvalRequest.update({
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
    payload: row.payload ?? null,
  }
  const node = await gateway.applyApproved(proposal)
  // #839: 自动研究(gap-research)产出的 fact 提案带 `gap:<gapId>` 溯源 —
  // 研究时 gap 已在 Prisma 侧 resolve,图谱 fact 要等审批通过才落图;
  // 这里补挂图谱 gap 节点与已确认事实的关联(best-effort,gap 可能只存在于 Prisma)。
  const gapId = typeof row.sourceRange === 'string' && row.sourceRange.startsWith('gap:')
    ? row.sourceRange.slice('gap:'.length)
    : null
  if (node && row.kind === 'fact' && gapId) {
    try {
      ctx.memory.answerGap(gapId, node)
    } catch (err) {
      log.info('[APPROVAL] gap link skipped:', (err as Error).message.slice(0, 120))
    }
  }
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
    await prisma.medicalRecordEntry.update({
      where: { id: targetId },
      data,
    })
    return
  }
  if (targetType === 'MemoryProposal') {
    const row = await prisma.memoryProposal.findFirst({
      where: { id: targetId },
    })
    if (!row) throw new Error('Memory proposal not found')

    // Rejection path: record the reason, do not touch the graph.
    if (updates.status === 'rejected') {
      await prisma.memoryProposal.update({
        where: { id: targetId },
        data: { status: 'rejected', rejectedReason: updates.rejectedReason, resolvedAt: now, resolvedBy: actorId },
      })
      return
    }

    // Summaries are context memory, not graph nodes: approving records the
    // human verdict on the content without a graph write (the applier only
    // supports fact/summary).
    if (row.kind === 'episode_summary' || row.kind === 'compaction_summary') {
      await prisma.memoryProposal.update({
        where: { id: targetId },
        data: { status: 'approved', resolvedAt: now, resolvedBy: actorId },
      })
      return
    }

    // #845: skill 提案 scope 判定 — institution(跨医生共享=跨主体数据流动)
    // 需机构管理员显式逐条确认;确认者非 admin 直接拒绝落图。
    if (row.kind === 'skill' && row.payload) {
      try {
        const scope = JSON.parse(row.payload)?.skill?.scope
        if (scope === 'institution') {
          const actor = await prisma.user.findUnique({ where: { id: actorId } })
          if (actor?.role !== 'admin') {
            throw new Error('institution scope 提案需机构管理员确认 — 当前确认者无管理员权限')
          }
        }
      } catch (err) {
        if ((err as Error).message.includes('institution scope')) throw err
        // payload 解析失败不阻塞(scope 缺省按 personal)
      }
    }

    const node = await applyProposalViaGateway(row.userId, row)
    if (!node) throw new Error('Memory proposal could not be applied')

    // #845 确认语义(D6,与迁移一致):capture 来源的 skill 提案通过后,
    // CapturedSkill 原行标 promoted 纯归档(stableId=skill_cap_<capturedId>)。
    if (row.kind === 'skill' && node && typeof (node as any).stableId === 'string'
      && (node as any).stableId.startsWith('skill_cap_')) {
      const capturedId = (node as any).stableId.slice('skill_cap_'.length)
      await prisma.capturedSkill.updateMany({
        where: { id: capturedId, userId: row.userId, status: { not: 'promoted' } },
        data: { status: 'promoted', updatedAt: now },
      }).catch(() => { /* 行可能已被清理 — best-effort */ })
    }

    await prisma.memoryProposal.update({
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
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  const entryIds = rows
    .filter((r: any) => r.targetType === 'MedicalRecordEntry')
    .map((r: any) => r.targetId)
  const entries = entryIds.length > 0
    ? await prisma.medicalRecordEntry.findMany({
        where: { id: { in: entryIds } },
        select: { id: true, patientHash: true, title: true, type: true },
      })
    : []
  const entryByTarget = new Map(entries.map((e: any) => [e.id, e]))

  const proposalIds = rows
    .filter((r: any) => r.targetType === 'MemoryProposal')
    .map((r: any) => r.targetId)
  const proposals = proposalIds.length > 0
    ? await prisma.memoryProposal.findMany({
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
  await prisma.auditLog.create({
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
