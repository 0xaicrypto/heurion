import { describe, test, expect, beforeEach } from 'vitest'
import prisma from '../../src/common/prisma.js'
import { resolveOrCreateDocCitation, resolveBodyCitations, resolveDeckContentCitations, listDocCitations, serializeDocCitation, buildReferencesSection, composeExportBody } from '../../src/lib/citation-store.js'
import { stripLegacyReferencesSection } from '../../src/lib/asset-content.js'
import { assignCitationNumbers, CITE_SHORTCODE_PATTERN } from '@heurion/contracts'

/**
 * #1099 — 导出边界引用 shortcode 解析为编号:
 * 1. 正文 2 个不同 shortcode → [1]/[2]（非内部 ID）
 * 2. 同一 citationId 出现 2 次 → 同一编号
 * 3. 悬挂引用 → [?] 占位（不静默消失、不保留内部 ID）
 * 4. deck slides 的 title/bullets/paragraph 文本同样解析
 * 5. 与在线渲染/References 列表共用 contracts.assignCitationNumbers 单一实现
 * （编号算法本身已由 citation-store.test.ts 锁定；此处锁定导出消费端。）
 */

const DOC = 'doc_cit_export'

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
    create: { id: DOC, userId: 'u_cit_test', title: 'export doc', body: '', createdAt: now, updatedAt: now },
  })
}

describe('#1099 导出边界引用 shortcode 解析', () => {
  beforeEach(async () => {
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('正文 2 个不同 shortcode → 首现顺序 [1]/[2]；同 id 复现 → 同编号', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/export.1', title: 'T1', authors: [], source: 'crossref' })
    const c2 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/export.2', title: 'T2', authors: [], source: 'pubmed' })
    const body = `第一句 [cite:${c1.id}]。第二句 [cite:${c2.id}]。复引 [cite:${c1.id}]。`
    const out = await resolveBodyCitations(DOC, body)
    expect(out).toBe('第一句 [1]。第二句 [2]。复引 [1]。')
    expect(out).not.toContain('[cite:')
  })

  test('无 shortcode 的正文零开销直通（无 DB 读也语义一致）', async () => {
    const body = '# 标题\n\n普通段落，无引用。'
    expect(await resolveBodyCitations(DOC, body)).toBe(body)
  })

  test('悬挂引用（无对应 DocCitation）→ [?] 占位，不保留内部 ID', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/export.3', title: 'T3', authors: [], source: 'crossref' })
    const body = `已知 [cite:${c1.id}]；悬挂 [cite:cite_ghost999]；`
    const out = await resolveBodyCitations(DOC, body)
    expect(out).toBe('已知 [1]；悬挂 [?]；')
    expect(out).not.toContain('cite_ghost999')
  })

  test('deck slides：title / bullets / paragraph 文本均解析，悬挂 → [?]', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/export.4', title: 'T4', authors: [], source: 'pubmed' })
    const slides = [
      {
        title: '页一 [cite:cite_ghost1]',
        bullets: [`要点 [cite:${c1.id}]`, '普通要点'],
        content: [{ type: 'paragraph', text: `段落 [cite:${c1.id}] [cite:cite_ghost2]` }, { type: 'image', ref: 'asset://x.png' }],
      },
      { title: '无引用页', bullets: ['b1'], content: [] },
    ]
    const out = await resolveDeckContentCitations(DOC, slides)
    expect(out[0].title).toBe('页一 [?]')
    expect(out[0].bullets).toEqual(['要点 [1]', '普通要点'])
    expect((out[0].content as any)[0].text).toBe('段落 [1] [?]')
    expect((out[0].content as any)[1].type).toBe('image') // 非文本块不动
  })

  test('重复调用幂等（第二次无 shortcode 直通）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/export.5', title: 'T5', authors: [], source: 'crossref' })
    const once = await resolveBodyCitations(DOC, `[cite:${c1.id}]`)
    expect(once).toBe('[1]')
    expect(await resolveBodyCitations(DOC, once)).toBe(once)
  })
})

/**
 * #1078 — 导出边界自动生成 References（纯函数层）：
 * 1. stripLegacyReferencesSection: 遗留手写 References 节剥除/无则原样/heading 变体
 * 2. buildReferencesSection: 编号 = assignCitationNumbers（首现序），条目带 DOI 链接
 * 3. 组合:给定引用 + 正文标记 → 按【strip 前正文】编号生成有序 References
 */
describe('#1078 导出 References — stripLegacyReferencesSection', () => {
  test('存在旧 References 节 → 剥离;同/更高级标题或文末截断', () => {
    const body = [
      '## Intro',
      '正文段落。',
      '',
      '## References',
      '[1] Old A. Title1. J. 2020.',
      '[2] Old B. Title2. N. 2021.',
      '',
      '## Methods',
      '方法内容。',
    ].join('\n')
    const out = stripLegacyReferencesSection(body)
    expect(out).not.toContain('References')
    expect(out).not.toContain('Old A')
    expect(out).toContain('## Intro')
    expect(out).toContain('## Methods')
    expect(out).toContain('方法内容。')
  })

  test('无 References 节 → 原样返回（noop）', () => {
    const body = '## Intro\n正文。\n\n## Methods\n方法。'
    expect(stripLegacyReferencesSection(body)).toBe(body)
    expect(stripLegacyReferencesSection('')).toBe('')
  })

  test('heading 变体: # References / ## 参考文献 / **References** / 大小写', () => {
    for (const heading of ['# References', '## REFERENCES', '## 参考文献', '**References**', '## **References**']) {
      // 后续标题取同级/更高级（# Next）— 同级或更高级标题结束剥除范围。
      const body = `前文。\n\n${heading}\n[1] Old. 2020.\n\n# Next\n后文。`
      const out = stripLegacyReferencesSection(body)
      expect(out, heading).not.toContain('Old. 2020')
      expect(out, heading).toContain('前文。')
      expect(out, heading).toContain('# Next')
      expect(out, heading).toContain('后文。')
    }
    // 下一级标题（## 在 # References 之后）属于 References 子节 → 一并剥除。
    const deeper = '# References\n[1] Old. 2020.\n\n## SubRef\n[2] Old2. 2021.\n\n# Next\n后文。'
    const deeperOut = stripLegacyReferencesSection(deeper)
    expect(deeperOut).not.toContain('Old. 2020')
    expect(deeperOut).not.toContain('Old2. 2021')
    expect(deeperOut).toContain('# Next')
  })

  test('文末 References（无后续标题）→ 剥离到 EOF', () => {
    const body = '## Intro\n正文。\n\n## References\n[1] Old. 2020.'
    const out = stripLegacyReferencesSection(body)
    expect(out).not.toContain('Old. 2020')
    expect(out).toContain('## Intro')
  })

  test('子标题（更下一级）不截断剥除范围', () => {
    const body = '## References\n[1] Old. 2020.\n\n### SubRef\n[2] Old2. 2021.\n\n## Next\n后文。'
    const out = stripLegacyReferencesSection(body)
    expect(out).not.toContain('Old. 2020')
    expect(out).not.toContain('Old2. 2021')
    expect(out).toContain('## Next')
  })
})

describe('#1078 导出 References — buildReferencesSection', () => {
  const citations = [
    { id: 'c1', authors: ['Zhang S', 'Li Q', 'Wang L', 'Chen X'], title: 'Alpha study', journal: 'Nature Medicine', year: 2024, doi: '10.1000/alpha' },
    { id: 'c2', authors: [], title: 'Beta study', journal: null, year: null, doi: '10.1000/beta' },
    { id: 'c3', authors: ['Unrelated'], title: '未在正文引用的行', journal: 'X', year: 2023, doi: '10.1000/gamma' },
  ]

  test('编号按传入 numbers（首现序），条目含作者/标题/期刊/年份/DOI', () => {
    // c2 首现 = 1, c1 首现 = 2（与书写顺序无关）
    const numbers = new Map([['c2', 1], ['c1', 2]])
    const section = buildReferencesSection(citations, numbers)
    expect(section.startsWith('## References')).toBe(true)
    const lines = section.split('\n').filter((l) => /^\d+\./.test(l))
    expect(lines).toHaveLength(2) // c3 未被引用 → 不出现
    expect(lines[0]).toBe('1. Beta study. doi: 10.1000/beta')
    expect(lines[1]).toBe('2. Zhang S, Li Q, Wang L, et al. Alpha study. Nature Medicine. 2024. doi: 10.1000/alpha')
  })

  test('正文 [cite:] 标记 → 与解析后正文编号一致（组合链路）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/exp.7', title: 'Alpha study', authors: ['Zhang S'], journal: 'Nature Medicine', year: 2024, source: 'pubmed' })
    const c2 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/exp.8', title: 'Beta study', authors: [], source: 'crossref' })
    // c2 在正文中首现于 c1 之前
    const raw = `引言 [cite:${c2.id}]；讨论 [cite:${c1.id}]。`
    const numbers = assignCitationNumbers(raw)
    const resolved = await resolveBodyCitations(DOC, raw)
    const section = buildReferencesSection((await listDocCitations(DOC)).map(serializeDocCitation), numbers)
    expect(section).toBe('## References\n\n1. Beta study. doi: 10.1000/exp.8\n2. Zhang S. Alpha study. Nature Medicine. 2024. doi: 10.1000/exp.7')
    // 解析后正文无 shortcode（#1078 入口以 strip 前形态判定）
    CITE_SHORTCODE_PATTERN.lastIndex = 0
    expect(CITE_SHORTCODE_PATTERN.test(resolved)).toBe(false)
  })

  test('空编号 → 空段（调用方跳过追加）', () => {
    expect(buildReferencesSection(citations, new Map())).toBe('')
  })
})

// ── 复审 #1 修复回归 — composeExportBody 单一入口（此前 insert-asset-export
// 内联实现的 hasCiteShortcode 判定放在 resolveBodyCitations 之后，body 已被
// 改写为 [n]/[?]，条件恒 false → References 列表从不追加）。──
describe('#1078 复审 #1 — composeExportBody 导出正文合成', () => {
  beforeEach(async () => {
    await (prisma as any).docCitation.deleteMany({ where: { docId: DOC } })
    await ensureDocFixture()
  })

  test('有标记：正文解析为 [n] + 遗留手写区被剥除 + References 列表追加（同序同编号）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/compose.1', title: 'C1', authors: ['A'], source: 'crossref' })
    const c2 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/compose.2', title: 'C2', authors: [], source: 'pubmed' })
    const body = `# T\n\n引用 [cite:${c1.id}] 与 [cite:${c2.id}]。\n\n## References\n\n[1] 旧手写条目\n`
    const out = await composeExportBody(DOC, body)
    expect(out).toContain('引用 [1] 与 [2]')
    expect(out).not.toContain('[cite:')
    expect(out).not.toContain('旧手写条目') // 手写区被剥除
    expect(out).toContain('## References')
    expect(out.indexOf('C1')).toBeLessThan(out.indexOf('C2')) // 编号顺序一致
    expect(out).toContain('doi: 10.1000/compose.1')
  })

  test('悬挂标记也触发 References 合成（此前恒 false 的直接后果 — 列表永不生成）', async () => {
    const c1 = await resolveOrCreateDocCitation({ docId: DOC, doi: '10.1000/compose.2', title: 'C1', authors: [], source: 'crossref' })
    const body = `引用 [cite:${c1.id}] 悬挂 [cite:cite_ghost]\n\n## References\n\n[1] 旧条目\n`
    const out = await composeExportBody(DOC, body)
    expect(out).toContain('[1]') && expect(out).toContain('[?]')
    expect(out).toContain('## References') // 关键断言：列表被追加（修复前恒 false）
  })

  test('无标记的存量文档零改动直通（不剥遗留 References）', async () => {
    const legacy = '# T\n\n正文。\n\n## References\n\n[1] 手写遗留条目\n'
    expect(await composeExportBody(DOC, legacy)).toBe(legacy)
  })
})
