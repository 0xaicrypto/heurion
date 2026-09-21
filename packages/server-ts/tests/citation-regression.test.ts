/**
 * #1082（epic #1084 总验收锁）— 引用重构核心承诺的跨链路回归测试。
 *
 * 覆盖承诺（在 #1076-#1079 未实施部分的边界内）：
 * C1 序号正确：正文增删引用后编号按首现顺序连续（三处消费方共用
 *    contracts.assignCitationNumbers 单一实现 — 编号算法单点锁定）。
 * C2 列表自动/数据一致：DocCitation 是唯一事实源 — 导出与诊断从同一表读取。
 * C3 DOI 强制：任何写入路径无 DOI 即拒绝（store 层双锁）。
 * C4 材料池隔离：参考材料池（ReferenceItem/DocReference）永远进不了
 *    DocCitation — 正文引用其内容不改变悬挂判定。
 * C5 并发：同 DOI 并发插入只落一行（幂等），编号不冲突。
 * 全链路五环节（insert_citation 工具/在线渲染节点/References 列表 UI）依赖
 * 未实施的子 issue（#1076/#1077/#1078/#1079）——其落地后在本套件补齐对应用例。
 */
import { describe, test, expect, beforeEach } from 'vitest'
import prisma from '../src/common/prisma.js'
import { assignCitationNumbers, resolveCitationShortcodes, isValidDoi, CITATION_DANGLING_PLACEHOLDER } from '@heurion/contracts'
import {
  resolveOrCreateDocCitation,
  listDocCitations,
  serializeDocCitation,
  findDanglingCitationIds,
  resolveBodyCitations,
  buildReferencesSection,
} from '../src/lib/citation-store.js'
import { stripLegacyReferencesSection, hasCiteShortcode } from '../src/lib/asset-content.js'

const DOC = 'doc_cit_regression'

async function ensureDocFixture() {
  const now = new Date().toISOString()
  await prisma.user.upsert({
    where: { id: 'u_cit_test' },
    update: {},
    create: { id: 'u_cit_test', displayName: 'cit-test-user', createdAt: now, updatedAt: now },
  })
  await prisma.doc.upsert({
    where: { id: DOC },
    update: {},
    create: { id: DOC, userId: 'u_cit_test', title: 'regression doc', body: '', createdAt: now, updatedAt: now },
  })
}

describe('#1082 C1 — 序号始终连续正确（增删引用回归）', () => {
  test('删除中间引用后，正文编号重排仍连续（首现顺序语义）', () => {
    const body = 'A [cite:c1] B [cite:c2] C [cite:c3]'
    expect([...assignCitationNumbers(body).entries()]).toEqual([['c1', 1], ['c2', 2], ['c3', 3]])
    // c2 被移除（正文不再引用）→ c3 升为 2，序号连续
    const afterRemoval = 'A [cite:c1] C [cite:c3]'
    expect([...assignCitationNumbers(afterRemoval).values()]).toEqual([1, 2])
  })

  test('乱序插入引用（编号随首现顺序，与书写顺序无关）', () => {
    const body = 'B [cite:c2] A [cite:c1] B [cite:c2]'
    expect([...assignCitationNumbers(body).entries()]).toEqual([['c2', 1], ['c1', 2]])
    // 与导出解析结果交叉一致（同一实现）
    const { text } = resolveCitationShortcodes(body, new Set(['c1', 'c2']))
    expect(text).toBe('B [1] A [2] B [1]')
  })
})

describe('#1082 C3 — DOI 强制校验（任何入口不可绕过）', () => {
  beforeEach(async () => {
    await prisma.docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('无 DOI / 非法 DOI 在 store 层拒绝（创建端点尚未存在 — 工具层 #1076 落地后同样复用此锁）', async () => {
    await expect(resolveOrCreateDocCitation({ docId: DOC, doi: '', title: 'x', authors: [], source: 'pubmed' })).rejects.toThrow(/invalid doi/)
    await expect(resolveOrCreateDocCitation({ docId: DOC, doi: 'not-a-doi', title: 'x', authors: [], source: 'crossref' })).rejects.toThrow(/invalid doi/)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
    expect(isValidDoi('10.1234/ok')).toBe(true)
  })

  test('并发插入同一 DOI → 单行幂等（编号不冲突）', async () => {
    const input = { docId: DOC, doi: '10.1000/race.1', title: 'race', authors: ['A'], source: 'crossref' as const }
    const rows = await Promise.all([
      resolveOrCreateDocCitation(input),
      resolveOrCreateDocCitation(input),
      resolveOrCreateDocCitation(input),
    ])
    const ids = new Set(rows.map((r) => r.id))
    expect(ids.size).toBe(1)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(1)
  })
})

describe('#1082 C4 — 参考材料池与正式引用架构隔离', () => {
  beforeEach(async () => {
    await prisma.docCitation.deleteMany({ where: { docId: DOC } })
    await prisma.docReference.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('上传材料（ReferenceItem/DocReference）在库 ≠ 可引用 — 正文仍判悬挂', async () => {
    const now = new Date().toISOString()
    await prisma.referenceItem.create({ data: { id: `refitem_${Date.now()}`, userId: 'u_cit_test', kind: 'file', label: 'uploaded.pdf', snapshot: '上传的 PDF 内容', createdAt: now, updatedAt: now } })
    await prisma.docReference.create({ data: { id: `dref_${Date.now()}`, docId: DOC, userId: 'u_cit_test', refType: 'file', targetId: 'f1', snapshot: 'uploaded content', createdAt: now } })
    // 材料池有内容，但正文引用标记没有 DocCitation → 悬挂（材料池不兜底）
    const dangling = await findDanglingCitationIds(DOC, '正文 [cite:cite_uploaded]')
    expect(dangling).toEqual(['cite_uploaded'])
    expect(await listDocCitations(DOC)).toHaveLength(0)
  })
})

describe('#1082 C2/C5 — 导出边界与数据源一致 + 悬挂可见', () => {
  beforeEach(async () => {
    await prisma.docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('导出解析与库内容一致：已知 → [n]，悬挂 → [?]（不静默丢弃内部 ID）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/reg.1', title: 'R1', authors: [], source: 'crossref' })
    const out = await resolveBodyCitations(DOC, `X [cite:${c1.id}] Y [cite:cite_lost]`)
    expect(out).toBe('X [1] Y [?]')
    expect(out).not.toContain('cite_ghost')
    expect(CITATION_DANGLING_PLACEHOLDER).toBe('[?]')
  })

  test('多引用混合（已知 + 悬挂）编号独立成立（新机制混跑存量形态）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/reg.2', title: 'R1', authors: [], source: 'crossref' })
    const c2 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/reg.3', title: 'R2', authors: [], source: 'pubmed' })
    const body = `旧形态 [cite:${c2.id}] 新形态 [cite:${c1.id}] 混合 [cite:${c1.id}]`
    const dangling = await findDanglingCitationIds(DOC, body)
    expect(dangling).toEqual([])
    const out = await resolveBodyCitations(DOC, body)
    expect(out).toBe('旧形态 [1] 新形态 [2] 混合 [2]')
  })
})

/**
 * #1078 — 导出边界自动 References：给定 DocCitation 行 + 带 [cite:] 标记的
 * 正文，组合 helper（stripLegacyReferencesSection + buildReferencesSection，
 * 编号取 contracts.assignCitationNumbers 对【strip 前正文】的计算）产出
 * 按正文首现排序、携带 DOI 的 References 节 — 导出工具（insert-asset-export）
 * 的执行面按同一顺序调用这三个纯函数。
 */
describe('#1078 — 导出自动 References（编号=首现序 + DOI）', () => {
  beforeEach(async () => {
    await prisma.docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('正文标记 → References 按首现编号排列，条目携带 DOI 与作者/期刊/年份', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/reg.a', title: 'Alpha study', authors: ['Zhang S', 'Li Q'], journal: 'Nature Medicine', year: 2024, source: 'pubmed' })
    const c2 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/reg.b', title: 'Beta study', authors: [], source: 'crossref' })
    // c2 在正文中首现早于 c1 — 编号必须跟随正文顺序而非入库顺序
    const body = `引言 [cite:${c2.id}]；讨论 [cite:${c1.id}]。`

    const numbers = assignCitationNumbers(body)
    const references = buildReferencesSection((await listDocCitations(DOC)).map(serializeDocCitation), numbers)
    expect(references.startsWith('## References')).toBe(true)
    const entries = references.split('\n').filter((l) => /^\d+\./.test(l))
    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain(`1. Beta study. doi: ${c2.doi}`)
    expect(entries[1]).toContain(`2. Zhang S, Li Q. Alpha study. Nature Medicine. 2024. doi: ${c1.doi}`)

    // 导出执行面同序组合：先剥遗留手写节，再追加生成节
    const legacyBody = `${body}\n\n## References\n[1] 旧手写条目. 2019.`
    const hasCitations = hasCiteShortcode(legacyBody)
    const resolved = await resolveBodyCitations(DOC, legacyBody)
    const exported = hasCitations
      ? `${stripLegacyReferencesSection(resolved).replace(/\s+$/, '')}\n\n${references}\n`
      : resolved
    expect(exported).not.toContain('旧手写条目')
    expect(exported).toContain('## References')
    expect(exported).toContain('doi: 10.1000/reg.a')
    expect(exported).toContain('引言 [1]；讨论 [2]。')
  })
})
