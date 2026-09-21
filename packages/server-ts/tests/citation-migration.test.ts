import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import prisma from '../src/common/prisma.js'
import {
  parseReferencesEntries,
  locateReferencesSection,
  extractEntryIdentifiers,
  titleSimilarity,
  migrateDocCitations,
  applyDocCitationMigration,
} from '../src/lib/citation-migration.js'

/**
 * #1080 — 存量文档参考文献迁移（TDD，issue 用例表 5 条）：
 * 1. 条目已含 DOI → 直接入库，正文 [n] 替换为 [cite:id]
 * 2. 仅标题 → Crossref 命中回填 DOI 入库
 * 3. 无命中/相似度不足 → 待复核，原文保留不改动
 * 4. 重复执行 → 幂等（不重复建行/替换）
 * 5. --dry-run → 只出计划不写库
 * 外部反查（Crossref/PubMed）通过 LookupDeps 注入 mock，不真实外呼。
 */

const DOC = 'doc_migrate'

const LEGACY_BODY = `# Title\n\n正文第一段有引用 [1]，第二段也有 [2]。\n\n## Methods\n\n方法段引用 [1] 再次出现。\n\n## References\n\n[1] Zhang S, et al. A great paper. Nature. 2020;1:1-9. doi: 10.1000/mig.1\n[2] Li Q, et al. Another paper. Science. 2021;2:10-20. PMID: 12345678\n`

async function ensureDocFixture(body: string) {
  const now = new Date().toISOString()
  await prisma.user.upsert({
    where: { id: 'u_cit_test' },
    update: {},
    create: { id: 'u_cit_test', displayName: 'cit-test-user', createdAt: now, updatedAt: now },
  })
  await prisma.doc.upsert({
    where: { id: DOC },
    update: { body },
    create: { id: DOC, userId: 'u_cit_test', title: 'migration doc', body, createdAt: now, updatedAt: now },
  })
}

/** 注入式反查：DOI 直解成功 / PMID 反查回填 DOI / 标题检索命中。 */
const fullLookup = {
  resolveByDoi: async (doi: string) => ({
    title: 'A great paper',
    authors: ['Zhang S'],
    journal: 'Nature',
    year: '2020',
    url: `https://doi.org/${doi}`,
  }),
  lookupPmid: async (_pmid: string) => ({
    title: 'Another paper',
    authors: ['Li Q'],
    journal: 'Science',
    year: '2021',
    doi: '10.1000/mig.2',
  }),
  searchTitle: async () => [],
}

beforeEach(async () => {
  await prisma.docCitation.deleteMany({ where: { docId: DOC } })
  await ensureDocFixture(LEGACY_BODY)
})

describe('#1080 迁移解析原语', () => {
  test('References 区定位（标题变体）与条目解析', () => {
    const sec = locateReferencesSection(LEGACY_BODY)
    expect(sec).toBeTruthy()
    expect(sec!.content).toContain('[1] Zhang S')
    const entries = parseReferencesEntries(sec!.content)
    expect(entries.get(1)).toContain('10.1000/mig.1')
    expect(entries.get(2)).toContain('PMID: 12345678')
  })

  test('条目标识符抽取（DOI / PMID 变体）', () => {
    expect(extractEntryIdentifiers('X. doi: 10.1234/abc').doi).toBe('10.1234/abc')
    expect(extractEntryIdentifiers('X. https://doi.org/10.1234/def.').doi).toBe('10.1234/def')
    expect(extractEntryIdentifiers('X. PMID: 12345678').pmid).toBe('12345678')
    expect(extractEntryIdentifiers('no ids here').doi).toBeUndefined()
  })

  test('标题相似度阈值行为', () => {
    expect(titleSimilarity('A great paper about cancer', 'a great paper about cancer')).toBeGreaterThan(0.5)
    expect(titleSimilarity('totally unrelated words', 'A great paper')).toBeLessThan(0.3)
  })
})

describe('#1080 迁移端到端（mock 反查）', () => {
  test('用例1：条目已含 DOI → 直接入库，正文 [n] 替换为 [cite:id]，全成功时移除手写区', async () => {
    const { plan, newBody } = await migrateDocCitations(DOC, { lookup: fullLookup })
    expect(plan.resolved).toHaveLength(2)
    expect(plan.pending).toHaveLength(0)
    expect(plan.replacements).toBe(3) // [1]×2 + [2]×1
    expect(plan.removedSection).toBe(true)
    expect(newBody).toContain('[cite:')
    expect(newBody).not.toContain('## References')
    expect(newBody).not.toMatch(/\[1\]/)
    // 落库校验（DOI 均合法）
    const rows = await prisma.docCitation.findMany({ where: { docId: DOC } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => /^10\./.test(r.doi))).toBe(true)
    // 复审 #7: plan.resolved[].citationId 回填真实 id（此前恒空串，审计无法核对）
    expect(plan.resolved.every((r) => /^cite_/.test(r.citationId))).toBe(true)
    expect(plan.resolved.map((r) => r.citationId).sort()).toEqual(rows.map((r) => r.id).sort())
  })

  test('用例2：仅标题无 DOI → Crossref 命中回填入库', async () => {
    const titleBody = `# T\n\n正文 [1]。\n\n## References\n\n[1] A very unique unresolvable-by-doi paper title\n`
    await prisma.doc.update({ where: { id: DOC }, data: { body: titleBody } })
    const lookup = {
      resolveByDoi: async () => null,
      lookupPmid: async () => null,
      searchTitle: async () => [{ title: 'a very unique unresolvable-by-doi paper title', doi: '10.1000/mig.3', authors: ['Wang W'], journal: 'Cell', year: '2022' }],
    }
    const { plan, newBody } = await migrateDocCitations(DOC, { lookup })
    expect(plan.resolved).toHaveLength(1)
    expect(plan.resolved[0].via).toBe('title')
    expect(newBody).toContain('[cite:')
    expect(await prisma.docCitation.count({ where: { docId: DOC, doi: '10.1000/mig.3' } })).toBe(1)
  })

  test('用例3：检索无命中/相似度不足 → 待复核标记，原文保留不删除', async () => {
    const lookup = {
      resolveByDoi: async () => null,
      lookupPmid: async () => null,
      searchTitle: async () => [{ title: 'completely unrelated other paper', doi: '10.9999/none', authors: [], journal: '', year: '' }],
    }
    const { plan, newBody } = await migrateDocCitations(DOC, { lookup })
    expect(plan.resolved).toHaveLength(0)
    expect(plan.pending).toHaveLength(2)
    // 原文保留 + 待复核标记（不静默丢弃）
    expect(newBody).toContain('## References')
    expect(newBody).toContain('⚠ 待复核：[1] Zhang S')
    expect(newBody).toContain('⚠ 待复核：[2] Li Q')
    expect(newBody).toContain('10.1000/mig.1') // 原始 DOI 文本仍在
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
  })

  test('用例4：重复执行幂等（不重复建行、不重复替换）', async () => {
    await applyDocCitationMigration(DOC, { lookup: fullLookup })
    const countAfterFirst = await prisma.docCitation.count({ where: { docId: DOC } })
    const bodyAfterFirst = (await prisma.doc.findUnique({ where: { id: DOC } }))!.body
    // 第二次：正文已无裸 [n] 引用标记与 References 区 → 零变更
    const { plan } = await migrateDocCitations(DOC, { lookup: fullLookup })
    expect(plan.resolved).toHaveLength(0)
    expect(plan.pending).toHaveLength(0)
    expect(plan.replacements).toBe(0)
    await applyDocCitationMigration(DOC, { lookup: fullLookup })
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(countAfterFirst)
    expect((await prisma.doc.findUnique({ where: { id: DOC } }))!.body).toBe(bodyAfterFirst)
  })

  test('用例5：--dry-run 只出计划不写库不改正文', async () => {
    const { plan, newBody } = await migrateDocCitations(DOC, { dryRun: true, lookup: fullLookup })
    expect(plan.dryRun).toBe(true)
    expect(plan.resolved).toHaveLength(2)
    expect(plan.replacements).toBe(3)
    expect(newBody).toContain('[cite:') // 内存结果含标记
    // 库未变
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
    expect((await prisma.doc.findUnique({ where: { id: DOC } }))!.body).toBe(LEGACY_BODY)
  })

  test('部分解析成功：已解析条目移除，待复核条目保留（数据零丢失）', async () => {
    // DOI 条目成功；PMID 反查记录无 DOI → 待复核
    const lookup = {
      resolveByDoi: fullLookup.resolveByDoi,
      lookupPmid: async () => ({ title: 'Another paper', authors: ['Li Q'], journal: 'Science', year: '2021' }), // 无 doi
      searchTitle: async () => [],
    }
    const { plan, newBody } = await migrateDocCitations(DOC, { lookup })
    expect(plan.resolved).toHaveLength(1)
    expect(plan.pending).toHaveLength(1)
    expect(newBody).toContain('## References')
    expect(newBody).toContain('⚠ 待复核：[2] Li Q')
    expect(newBody).not.toContain('[1] Zhang S') // 已解析条目从手写区移除
    expect(plan.removedSection).toBe(false)
  })
})

afterAll(async () => {
  await prisma.docCitation.deleteMany({ where: { docId: DOC } }).catch(() => {})
  await prisma.doc.deleteMany({ where: { id: DOC } }).catch(() => {})
})
