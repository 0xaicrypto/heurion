import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #989 Phase 2 — edit_document 的 target_section 确定性节编辑(工具层)。
 * prisma / writeDocVersion 全量 mock(交互事务把 updateMany 断言回来)。
 */
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docUpdateMany: vi.fn(),
  txDocUpdateMany: vi.fn(),
  txDocSnapshotCreate: vi.fn(),
  writeDocVersion: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst, updateMany: mocks.docUpdateMany },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      doc: { updateMany: mocks.txDocUpdateMany },
      docSnapshot: { create: mocks.txDocSnapshotCreate },
    }),
  },
}))
// #789: 写回单点 mock — 断言节编辑的落库入参。
vi.mock('../../src/tools/doc-version-writer.js', () => ({
  writeDocVersion: mocks.writeDocVersion,
}))

import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'
import { buildBlockProjection } from '../../src/lib/block-projection.js'
// #1079: 引用纪律护栏 — 纯函数直接单测 + 工具层集成用例。
import { looksLikeHandwrittenReferences } from '../../src/tools/citation-guard.js'

const DOC = 'doc_0123456789abcdef'
const USER = 'user_1'
const BODY = [
  '# Paper',
  '',
  '## Introduction',
  'intro body text.',
  '',
  '## Methods',
  'methods body text.',
].join('\n')

function makeDoc(blockProjection?: string) {
  return { id: DOC, userId: USER, title: 'T', body: BODY, deck: null, blockProjection }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writeDocVersion.mockImplementation(async (input: { body: string }) => ({
    body: input.body, deck: null, changed: true, projection: buildBlockProjection(input.body),
  }))
})

describe('#989 Phase 2 — edit_document target_section(工具层)', () => {
  test('replace:按投影 span 确定性重写,落库走写回单点', async () => {
    const proj = buildBlockProjection(BODY)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))

    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: intro.id,
      section_action: 'replace',
      content: 'Fully rewritten intro.',
      summary: 'rewrite intro',
    })

    expect(r.success).toBe(true)
    const output = JSON.parse(r.output as string)
    expect(output.body).toContain('Fully rewritten intro.')
    expect(output.body).not.toContain('intro body text.')
    expect(output.body).toContain('## Methods')
    // 写回单点调用:body 为替换后正文;baseBody 锁定读→写窗口(review 复核#5)
    expect(mocks.writeDocVersion).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, docId: DOC, body: expect.stringContaining('Fully rewritten intro.'), baseBody: BODY, snapshotLabel: 'AI edit' }),
    )
  })

  test('append/prepend:追加与插入落位正确', async () => {
    const proj = buildBlockProjection(BODY)
    const methods = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!

    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const app = await tool.execute({
      target_section: methods.id, section_action: 'append', content: 'Added methods note.',
    })
    expect(app.success).toBe(true)
    const appBody = JSON.parse(app.output as string).body as string
    expect(appBody).toContain('Added methods note.')
    expect(appBody.indexOf('Added methods note.')).toBeGreaterThan(appBody.indexOf('methods body text.'))

    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const pre = await tool.execute({
      target_section: methods.id, section_action: 'prepend', content: 'Overview first.',
    })
    expect(pre.success).toBe(true)
    const preBody = JSON.parse(pre.output as string).body as string
    expect(preBody.indexOf('Overview first.')).toBeGreaterThan(preBody.indexOf('## Methods'))
    expect(preBody.indexOf('Overview first.')).toBeLessThan(preBody.indexOf('methods body text.'))
  })

  test('section_action 缺失/非法 → 拒绝,不静默退化 replace(review 复核#2)', async () => {
    const proj = buildBlockProjection(BODY)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const missing = await tool.execute({ target_section: intro.id, content: 'x' })
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('section_action')
    expect(missing.error).toContain('缺失')
    const bad = await tool.execute({ target_section: intro.id, section_action: 'rewrite', content: 'x' })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('rewrite')
    // 校验在读取/写回之前 — 破坏性 replace 未被静默执行
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('ID 失效 → error 引导降级锚点(工具报错形态)', async () => {
    const proj = buildBlockProjection(BODY)
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: 's_gone00000000', section_action: 'replace', content: 'x',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('锚点')
  })

  test('无投影(存量文档)→ 现场重建后同样可用(自动建投影路径)', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(undefined))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: buildBlockProjection(BODY).nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!.id,
      section_action: 'replace',
      content: 'Deterministic methods.',
    })
    expect(r.success).toBe(true)
    expect(JSON.parse(r.output as string).body).toContain('Deterministic methods.')
  })

  test('空正文 → 节引用不可用(引导导入)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, userId: USER, title: 'T', body: '', deck: null })
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ target_section: 's_x', section_action: 'replace', content: 'x' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('import_reference')
  })

  test('delete:整节移除(生产实例 — 模型清理占位节)', async () => {
    const proj = buildBlockProjection(BODY)
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const methods = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ target_section: methods.id, section_action: 'delete' })
    expect(r.success).toBe(true)
    const output = JSON.parse(r.output as string)
    expect(output.body).not.toContain('## Methods')
    expect(output.body).toContain('## Introduction')
    expect(output.location).toContain('删除')
  })

  test('new_text 别名:模型沿用 range 模式参数习惯(生产实例 2026-09-12)→ 同样生效', async () => {
    const proj = buildBlockProjection(BODY)
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: intro.id,
      section_action: 'replace',
      new_text: 'Rewritten via new_text alias.',
    })
    expect(r.success).toBe(true)
    const output = JSON.parse(r.output as string)
    expect(output.body).toContain('Rewritten via new_text alias.')
    expect(output.body).not.toContain('intro body text.')
  })

  test('空参 edit_document({}) → 纠偏指引(指认空参 + 重试配方 + 禁止空参重发,#978 家族)', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc())
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({})
    expect(r.success).toBe(false)
    expect(r.error).toContain('没有任何参数')
    expect(r.error).toContain('old_text')
    expect(r.error).toContain('target_section')
    expect(r.error).toContain('严禁重发空参数')
  })

  test('old_text 含 [sec:...] marker → 自动剥离后锚点命中(锚点兜底共存)', async () => {
    const proj = buildBlockProjection(BODY)
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    mocks.writeDocVersion.mockImplementation(async (input: { body: string }) => ({
      body: input.body, deck: null, changed: true, projection: buildBlockProjection(input.body),
    }))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      old_text: `## [sec:s_whatever] Methods\nmethods body text.`,
      new_text: '## Methods\nmethods body polished.',
      summary: 'polish methods',
    })
    expect(r.success).toBe(true)
    const output = JSON.parse(r.output as string)
    expect(output.body).toContain('methods body polished.')
  })
})

describe('#1020/#1022 — 稳定 section_id + 节内锚点 + 结构化诊断', () => {
  function projStr() { return JSON.stringify(buildBlockProjection(BODY)) }

  test('section_id + 有细微偏差的 old_text → 节内模糊命中(定位成功)', async () => {
    // 长句才有可用的模糊锚点（findFuzzySpan 需要 ≥24 字符的相同锚片）。
    const LONG_BODY = [
      '# Paper',
      '',
      '## Introduction',
      'intro body text.',
      '',
      '## Methods',
      'The cohort included one hundred twenty patients with complete follow-up data.',
      '',
      'Second methods sentence with additional detail about the assay.',
    ].join('\n')
    const longProj = buildBlockProjection(LONG_BODY)
    const methods = longProj.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    mocks.docFindFirst.mockResolvedValue({ id: DOC, userId: USER, title: 'T', body: LONG_BODY, deck: null, blockProjection: JSON.stringify(longProj) })
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      section_id: methods.id,
      old_text: 'The cohort included one hundred twenty patients with complete follow-up datas.', // 结尾多一个 s → fuzzy 命中
      new_text: 'The cohort included 120 patients with complete follow-up.',
      summary: 'in-section polish',
    })
    expect(r.success, String(r.error)).toBe(true)
    const output = JSON.parse(r.output as string)
    expect(output.body).toContain('The cohort included 120 patients with complete follow-up.')
    expect(output.body).toContain('## Introduction')
    expect(output.location).toContain('Methods')
    expect(mocks.writeDocVersion).toHaveBeenCalledWith(
      expect.objectContaining({ baseBody: LONG_BODY, body: expect.stringContaining('120 patients') }),
    )
  })

  test('section_id 不存在 → 明确报错并附可用节清单,不静默全局搜索', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(projStr()))
    const intro = buildBlockProjection(BODY).nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      section_id: 's_gone00000000',
      old_text: 'intro body text.',
      new_text: 'x',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('不存在')
    expect(r.error).toContain('当前可用节')
    expect(r.error).toContain(intro.id)
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('section_id + old_text 节内未命中 → 返回节内最接近候选,不改错节', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(projStr()))
    const methods = buildBlockProjection(BODY).nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      section_id: methods.id,
      old_text: 'methods protocol summary sentence.',
      new_text: 'x',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('最接近的候选')
    expect(r.error).toContain('methods body text.')
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('#1022 全局锚点失败 → 错误里带最接近候选（可直接复制）', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(projStr()))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      old_text: 'introduction overview sentence not present.',
      new_text: 'x',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('最接近的候选')
    expect(r.error).toContain('intro body text.')
    expect(r.error).toContain('相似度')
  })

  test('target_section 与 section_id 同时传且不一致 → 拒绝', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(projStr()))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: 's_aaa', section_id: 's_bbb', section_action: 'replace', content: 'x',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('不一致')
  })
})

describe('#1079 — 手写 References 护栏（looksLikeHandwrittenReferences + edit_document 拒绝路径）', () => {
  const HAND = [
    'References',
    '[1] Smith J, et al. Some title. J Clin. 2020;5:1-9.',
    '[2] Doe A, et al. Another title. Nature. 2021;2:3-4.',
  ].join('\n')

  test('纯函数:手写编号条目 ×2 → true', () => {
    expect(looksLikeHandwrittenReferences(HAND)).toBe(true)
    // "1." 编号形态同样命中
    expect(looksLikeHandwrittenReferences('1. Smith J, et al. Some title. J Clin. 2020;5:1-9.\n2. Doe A, et al. Another title. Nature. 2021;2:3-4.')).toBe(true)
    // 中文文献线索
    expect(looksLikeHandwrittenReferences('[1] 张三, 等. 某论文. 中华医学杂志. 2020;5:1-9.\n[2] 李四, 等. 另一篇. 学报. 2021;2:3-4.')).toBe(true)
  })

  test('纯函数:正常编辑/单行编号/含 [cite:id] 标记 → false（不误伤）', () => {
    expect(looksLikeHandwrittenReferences('请把这句话改成更简洁的表达')).toBe(false)
    expect(looksLikeHandwrittenReferences('该方案参考了 [1] 中提出的剂量曲线。')).toBe(false)
    // 含合法 [cite:id] 标记 → 即使混有编号行也放行（正式引用通道）
    expect(looksLikeHandwrittenReferences('结论 [cite:abc-123]。[1] Smith J, et al. Title. J Clin. 2020.')).toBe(false)
    expect(looksLikeHandwrittenReferences('')).toBe(false)
  })

  test('护栏集成:range 模式 new_text 手写 References → 拒绝并引导 insert_citation', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(buildBlockProjection(BODY))))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      old_text: 'intro body text.',
      new_text: HAND,
      summary: 'add references',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('insert_citation')
    expect(r.error).toContain('[cite:')
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('护栏集成:节编辑 content 手写 References → 拒绝', async () => {
    const proj = buildBlockProjection(BODY)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(proj)))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      target_section: intro.id,
      section_action: 'replace',
      content: HAND,
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('insert_citation')
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('护栏集成:含合法 [cite:id] 标记的编号混排 → 放行', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(buildBlockProjection(BODY))))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      old_text: 'intro body text.',
      new_text: 'Polished intro [cite:abc-123], see also [1] prior work.',
      summary: 'polish with citation',
    })
    expect(r.success, String(r.error)).toBe(true)
  })

  test('护栏集成:普通编辑（无引用形态）→ 不受影响', async () => {
    mocks.docFindFirst.mockResolvedValue(makeDoc(JSON.stringify(buildBlockProjection(BODY))))
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({
      old_text: 'intro body text.',
      new_text: '请把这句话改成更简洁的表达后的版本：intro polished.',
      summary: 'polish',
    })
    expect(r.success, String(r.error)).toBe(true)
    expect(JSON.parse(r.output as string).body).toContain('intro polished.')
  })
})
