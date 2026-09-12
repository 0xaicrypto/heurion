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
    // 写回单点调用:body 为替换后正文
    expect(mocks.writeDocVersion).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, docId: DOC, body: expect.stringContaining('Fully rewritten intro.'), snapshotLabel: 'AI edit' }),
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
