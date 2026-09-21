import { describe, test, expect, beforeEach } from 'vitest'
import prisma from '../../src/common/prisma.js'
import {
  resolveOrCreateDocCitation,
  stripCitationMarkers,
  listDocCitations,
  getDocCitation,
  deleteDocCitation,
  findDanglingCitationIds,
  docCitationId,
  serializeDocCitation,
} from '../../src/lib/citation-store.js'
import { isValidDoi, assignCitationNumbers, resolveCitationShortcodes, CITATION_DANGLING_PLACEHOLDER } from '@heurion/contracts'

/**
 * #1083 — 结构化引用数据模型 DocCitation + DOI 必填约束:
 * 1. 不带 doi/非法 doi → 校验失败拒绝创建
 * 2. 合法创建 → 落库完整可查
 * 3. 同 doc 同 DOI 重复插入 → 幂等读回（不重复建行）
 * 4. contracts isValidDoi / 编号算法单测
 */

const DOC = 'doc_cit_test'

/** FK 依赖：DocCitation.doc → Doc → User。用例数据用后即删。 */
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
    create: { id: DOC, userId: 'u_cit_test', title: 'cit test doc', body: '', createdAt: now, updatedAt: now },
  })
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    docId: DOC,
    doi: '10.1000/j.heurion.2026.001',
    title: 'A structured citation model',
    authors: ['Zhang S', 'Li Q'],
    journal: 'Heurion Journal',
    year: 2026,
    source: 'pubmed' as const,
    ...over,
  }
}

describe('#1083 DocCitation 数据模型 + DOI 必填', () => {
  beforeEach(async () => {
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('用例1: doi 缺失/空 → 拒绝创建', async () => {
    await expect(resolveOrCreateDocCitation(baseInput({ doi: '' }))).rejects.toThrow(/invalid doi/)
    await expect(resolveOrCreateDocCitation(baseInput({ doi: undefined as unknown as string }))).rejects.toThrow(/invalid doi/)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
  })

  test('用例2: doi 格式非法（无 10. 前缀）→ 拒绝创建', async () => {
    await expect(resolveOrCreateDocCitation(baseInput({ doi: 'doi:10.1000/x' }))).rejects.toThrow(/invalid doi/)
    await expect(resolveOrCreateDocCitation(baseInput({ doi: '11.1000/x' }))).rejects.toThrow(/invalid doi/)
    await expect(resolveOrCreateDocCitation(baseInput({ doi: '10.abc/x' }))).rejects.toThrow(/invalid doi/)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(0)
  })

  test('用例3: 同 doc 重复插入同一 DOI → 幂等读回，不重复建行', async () => {
    const first = await resolveOrCreateDocCitation(baseInput())
    const second = await resolveOrCreateDocCitation(baseInput())
    expect(second.id).toBe(first.id)
    expect(await prisma.docCitation.count({ where: { docId: DOC } })).toBe(1)
  })

  test('用例4: 正常创建 → 字段完整，按 docId 可查，序列化 authors 为数组', async () => {
    const row = await resolveOrCreateDocCitation(baseInput())
    expect(row.id).toBe(docCitationId(DOC, '10.1000/j.heurion.2026.001'))
    expect(row.doi).toBe('10.1000/j.heurion.2026.001')
    expect(row.source).toBe('pubmed')
    const listed = await listDocCitations(DOC)
    expect(listed).toHaveLength(1)
    const ser = serializeDocCitation(listed[0])
    expect(ser.authors).toEqual(['Zhang S', 'Li Q'])
    expect(ser.title).toBe('A structured citation model')
    // 跨 doc 隔离
    expect(await listDocCitations('doc_other')).toHaveLength(0)
    expect(await getDocCitation('doc_other', row.id)).toBeNull()
    const fetched = await getDocCitation(DOC, row.id)
    expect(fetched?.doi).toBe(row.doi)
    // 删除
    expect(await deleteDocCitation(DOC, row.id)).toBe(true)
    expect(await deleteDocCitation(DOC, row.id)).toBe(false)
  })
})

describe('#1083 contracts: isValidDoi + 编号算法', () => {
  test('isValidDoi 覆盖合法/非法格式', () => {
    expect(isValidDoi('10.1000/abc.def')).toBe(true)
    expect(isValidDoi('10.1234/978-3-16-148410-0')).toBe(true)
    expect(isValidDoi(' 10.1000/x ')).toBe(true) // trim 容忍
    expect(isValidDoi('')).toBe(false)
    expect(isValidDoi('10.1000')).toBe(false)
    expect(isValidDoi('9.1000/x')).toBe(false)
    expect(isValidDoi('10.x/y')).toBe(false)
    expect(isValidDoi('random text')).toBe(false)
  })

  test('assignCitationNumbers: 按首现顺序编号，同 id 共享编号', () => {
    const body = 'A [cite:c2] B [cite:c1] C [cite:c2] D'
    const numbers = assignCitationNumbers(body)
    expect(numbers.get('c2')).toBe(1)
    expect(numbers.get('c1')).toBe(2)
    expect(numbers.size).toBe(2)
  })

  test('resolveCitationShortcodes: 已知 id → [n]，悬挂 id → [?] 占位', () => {
    const body = 'A [cite:c1] B [cite:c2] C [cite:c1]'
    const { text, dangling } = resolveCitationShortcodes(body, new Set(['c1']))
    expect(text).toBe('A [1] B [?] C [1]')
    expect(dangling).toEqual(['c2'])
    expect(CITATION_DANGLING_PLACEHOLDER).toBe('[?]')
  })
})

describe('#1081 悬挂引用检测（citation-store.findDanglingCitationIds）', () => {
  beforeEach(async () => {
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('正文 shortcode 中未知 id 被识别为悬挂', async () => {
    const known = await resolveOrCreateDocCitation(baseInput())
    const dangling = await findDanglingCitationIds(DOC, `A [cite:${known.id}] B [cite:cite_ghost]`)
    expect(dangling).toEqual(['cite_ghost'])
    expect(await findDanglingCitationIds(DOC, 'no shortcode here')).toEqual([])
  })
})

describe('复审轮 4 P2 — stripCitationMarkers 边界语义（与旧正则 \\s*\\[cite:id\\] 等价）', () => {
  const cases: Array<{ in: string; want: string; note: string }> = [
    { in: 'A [cite:g] B', want: 'A B', note: '行中标记 — 吸收前置空格' },
    { in: 'A\n[cite:g]\nB', want: 'A\nB', note: '独占一行 — 不留空行（回归：split 只 trim [ \\t] 的 P2 缺陷）' },
    { in: '[cite:g] 开头', want: ' 开头', note: '行首标记（无前置空白）' },
    { in: '结尾 [cite:g]', want: '结尾', note: '行尾标记' },
    { in: 'A [cite:g][cite:g] B', want: 'A B', note: '相邻连续标记逐位吸收' },
    { in: 'A  \n  [cite:g] B', want: 'A B', note: '多行前置空白吸收' },
    { in: 'A\n\n[cite:g]\nB', want: 'A\nB', note: '前置空行吸收（不留双空行）' },
    { in: '无标记文本', want: '无标记文本', note: '无标记直通' },
  ]
  for (const c of cases) {
    test(c.note, () => {
      expect(stripCitationMarkers(c.in, 'g')).toBe(c.want)
    })
  }
})
