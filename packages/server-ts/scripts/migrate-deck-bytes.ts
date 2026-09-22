#!/usr/bin/env node
/**
 * #1101（pptx 字节单一标准）— 存量 deck 一次性迁移 CLI（幂等，dry-run 支持）。
 *
 * 用法（在 packages/server-ts 下执行）：
 *   node --import tsx scripts/migrate-deck-bytes.ts --doc-id <id> [--dry-run]
 *
 * Doc.deck（DeckWire JSON）→ serializeDeckWireToPptx（pptx-viewer-core
 * Presentation builder — 服务端无 worker 平台，不走 worker generatePptx 管线）
 * → FileIndex 工件 + 重建投影（pptx-extractor）→ Doc.deckArtifactId。
 *
 * 幂等：已有 deckArtifactId 且工件可读 → 跳过；工件行缺失/盘上文件丢失
 * → 重建。dry-run 只打印计划不落库。沿用 #1080 迁移脚本形态（逐篇执行）。
 */
import prisma from '../src/common/prisma.js'
import { serializeDeckWireToPptx, putDeckArtifact, getDeckArtifact } from '../src/lib/deck-bytes.js'

async function main() {
  const args = process.argv.slice(2)
  const docIdIdx = args.indexOf('--doc-id')
  const docId = docIdIdx !== -1 ? args[docIdIdx + 1] : undefined
  const dryRun = args.includes('--dry-run')

  if (!docId) {
    console.error('Usage: node --import tsx scripts/migrate-deck-bytes.ts --doc-id <id> [--dry-run]')
    console.error('  批量：先用 SQL 列出 deck 非空且 deck_artifact_id 为空的 doc id，再逐篇执行。')
    process.exit(2)
  }

  const doc = await prisma.doc.findFirst({ where: { id: docId } })
  if (!doc) {
    console.error(`Document not found: ${docId}`)
    process.exit(1)
  }
  if (!doc.deck) {
    console.log(JSON.stringify({ docId, status: 'skipped', reason: 'Doc.deck 为空（无 DeckWire 可迁移）' }, null, 2))
    return
  }

  // 幂等：工件指针已在且工件可读 → 跳过。
  const existing = await getDeckArtifact(docId)
  if (existing) {
    console.log(JSON.stringify({ docId, status: 'skipped', artifactId: existing.artifactId, bytes: existing.bytes.length }, null, 2))
    return
  }

  let deckWire: unknown
  try {
    deckWire = JSON.parse(doc.deck)
  } catch {
    console.error(`Doc.deck 非法 JSON：${docId}（保留原值，跳过 — 手工处理）`)
    process.exit(1)
  }

  try {
    const bytes = await serializeDeckWireToPptx(deckWire)
    if (dryRun) {
      console.log(JSON.stringify({ docId, status: 'dry-run', title: doc.title, wouldSerializeBytes: bytes.length, note: '序列化器 = pptx-viewer-core（迁移/回退；标题占位语义见 DECK_PPTX_SINGLE_STANDARD §3.2）' }, null, 2))
      return
    }
    const put = await putDeckArtifact({
      userId: doc.userId,
      docId,
      bytes,
      baseDeck: doc.deck,
      writeSource: 'human',
      snapshotLabel: 'deck bytes (migration)',
    })
    if (put.conflict || put.error) {
      console.error(`迁移冲突/失败：${put.error}`)
      process.exit(1)
    }
    console.log(JSON.stringify({ docId, status: 'migrated', artifactId: put.artifactId, bytes: bytes.length, projectionRebuilt: Boolean(put.projection) }, null, 2))
  } catch (err) {
    console.error(`序列化失败：${(err as Error).message.slice(0, 300)}`)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
