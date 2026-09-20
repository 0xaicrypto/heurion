import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1073-3 — edit_document 的 titleOnly / withTitle 两条路径对「文档不存在」
 * 统一语义（TDD）。
 *
 * 取舍：统一为**显式报错**（`Document not found: <docId>`），不静默跳过 —
 * 与工具其余编辑路径（sectionEdit/sectionRangeEdit/rangeEdit/fullReplace/
 * titleOnly）对缺失文档的既有错误惯例完全一致；AI 需要明确信号才能自纠
 * （会话文档被删除/未创建时，静默跳过会让模型误以为改名已生效）。
 *
 * 修复前差异：titleOnly 显式报错；withTitle 依赖 writeDocVersion 的兜底
 * 错误（消息恰好相同纯属巧合），且多一次冗余 findFirst 读取。
 */
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  writeDocVersion: vi.fn(),
  executeImportReference: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: { doc: { findFirst: mocks.docFindFirst } },
}))
vi.mock('../../src/tools/doc-version-writer.js', () => ({
  writeDocVersion: mocks.writeDocVersion,
}))
vi.mock('../../src/tools/doc-import.js', () => ({
  resolveImportTargets: vi.fn(async () => []),
  ensureDraftBody: vi.fn(),
  executeImportFromUrl: vi.fn(),
}))
vi.mock('../../src/tools/edit-import.js', () => ({
  executeImportReference: mocks.executeImportReference,
}))

import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'

const DOC = 'doc_0123456789abcdef'
const USER = 'user_1'

describe('#1073-3 — titleOnly/withTitle 文档不存在语义统一', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.docFindFirst.mockResolvedValue(null)
    mocks.executeImportReference.mockResolvedValue({ success: true, output: '{"body":"x"}' })
  })

  test('titleOnly：文档不存在 → 显式 Document not found 错误', async () => {
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ title: '新标题' })
    expect(r.success).toBe(false)
    expect(r.error).toBe(`Document not found: ${DOC}`)
  })

  test('withTitle（导入成功后挂 title）：文档不存在 → 同款显式错误，不静默跳过', async () => {
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ import_reference: '参考材料.pdf', title: '新标题' })
    // 主操作（导入）成功，但 title 写回前文档已不存在 → 统一显式报错
    expect(r.success).toBe(false)
    expect(r.error).toBe(`Document not found: ${DOC}`)
    // 两条路径错误文案完全一致（统一语义的断言）
    const tool2 = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r2 = await tool2.execute({ title: '新标题' })
    expect(r2.error).toBe(r.error)
  })
})
