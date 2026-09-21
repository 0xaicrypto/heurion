import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import prisma from '../../src/common/prisma.js'
import { InsertCitationTool, resetInsertCitationState } from '../../src/tools/insert-citation-tool.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'

/**
 * #1076 — insert_citation: 正式引用（DocCitation）唯一写入工具。
 * 1. 带 DOI 命中 → DocCitation 落库 + output 含 [cite:id] 标记
 * 2. 全部候选无 DOI → no_doi_found，零落库，禁止编造
 * 3. 同 query/DOI 两次 → 同一 citation_id（幂等，count=1）
 * 4. 架构隔离：源文件零 DocReference/ReferenceItem/SessionReference 池引用
 * 5. PubMed 命中优先 — Crossref 不被调用
 */

const DOC = 'doc_1076a1b2c3d4e5f6'
const SESSION = `doc-${DOC}`

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return { userId: 'u_cit_test', sessionId: SESSION, ...over } as unknown as ToolContext
}

async function ensureDocFixture() {
  const now = new Date().toISOString()
  await (prisma as any).user.upsert({
    where: { id: 'u_cit_test' },
    update: {},
    create: { id: 'u_cit_test', displayName: 'cit-test-user', createdAt: now, updatedAt: now },
  })
  await (prisma as any).doc.upsert({
    where: { id: DOC },
    update: {},
    create: { id: DOC, userId: 'u_cit_test', title: 'insert test doc', body: '', createdAt: now, updatedAt: now },
  })
}

const ESEARCH = JSON.stringify({ esearchresult: { idlist: ['111'] } })
const ESUMMARY_WITH_DOI = JSON.stringify({
  result: {
    111: { title: 'FLASH radiotherapy trial.', authors: [{ name: 'A' }], fulljournalname: 'Nature', pubdate: '2024 Jan', volume: '1', pages: '1-9', summaryids: [{ idtype: 'doi', value: '10.1000/ins.1' }] },
  },
})
const ESUMMARY_NO_DOI = JSON.stringify({
  result: {
    111: { title: 'Carbon ion FLASH review.', authors: [{ name: 'B' }], fulljournalname: 'Radiother Oncol', pubdate: '2023 Mar', summaryids: [] },
  },
})
const CROSSREF_WITH_DOI = JSON.stringify({
  message: {
    items: [{
      DOI: '10.1000/ins.2',
      title: ['A preprint on FLASH radiotherapy'],
      author: [{ family: 'Wang', given: 'L' }],
      'container-title': ['bioRxiv'],
      issued: { 'date-parts': [[2025]] },
    }],
  },
})

describe('#1076 insert_citation', () => {
  const fetchSpy = vi.fn()

  beforeEach(async () => {
    resetInsertCitationState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    delete process.env.NCBI_API_KEY
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetInsertCitationState()
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
  })

  it('用例1: PubMed 带 DOI 命中 → DocCitation 落库 + output 含 [cite:id] 标记', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY_WITH_DOI, { status: 200 }))
    const tool = new InsertCitationTool(makeCtx())
    const r = await tool.execute({ query: 'FLASH proton radiotherapy' })
    expect(r.success, String(r.error)).toBe(true)
    const parsed = JSON.parse(String(r.output))
    expect(parsed.doi).toBe('10.1000/ins.1')
    expect(parsed.citation_id).toMatch(/^cite_/)
    expect(parsed.source).toBe('pubmed')
    expect(parsed.pmid).toBe('111')
    expect(parsed.title).toContain('FLASH radiotherapy trial')
    // 模型必须学到的标记：字面 [cite:<id>]
    expect(String(r.output)).toContain(`[cite:${parsed.citation_id}]`)
    const rows = await prisma.docCitation.findMany({ where: { docId: DOC } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(parsed.citation_id)
    expect(rows[0].source).toBe('pubmed')
  })

  it('用例2: 全部候选无 DOI → no_doi_found，零落库，不返回无 DOI 结果', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY_NO_DOI, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })) // crossref 空
    const tool = new InsertCitationTool(makeCtx())
    const r = await tool.execute({ query: 'carbon ion review' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('no_doi_found')
    expect(String(r.error)).toContain('未创建')
    expect(String(r.output ?? '')).not.toContain('[cite:')
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
  })

  it('用例3: 同 query/DOI 两次 → 同一 citation_id，count 1（幂等复用）', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).includes('esearch')) return new Response(ESEARCH, { status: 200 })
      return new Response(ESUMMARY_WITH_DOI, { status: 200 })
    })
    const tool = new InsertCitationTool(makeCtx())
    const r1 = await tool.execute({ query: 'FLASH proton radiotherapy' })
    const r2 = await tool.execute({ query: 'FLASH proton radiotherapy' })
    const p1 = JSON.parse(String(r1.output))
    const p2 = JSON.parse(String(r2.output))
    expect(p2.citation_id).toBe(p1.citation_id)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(1)
  })

  it('用例4: 架构隔离 — 源文件零参考材料池（DocReference/ReferenceItem/SessionReference）token', () => {
    const src = readFileSync(new URL('../../src/tools/insert-citation-tool.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('DocReference')
    expect(src).not.toContain('ReferenceItem')
    expect(src).not.toContain('SessionReference')
  })

  it('用例5: PubMed 带命中时 Crossref 永不被调用（PubMed 优先）', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY_WITH_DOI, { status: 200 }))
    const tool = new InsertCitationTool(makeCtx())
    const r = await tool.execute({ query: 'FLASH proton radiotherapy' })
    expect(r.success).toBe(true)
    const crossrefCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('crossref'))
    expect(crossrefCalls).toHaveLength(0)
  })

  it('PubMed 无 DOI 命中 → Crossref 补获（source=crossref）', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).includes('eutils')) {
        if (String(url).includes('esearch')) return new Response(ESEARCH, { status: 200 })
        return new Response(ESUMMARY_NO_DOI, { status: 200 })
      }
      return new Response(CROSSREF_WITH_DOI, { status: 200 })
    })
    const tool = new InsertCitationTool(makeCtx())
    const r = await tool.execute({ query: 'FLASH preprint' })
    expect(r.success, String(r.error)).toBe(true)
    const parsed = JSON.parse(String(r.output))
    expect(parsed.source).toBe('crossref')
    expect(parsed.doi).toBe('10.1000/ins.2')
  })

  it('非 doc- 会话 → 明确拒绝', async () => {
    const tool = new InsertCitationTool(makeCtx({ sessionId: 'session_test' }))
    const r = await tool.execute({ query: 'anything' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('insert_citation requires a document session')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
