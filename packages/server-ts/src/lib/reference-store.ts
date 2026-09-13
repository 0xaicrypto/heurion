/**
 * #1005（SECOND_BRAIN Phase 0）— 引用材料两层模型的唯一读写入口。
 *
 * 模型（设计文档 4.4）：
 *   ReferenceItem  用户级内容池（一份内容只存一次，跨会话复用）
 *   SessionReference  会话级挂载（'doc-<docId>' / 主 chat sessionId）
 *
 * 本阶段的纪律（迁移方案 SECONDBRAIN_PHASE0_MIGRATION.md）：
 *   - 与旧 `DocReference` 并行（写路径双写），读路径在 #1006 前保持旧表；
 *   - 确定性 ID（ref_/sr_ + sha1 前 16 位）→ 回填/双写天然幂等；
 *   - 取消引用只删 SessionReference，绝不删 ReferenceItem 本体。
 */
import { createHash } from 'crypto'
import prisma from '../common/prisma.js'


export type ReferenceKind = 'file' | 'kb_summary' | 'pasted_text'
export type SessionReferenceSource = 'manual' | 'suggestion_accepted'

export interface ReferenceItemInput {
  userId: string
  kind: ReferenceKind
  /** file → FileIndex.id；kb_summary → Summary stableId；pasted_text → null。 */
  sourceRef?: string | null
  label?: string
  snapshot?: string
}

export interface ReferenceItemRow {
  id: string
  userId: string
  kind: string
  sourceRef: string | null
  label: string
  snapshot: string
  createdAt: string
  updatedAt: string
}

export interface SessionReferenceRow {
  sessionReferenceId: string
  referenceId: string
  sessionId: string
  userId: string
  addedAt: string
  source: string
  item: ReferenceItemRow
}

function sha16(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16)
}

/** 写作会话 sessionId 约定（与 TURN_INTENT_DESIGN.md 的 doc- 前缀一致）。 */
export function docSessionId(docId: string): string {
  return `doc-${docId}`
}

/** 旧模型 refType → 新 kind 的结构映射（guideline 歧义归类见 classifyLegacyKind）。 */
export function normalizeLegacyRefType(refType: string | null | undefined): ReferenceKind {
  const t = String(refType || '').toLowerCase()
  if (t === 'file' || t === 'pdf' || t === 'docx') return 'file'
  if (t === 'kb_summary' || t === 'kb_article') return 'kb_summary'
  return 'pasted_text' // note / guideline / 未知
}

/**
 * 跨会话去重的稳定 identity key：
 *   file/kb_summary → 来源 id（拿不到时退回 label）；
 *   pasted_text → 正文哈希（同一段粘贴在任何会话只存一份）。
 */
export function referenceIdentityKey(input: Pick<ReferenceItemInput, 'kind' | 'sourceRef' | 'label' | 'snapshot'>): string {
  if (input.kind === 'pasted_text') return `pasted_text|${sha16(String(input.snapshot || ''))}`
  const ref = input.sourceRef ? String(input.sourceRef) : String(input.label || '')
  return `${input.kind}|${ref}`
}

export function referenceItemId(userId: string, identityKey: string): string {
  return `ref_${sha16(`${userId}|${identityKey}`)}`
}

export function sessionReferenceId(sessionId: string, referenceId: string): string {
  return `sr_${sha16(`${sessionId}|${referenceId}`)}`
}

/** 新增/复用 ReferenceItem（确定性 ID + 唯一主键冲突读回，幂等）。 */
export async function resolveOrCreateReferenceItem(input: ReferenceItemInput): Promise<ReferenceItemRow> {
  const identityKey = referenceIdentityKey(input)
  const id = referenceItemId(input.userId, identityKey)
  const existing = await prisma.referenceItem.findUnique({ where: { id } }) as ReferenceItemRow | null
  if (existing) return existing
  const now = new Date().toISOString()
  const data = {
    id,
    userId: input.userId,
    kind: input.kind,
    sourceRef: input.sourceRef ?? null,
    label: input.label ?? '',
    snapshot: input.snapshot ?? '',
    createdAt: now,
    updatedAt: now,
  }
  try {
    return await prisma.referenceItem.create({ data }) as ReferenceItemRow
  } catch {
    // 并发创建/回填重跑：主键冲突 → 读回既有行（幂等）。
    const row = await prisma.referenceItem.findUnique({ where: { id } }) as ReferenceItemRow | null
    if (row) return row
    throw new Error(`reference item upsert failed: ${id}`)
  }
}

/** 挂载到会话（幂等；重复引用同一 item 不产生第二行）。 */
export async function addSessionReference(input: {
  userId: string
  sessionId: string
  item: ReferenceItemInput
  source?: SessionReferenceSource
  addedAt?: string
}): Promise<SessionReferenceRow> {
  const item = await resolveOrCreateReferenceItem(input.item)
  const id = sessionReferenceId(input.sessionId, item.id)
  const existing = await prisma.sessionReference.findUnique({ where: { id }, include: { reference: true } })
  if (existing) {
    return {
      sessionReferenceId: existing.id, referenceId: existing.referenceId,
      sessionId: existing.sessionId, userId: existing.userId,
      addedAt: existing.addedAt, source: existing.source,
      item: existing.reference as ReferenceItemRow,
    }
  }
  const addedAt = input.addedAt ?? new Date().toISOString()
  try {
    const row = await prisma.sessionReference.create({
      data: {
        id,
        sessionId: input.sessionId,
        userId: input.userId,
        referenceId: item.id,
        addedAt,
        source: input.source ?? 'manual',
      },
    })
    return {
      sessionReferenceId: row.id, referenceId: row.referenceId,
      sessionId: row.sessionId, userId: row.userId,
      addedAt: row.addedAt, source: row.source, item,
    }
  } catch {
    const row = await prisma.sessionReference.findUnique({ where: { id }, include: { reference: true } })
    if (row) {
      return {
        sessionReferenceId: row.id, referenceId: row.referenceId,
        sessionId: row.sessionId, userId: row.userId,
        addedAt: row.addedAt, source: row.source,
        item: row.reference as ReferenceItemRow,
      }
    }
    throw new Error(`session reference upsert failed: ${id}`)
  }
}

export async function listSessionReferences(userId: string, sessionId: string): Promise<SessionReferenceRow[]> {
  const rows = await prisma.sessionReference.findMany({
    where: { userId, sessionId },
    include: { reference: true },
    orderBy: { addedAt: 'desc' },
  })
  return rows.map((r) => ({
    sessionReferenceId: r.id, referenceId: r.referenceId,
    sessionId: r.sessionId, userId: r.userId,
    addedAt: r.addedAt, source: r.source,
    item: r.reference as ReferenceItemRow,
  }))
}

/** 取消引用：只删会话挂载（幂等）。 */
export async function removeSessionReference(userId: string, sessionId: string, referenceId: string): Promise<boolean> {
  const res = await prisma.sessionReference.deleteMany({ where: { userId, sessionId, referenceId } })
  return res.count > 0
}

/* ── #1006: 会话读取（新表优先，旧表懒修复回退） ─────────────────── */

export interface SessionReferenceItemView {
  id: string
  kind: ReferenceKind
  sourceRef: string | null
  label: string
  snapshot: string
  addedAt: string
  source: string
}

/**
 * 会话引用材料装载 — 写作/主 chat 注入的唯一取数入口：
 *   1) 新表有挂载 → 直接返回；
 *   2) 新表为空且是 doc- 会话 → 回退旧表（迁移失败/极旧数据），顺带
 *      双写修复（懒迁移），返回新模型视图。
 * 非 doc 会话新表为空 = 确实没有引用，返回 []。
 */
export async function loadSessionReferenceItems(
  userId: string,
  sessionId: string,
  opts: { classifyGuideline?: GuidelineClassifier } = {},
): Promise<SessionReferenceItemView[]> {
  const rows = await listSessionReferences(userId, sessionId)
  if (rows.length > 0) {
    return rows.map((r) => ({
      id: r.item.id,
      kind: normalizeLegacyRefType(r.item.kind),
      sourceRef: r.item.sourceRef,
      label: r.item.label,
      snapshot: r.item.snapshot,
      addedAt: r.addedAt,
      source: r.source,
    }))
  }
  if (!sessionId.startsWith('doc-')) return []
  const docId = sessionId.slice(4)
  const legacy = await prisma.docReference.findMany({ where: { userId, docId }, orderBy: { createdAt: 'asc' } })
  if (legacy.length === 0) return []
  const out: SessionReferenceItemView[] = []
  for (const row of legacy) {
    let label = ''
    try { label = String(JSON.parse(row.sourceNodes || '{}').label || '') } catch { /* ignore */ }
    const legacyLike = { refType: row.refType, targetId: row.targetId, snapshot: row.snapshot, label }
    try {
      await writeThroughLegacyRef(userId, docId, { ...legacyLike, createdAt: row.createdAt }, opts)
    } catch { /* best-effort heal — 失败仍返回旧数据视图 */ }
    const input = await legacyRefToItemInput(userId, legacyLike, opts)
    out.push({
      id: referenceItemId(userId, referenceIdentityKey(input)),
      kind: input.kind,
      sourceRef: input.sourceRef ?? null,
      label: input.label ?? '',
      snapshot: input.snapshot ?? '',
      addedAt: row.createdAt,
      source: 'manual',
    })
  }
  return out
}

/* ── 旧模型 → 新模型的写入映射（迁移 + 双写共用） ───────────────────── */

export interface LegacyRefLike {
  refType?: string | null
  targetId?: string | null
  snapshot?: string | null
  label?: string | null
}

/** FileIndex 真实 id 判定 + 按文件名兜底解析（与 findUploadFileByName 同口径，不引循环依赖）。 */
export async function resolveFileSourceRef(userId: string, targetId: string | null | undefined, fileName: string): Promise<string | null> {
  if (targetId) {
    const byId = await prisma.fileIndex.findFirst({ where: { id: targetId, userId, deletedAt: null } }).catch(() => null)
    if (byId) return byId.id
  }
  if (!fileName.trim()) return null
  const byName = await prisma.fileIndex.findFirst({
    where: { userId, name: fileName, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  return byName?.id ?? null
}

/** guideline 双关归类器（实现放 modules/shared/summary-lookup.ts 注入 — lib 层不反向依赖 modules）。 */
export type GuidelineClassifier = (userId: string, label: string) => Promise<{ kind: ReferenceKind; sourceRef: string | null }>

/**
 * 旧写入形态 → ReferenceItemInput。用于：
 *   - 启动回填（历史行）；
 *   - 写路径双写（新 POST/DELETE 同步新模型）。
 * guideline 走 classifyGuideline 启发式；file 类解析 sourceRef。
 */
export async function legacyRefToItemInput(
  userId: string,
  row: LegacyRefLike,
  opts: { classifyGuideline?: GuidelineClassifier } = {},
): Promise<ReferenceItemInput> {
  const refType = String(row.refType || 'note').toLowerCase()
  const snapshot = String(row.snapshot || '')
  const label = String(row.label || '').trim() || snapshot
  if (refType === 'guideline') {
    const classified = opts.classifyGuideline
      ? await opts.classifyGuideline(userId, label)
      : { kind: 'pasted_text' as const, sourceRef: null }
    return { userId, kind: classified.kind, sourceRef: classified.sourceRef, label, snapshot }
  }
  const kind = normalizeLegacyRefType(refType)
  if (kind === 'file') {
    const sourceRef = await resolveFileSourceRef(userId, row.targetId, snapshot || label)
    return { userId, kind, sourceRef, label, snapshot }
  }
  if (kind === 'kb_summary') {
    return { userId, kind, sourceRef: row.targetId || null, label, snapshot }
  }
  return { userId, kind: 'pasted_text', sourceRef: null, label, snapshot }
}

/** 旧 API DELETE 只有内容没有新 item id — 按内容匹配删除会话挂载（保留 item）。 */
export async function removeSessionReferenceByContent(
  userId: string,
  sessionId: string,
  match: { label?: string; snapshot?: string; sourceRef?: string | null },
): Promise<boolean> {
  const rows = await listSessionReferences(userId, sessionId)
  const bySource = match.sourceRef ? rows.find((r) => r.item.sourceRef && r.item.sourceRef === match.sourceRef) : undefined
  const hit = bySource ?? rows.find((r) => {
    if (match.snapshot && r.item.snapshot && r.item.snapshot === match.snapshot) return true
    return Boolean(match.label) && r.item.label === match.label
  })
  if (!hit) return false
  return removeSessionReference(userId, sessionId, hit.referenceId)
}

/**
 * 旧模型写入 → 新模型双写（Phase 0 过渡：写路径同步，读路径保持旧表）。
 * 失败只降级日志，不影响旧路径与用户响应。
 */
export async function writeThroughLegacyRef(
  userId: string,
  docId: string,
  row: LegacyRefLike & { createdAt?: string | null },
  opts: { classifyGuideline?: GuidelineClassifier } = {},
): Promise<ReferenceItemInput> {
  const input = await legacyRefToItemInput(userId, row, opts)
  await addSessionReference({
    userId,
    sessionId: docSessionId(docId),
    item: input,
    source: 'manual',
    ...(row.createdAt ? { addedAt: row.createdAt } : {}),
  })
  // 返回归类结果 — 调用方（#1014）据此写使用反馈（如 kb_summary → referenced）。
  return input
}
