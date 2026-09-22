import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1103 — write-class tools must NOT perform their write after abort.
 * Real EditDocumentTool + mocked prisma/writeDocVersion. The signal is
 * aborted MID-EXECUTION (while the tool is reading the document) so the
 * per-write-point checks are what stop the late write-back with the clean
 * failure ('已超时中止，本次修改未写入').
 */
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  writeDocVersion: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst },
  },
}))
vi.mock('../../src/tools/doc-version-writer.js', () => ({
  writeDocVersion: mocks.writeDocVersion,
}))

import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'
import { ABORTED_WRITE_ERROR } from '../../src/tools/base-tool.js'
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

function makeDoc() {
  return { id: DOC, userId: USER, title: 'T', body: BODY, deck: null, blockProjection: JSON.stringify(buildBlockProjection(BODY)) }
}

/** docFindFirst aborts the controller during the read — the write point runs later. */
function abortDuringRead(controller: AbortController) {
  mocks.docFindFirst.mockImplementation(async () => {
    controller.abort()
    return makeDoc()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writeDocVersion.mockImplementation(async (input: { body: string }) => ({
    body: input.body, deck: null, changed: true, projection: buildBlockProjection(input.body),
  }))
  mocks.docFindFirst.mockResolvedValue(makeDoc())
})

describe('#1103 — edit_document 写回点中止检查（超时/中止后不落库）', () => {
  test('section edit + 中途 abort → 干净失败,writeDocVersion 未调用', async () => {
    const proj = buildBlockProjection(BODY)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const controller = new AbortController()
    mocks.docFindFirst.mockImplementation(async () => {
      controller.abort()
      return { ...makeDoc(), blockProjection: JSON.stringify(proj) }
    })

    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute(
      { target_section: intro.id, section_action: 'replace', content: 'Fully rewritten intro.' },
      controller.signal,
    )

    expect(r.success).toBe(false)
    expect(r.error).toBe(ABORTED_WRITE_ERROR)
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('range edit (old_text/new_text) + 中途 abort → 干净失败,writeDocVersion 未调用', async () => {
    const controller = new AbortController()
    abortDuringRead(controller)
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute(
      { old_text: 'intro body text.', new_text: 'rewritten intro.' },
      controller.signal,
    )

    expect(r.success).toBe(false)
    expect(r.error).toBe(ABORTED_WRITE_ERROR)
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('full_text 重写 + 中途 abort → 干净失败,writeDocVersion 未调用', async () => {
    const controller = new AbortController()
    abortDuringRead(controller)
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ full_text: '# Fully new document\n' }, controller.signal)

    expect(r.success).toBe(false)
    expect(r.error).toBe(ABORTED_WRITE_ERROR)
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('title-only 重命名 + 中途 abort → 干净失败,writeDocVersion 未调用', async () => {
    const controller = new AbortController()
    abortDuringRead(controller)
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute({ title: 'New Title' }, controller.signal)

    expect(r.success).toBe(false)
    expect(r.error).toBe(ABORTED_WRITE_ERROR)
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('执行入口已 aborted → 同样干净失败,不进入任何写回路径', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute(
      { old_text: 'intro body text.', new_text: 'rewritten intro.' },
      controller.signal,
    )

    expect(r.success).toBe(false)
    expect(r.error).toBe(ABORTED_WRITE_ERROR)
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
  })

  test('未中止的同款调用照常写回（行为不回退）', async () => {
    const controller = new AbortController()
    const tool = new EditDocumentTool({ userId: USER, sessionId: `doc-${DOC}` })
    const r = await tool.execute(
      { old_text: 'intro body text.', new_text: 'rewritten intro.' },
      controller.signal,
    )
    expect(r.success).toBe(true)
    expect(mocks.writeDocVersion).toHaveBeenCalledTimes(1)
  })
})
