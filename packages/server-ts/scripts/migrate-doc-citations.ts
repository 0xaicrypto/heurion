#!/usr/bin/env node
/**
 * #1080/#1084（epic）— 存量文档参考文献迁移 CLI（best-effort）。
 *
 * 用法（在 packages/server-ts 下执行）：
 *   node --import tsx scripts/migrate-doc-citations.ts --doc-id <id> [--dry-run]
 *
 * - 解析优先级：条目含 DOI → 直接使用；仅 PMID → PubMed 反查；仅标题 → Crossref 检索确认。
 * - 命中阈值不够（标题相似度低）不强匹配 → 「⚠ 待复核」保留原文，不静默丢弃。
 * - 幂等：重复执行不重复建行、不重复替换。
 */
import { migrateDocCitations, applyDocCitationMigration } from '../src/lib/citation-migration.js'
import prisma from '../src/common/prisma.js'

async function main() {
  const args = process.argv.slice(2)
  const docIdIdx = args.indexOf('--doc-id')
  const docId = docIdIdx !== -1 ? args[docIdIdx + 1] : undefined
  const dryRun = args.includes('--dry-run')

  if (!docId) {
    console.error('Usage: node --import tsx scripts/migrate-doc-citations.ts --doc-id <id> [--dry-run]')
    console.error('  批量：先用 SQL 列出候选 doc id，再逐篇执行。')
    process.exit(2)
  }

  const plan = dryRun
    ? (await migrateDocCitations(docId, { dryRun: true })).plan
    : await applyDocCitationMigration(docId)

  console.log(JSON.stringify(plan, null, 2))
  const pendingNote = plan.pending.length > 0 ? `\n⚠ ${plan.pending.length} 条待人工复核（原文已保留并打标）` : ''
  console.log(`${dryRun ? '[dry-run] ' : ''}resolved=${plan.resolved.length} replacements=${plan.replacements} pending=${plan.pending.length}${pendingNote}`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
