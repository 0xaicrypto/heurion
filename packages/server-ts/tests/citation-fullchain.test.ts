/**
 * #1082（epic #1084 总验收锁）— 全链路交叉场景回归：insert_citation →
 * 正文标记 → 编号 → References 列表 → 导出烘焙，五个环节数据一致。
 *
 * 链路组成（各环节的独立测试在各自文件）：
 *   insert_citation 工具（#1076）→ citation-store（#1083）→ contracts 编号
 *   （#1077/#1078/#1099 单一实现）→ 导出边界 strip+烘焙（#1078）。
 * 本文件锁定"同一份正文跑全链，各环节编号/列表一致"的不变量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import prisma from '../src/common/prisma.js'
import { InsertCitationTool, resetInsertCitationState } from '../src/tools/insert-citation-tool.js'
import type { ToolContext } from '../src/tools/tool-registry.js'
import { assignCitationNumbers, resolveCitationShortcodes } from '@heurion/contracts'
import { resolveBodyCitations, buildReferencesSection, serializeDocCitation } from '../src/lib/citation-store.js'
import { stripLegacyReferencesSection } from '../src/lib/asset-content.js'

const DOC = 'doc_1082fc0a1b2c3d4e'
const SESSION = `doc-${DOC}`

function makeCtx(): ToolContext {
  return { userId: 'u_cit_test', sessionId: SESSION } as unknown as ToolContext
}

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
    create: { id: DOC, userId: 'u_cit_test', title: 'fullchain doc', body: '', createdAt: now, updatedAt: now },
  })
}

const ESEARCH = JSON.stringify({ esearchresult: { idlist: ['111', '222'] } })
const ESUMMARY = JSON.stringify({
  result: {
    111: { title: 'First real study', authors: [{ name: 'Zhang S' }], fulljournalname: 'Nature', pubdate: '2020 Jan', volume: '1', pages: '1-9', summaryids: [{ idtype: 'doi', value: '10.1000/fc.1' }] },
    222: { title: 'Second real study', authors: [{ name: 'Li Q' }, { name: 'Wang W' }], fulljournalname: 'Science', pubdate: '2021 Mar', volume: '2', pages: '10-20', summaryids: [{ idtype: 'doi', value: '10.1000/fc.2' }] },
  },
})

beforeEach(async () => {
  resetInsertCitationState()
  await prisma.docCitation.deleteMany({ where: { docId: DOC } })
  await ensureDocFixture()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetInsertCitationState()
})

describe('#1082 全链路：insert_citation → 正文 → 编号 → 列表 → 导出', () => {
  it('五环节编号/取数一致：正文顺序 → 导出 [n] + References 列表同序 + 悬挂可见', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const tool = new InsertCitationTool(makeCtx())
    // ① insert_citation 两次（选第一条 → fc.1；换 query 拿第二条 — esummary 顺序取首个）
    const r1 = await tool.execute({ query: 'first real study' })
    expect(r1.success).toBe(true)
    const a = JSON.parse(String(r1.output))
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ esearchresult: { idlist: ['222'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY, { status: 200 }))
    const r2 = await tool.execute({ query: 'second real study' })
    expect(r2.success).toBe(true)
    const b = JSON.parse(String(r2.output))

    // ② AI 把标记写进正文（模拟 edit_document 落地后的 body）
    const body = `背景引用 A [cite:${a.citation_id}]，方法引用 B [cite:${b.citation_id}]，复引 A [cite:${a.citation_id}]。`
    await prisma.doc.update({ where: { id: DOC }, data: { body } })

    // ③ 在线编号（web 渲染同一 contracts 实现）
    const numbers = assignCitationNumbers(body)
    expect(numbers.get(a.citation_id)).toBe(1)
    expect(numbers.get(b.citation_id)).toBe(2)

    // ⑤ 导出边界 — shortcode → [n]（与 resolveBodyCitations 同一实现）
    const exportBody = await resolveBodyCitations(DOC, body)
    expect(exportBody).toBe('背景引用 A [1]，方法引用 B [2]，复引 A [1]。')
    expect(exportBody).not.toContain('[cite:')

    const citations = (await prisma.docCitation.findMany({ where: { docId: DOC } })).map(serializeDocCitation)
    // 无手写 References 区 → strip no-op；烘焙列表与正文编号同序
    const stripped = stripLegacyReferencesSection(exportBody)
    expect(stripped).toBe(exportBody)
    const section = buildReferencesSection(citations, numbers)
    expect(section).toContain('## References')
    expect(section.indexOf('First real study')).toBeLessThan(section.indexOf('Second real study'))
    expect(section).toContain('doi: 10.1000/fc.1')
    expect(section).toContain('doi: 10.1000/fc.2')
    const entryLines = section.split('\n').filter((l) => /^\d+\.\s/.test(l.trim()))
    expect(entryLines).toHaveLength(2)
  })

  it('删除正文中间引用标记后：编号重排连续 + 列表条目随之消失（列表=派生视图）', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const tool = new InsertCitationTool(makeCtx())
    const r1 = await tool.execute({ query: 'first real study' })
    const a = JSON.parse(String(r1.output)) as { citation_id: string }
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ esearchresult: { idlist: ['222'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY, { status: 200 }))
    const r2 = await tool.execute({ query: 'second real study' })
    const b = JSON.parse(String(r2.output)) as { citation_id: string }

    // 初始：两篇都被引用 → 列表 2 条
    let body = `A [cite:${a.citation_id}] B [cite:${b.citation_id}]`
    const citationsOf = async () => prisma.docCitation.findMany({ where: { docId: DOC } }).then((rows) => rows.map(serializeDocCitation))
    const listCountOf = async (b2: string) => buildReferencesSection(await citationsOf(), assignCitationNumbers(b2)).match(/^\d+\.\s/gm)?.length ?? 0
    expect(await listCountOf(body)).toBe(2)
    // 删除 B 的唯一标记 → 列表只剩 A（编号也归 1）
    body = `A [cite:${a.citation_id}]`
    const numbers = assignCitationNumbers(body)
    expect(numbers.get(a.citation_id)).toBe(1)
    const section = buildReferencesSection(await citationsOf(), numbers)
    expect(section).toContain('First real study')
    expect(section).not.toContain('Second real study')
  })

  it('悬挂标记在任何环节可见：诊断 API、导出占位、列表跳过（互不吞并）', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const tool = new InsertCitationTool(makeCtx())
    const r = await tool.execute({ query: 'first real study' })
    const a = JSON.parse(String(r.output)) as { citation_id: string }
    const body = `A [cite:${a.citation_id}] 悬挂 [cite:cite_ghost]`
    // 导出：已知 → [1]，悬挂 → [?] 占位（不静默丢内部 ID）
    const out = await resolveBodyCitations(DOC, body)
    expect(out).toBe('A [1] 悬挂 [?]')
    expect(out).not.toContain('cite_ghost')
    // 编号表含悬挂位（web 徽标 [?] 同判据）
    expect(assignCitationNumbers(body).has('cite_ghost')).toBe(true)
    // 列表：悬挂无记录 → 不出现
    const citations = await prisma.docCitation.findMany({ where: { docId: DOC } }).then((rows) => rows.map(serializeDocCitation))
    const section = buildReferencesSection(citations, assignCitationNumbers(body))
    expect(section).toContain('First real study')
    expect(section).not.toContain('ghost')
  })
})
