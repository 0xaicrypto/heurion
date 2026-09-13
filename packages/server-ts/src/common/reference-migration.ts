/**
 * #1005（SECOND_BRAIN Phase 0）— DocReference → ReferenceItem/SessionReference
 * 一次性回填迁移（幂等，best-effort）。
 *
 * 与 kb-rename-migration.ts 同纪律：启动时执行，失败不阻塞启动；所有写入
 * 走确定性 ID + upsert，重复执行 / 中途失败重跑都安全。
 *
 * 幂等策略：ReferenceItem/SessionReference 的 id 由内容/会话确定性派生，
 * 已迁移的行重复处理只会命中 upsert 读回；每批次先查已有 sessionReference
 * 跳过，避免每次都做 FileIndex/Summary 解析。
 */
import prisma from './prisma.js'
import { makeLogger } from './logger.js'
import {
  addSessionReference,
  docSessionId,
  legacyRefToItemInput,
  referenceIdentityKey,
  referenceItemId,
  sessionReferenceId,
  type ReferenceItemInput,
  type GuidelineClassifier,
} from '../lib/reference-store.js'

const log = makeLogger('migrate.reference')

const BATCH = 500

export async function ensureReferenceMigration(
  opts: { classifyGuideline?: GuidelineClassifier } = {},
): Promise<void> {
  const startedAt = Date.now()
  try {
    const total = await prisma.docReference.count().catch(() => 0)
    if (total === 0) return
    const stats = { total: 0, migrated: 0, skipped: 0, kindFile: 0, kindKb: 0, kindPasted: 0, targetIdPresent: 0, failed: 0 }
    let offset = 0
    // 因 skip/take 分页在无删除的旧表上稳定；每行先查确定性 sessionReference
    // 是否已存在（PK 查询）→ 已迁移行只多一次索引读，重复启动/中途失败重跑
    // 都不会重复写。
    for (;;) {
      const rows = await prisma.docReference.findMany({
        orderBy: { id: 'asc' },
        skip: offset,
        take: BATCH,
        select: { id: true, docId: true, userId: true, refType: true, targetId: true, snapshot: true, sourceNodes: true, createdAt: true },
      })
      if (rows.length === 0) break
      offset += rows.length
      for (const row of rows) {
        stats.total++
        try {
          await migrateRow(row, stats, opts)
        } catch (err) {
          stats.failed++
          log.warn('reference row migration failed (skipped)', { id: row.id, err: String(err).slice(0, 160) })
        }
      }
    }
    log.info(`reference migration done in ${Date.now() - startedAt}ms: ${JSON.stringify(stats)}`)
  } catch (err) {
    log.warn('reference migration skipped (best-effort):', (err as Error).message.slice(0, 160))
  }
}

async function migrateRow(
  row: { id: string; docId: string; userId: string; refType: string; targetId: string; snapshot: string; sourceNodes: string; createdAt: string },
  stats: { migrated: number; skipped: number; kindFile: number; kindKb: number; kindPasted: number; targetIdPresent: number },
  opts: { classifyGuideline?: GuidelineClassifier },
): Promise<void> {
  let label = ''
  try { label = String(JSON.parse(row.sourceNodes || '{}').label || '') } catch { /* ignore */ }
  const input: ReferenceItemInput = await legacyRefToItemInput(row.userId, {
    refType: row.refType, targetId: row.targetId, snapshot: row.snapshot, label,
  }, opts)
  const sessionId = docSessionId(row.docId)
  const itemId = referenceItemId(row.userId, referenceIdentityKey(input))
  const srId = sessionReferenceId(sessionId, itemId)
  const exists = await prisma.sessionReference.findUnique({ where: { id: srId }, select: { id: true } })
  if (exists) {
    stats.skipped++
    return
  }
  await addSessionReference({ userId: row.userId, sessionId, item: input, source: 'manual', addedAt: row.createdAt })
  stats.migrated++
  if (input.kind === 'file') stats.kindFile++
  else if (input.kind === 'kb_summary') stats.kindKb++
  else stats.kindPasted++
  if (String(row.targetId || '').trim()) stats.targetIdPresent++
}
