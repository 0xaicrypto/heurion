import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #905 — doc- 会话三重防线单测(docId 格式校验 / 文档存在性门控 /
 * 工具层拒绝)。#906 — editHint 焦点区域回合内失效修复
 * (latestBody 缓存 + 焦点段按最新正文重切)。
 *
 * prisma 全量 mock(doc-version-writer.test.ts 同款 factory 模式),
 * 不触真实 DB;writeDocVersion 同样 mock(写回即更新可变正文状态)。
 */
const mocks = vi.hoisted(() => {
  const state = { body: '' }
  return {
    docFindFirst: vi.fn(),
    fileIndexFindFirst: vi.fn(),
    userFindUnique: vi.fn(),
    writeDocVersion: vi.fn(async (input: { body: string }) => {
      state.body = input.body
      return { body: input.body, deck: null, changed: true }
    }),
    state,
  }
})

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst },
    fileIndex: { findFirst: mocks.fileIndexFindFirst },
    user: { findUnique: mocks.userFindUnique },
  },
}))

vi.mock('../../src/tools/doc-version-writer.js', () => ({
  writeDocVersion: mocks.writeDocVersion,
}))

import { ToolRegistry, parseDocSessionId, type ToolContext } from '../../src/tools/tool-registry.js'
import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'

/** documents.router 生成格式:doc_ + 16 hex(uid() = randomBytes(8).hex)。 */
const VALID_DOC_ID = 'doc_00aa11bb22cc33dd'
const VALID_SESSION = `doc-${VALID_DOC_ID}`

function makeRegistryCtx(userId: string, sessionId?: string): ToolContext {
  return {
    userId,
    memory: {} as any,
    facts: {} as any,
    episodes: {} as any,
    skills: {} as any,
    knowledge: {} as any,
    eventLog: { append: () => {}, query: () => [] } as any,
    ...(sessionId ? { sessionId } : {}),
  } as ToolContext
}

const DOC_TOOL_NAMES = ['edit_document', 'insert_asset', 'edit_deck', 'fix_document_images']

beforeEach(() => {
  vi.clearAllMocks()
  mocks.docFindFirst.mockResolvedValue({ id: VALID_DOC_ID })
  mocks.fileIndexFindFirst.mockResolvedValue(null)
  mocks.userFindUnique.mockResolvedValue(null)
})

describe('#905 parseDocSessionId(docId 格式校验,对齐 documents.router 生成格式)', () => {
  test('合法 `doc-doc_<16hex>` → docId', () => {
    expect(parseDocSessionId(VALID_SESSION)).toBe(VALID_DOC_ID)
    expect(parseDocSessionId('doc-doc_abcdef0123456789')).toBe('doc_abcdef0123456789')
  })

  test('非 doc- 前缀 / 空 → null', () => {
    expect(parseDocSessionId(undefined)).toBeNull()
    expect(parseDocSessionId('')).toBeNull()
    expect(parseDocSessionId('session_abc')).toBeNull()
    expect(parseDocSessionId('global-x')).toBeNull()
  })

  test('docId 格式不符(遗留/伪造会话)→ null', () => {
    expect(parseDocSessionId('doc-7')).toBeNull()
    expect(parseDocSessionId('doc-doc1')).toBeNull()
    expect(parseDocSessionId('doc-bug2_123')).toBeNull()
    expect(parseDocSessionId('doc-doc_00aa11bb22cc33ddZZ')).toBeNull() // 超长
    expect(parseDocSessionId('doc-doc_00AA11BB22CC33DD')).toBeNull() // 大写非 hex 口径
  })
})

describe('#905 getDefinitionsForUser 文档存在性门控', () => {
  test('doc 存在 → 四个写回工具全部暴露', async () => {
    const registry = new ToolRegistry(makeRegistryCtx('user_1', VALID_SESSION))
    const defs = await registry.getDefinitionsForUser('document', VALID_SESSION)
    const names = defs.map((d) => d.function.name)
    for (const n of DOC_TOOL_NAMES) expect(names).toContain(n)
    // 归属读:findFirst 以 (id, userId) 查询。
    expect(mocks.docFindFirst).toHaveBeenCalledWith({
      where: { id: VALID_DOC_ID, userId: 'user_1' },
      select: { id: true },
    })
  })

  test('doc 不存在(已删除/伪造会话)→ 写回工具不暴露', async () => {
    mocks.docFindFirst.mockResolvedValue(null)
    const registry = new ToolRegistry(makeRegistryCtx('user_1', VALID_SESSION))
    const defs = await registry.getDefinitionsForUser('document', VALID_SESSION)
    const names = defs.map((d) => d.function.name)
    for (const n of DOC_TOOL_NAMES) expect(names).not.toContain(n)
    // 普通工具不受影响。
    expect(names).toContain('load_data_table')
  })

  test('docId 格式不符 → 不暴露且不查库(格式校验前置)', async () => {
    const registry = new ToolRegistry(makeRegistryCtx('user_1', 'doc-bug2_123'))
    const defs = await registry.getDefinitionsForUser('document', 'doc-bug2_123')
    const names = defs.map((d) => d.function.name)
    for (const n of DOC_TOOL_NAMES) expect(names).not.toContain(n)
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })

  test('非 doc- 会话 → 不暴露(既有 #580 行为保持)', async () => {
    const registry = new ToolRegistry(makeRegistryCtx('user_1'))
    const defs = await registry.getDefinitionsForUser('general', 'session_abc')
    const names = defs.map((d) => d.function.name)
    for (const n of DOC_TOOL_NAMES) expect(names).not.toContain(n)
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })

  test('存在性判定按实例缓存(每回合至多一次 DB 查询)', async () => {
    const registry = new ToolRegistry(makeRegistryCtx('user_1', VALID_SESSION))
    await registry.getDefinitionsForUser('document', VALID_SESSION)
    await registry.getDefinitionsForUser('document', VALID_SESSION)
    expect(mocks.docFindFirst).toHaveBeenCalledTimes(1)
  })
})

describe('#905 EditDocumentTool sessionId 校验', () => {
  test('格式不符的 doc- 会话 → 拒绝执行(写作会话限定)', async () => {
    const tool = new EditDocumentTool({ userId: 'user_1', sessionId: 'doc-doc1' })
    const res = await tool.execute({ old_text: 'a', new_text: 'b' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('document writing session')
  })

  test('非 doc- 会话 → 拒绝执行(既有行为保持)', async () => {
    const tool = new EditDocumentTool({ userId: 'user_1', sessionId: 'global-x' })
    const res = await tool.execute({ full_text: 'x' })
    expect(res.success).toBe(false)
  })
})

describe('#906 editHint 焦点区域回合内失效 — latestBody 缓存 + 焦点段重切', () => {
  const BODY = '## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲。重复句。'
  const FOCUS_CONTENT = '## 段落一\n\n句子甲。重复句。'

  function makeTool(sessionId = VALID_SESSION) {
    return new EditDocumentTool({
      userId: 'user_1',
      sessionId,
      editHint: { focusSectionContent: FOCUS_CONTENT, focusIndex: 2, focusTitle: '段落一', selectionText: null },
    })
  }

  test('同一实例连续两次 rangeEdit — 第二次区域匹配用第一次编辑后的新正文(落在焦点段)', async () => {
    mocks.docFindFirst.mockImplementation(async () => ({ id: VALID_DOC_ID, body: mocks.state.body }))
    mocks.state.body = BODY
    const tool = makeTool()

    // 第一次:改写焦点段内的一句(区域 hint 命中,写回后 latestBody 更新)。
    const r1 = await tool.execute({ old_text: '句子甲。', new_text: '句子甲改。', summary: '改句子甲' })
    expect(r1.success).toBe(true)
    const out1 = JSON.parse(r1.output as string)
    expect(out1.location).toContain('第 2 段')
    expect(mocks.state.body).toBe('## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲改。重复句。')

    // 第二次:hint 里的焦点段(旧正文)已失配 — 必须从本轮最新正文重切
    // 焦点段再定位;「重复句。」在段落零也有,全文首个命中会改错段落。
    const r2 = await tool.execute({ old_text: '重复句。', new_text: '重复句改。', summary: '改重复句' })
    expect(r2.success).toBe(true)
    const out2 = JSON.parse(r2.output as string)
    expect(out2.location).toContain('第 2 段')
    expect(out2.location).toContain('段落一')
    // 段落零的原句保持不动,替换落在焦点段(段落一)。
    expect(mocks.state.body).toBe('## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲改。重复句改。')
  })

  test('跨回合(新实例,无本轮缓存)保持旧行为 — hint 失配落全文,重复锚点报「出现多次」', async () => {
    // 上一回合已完成第一次编辑后的正文状态;新回合新实例,latestBody 为空。
    mocks.docFindFirst.mockImplementation(async () => ({ id: VALID_DOC_ID, body: mocks.state.body }))
    mocks.state.body = '## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲改。重复句。'
    const tool = makeTool()

    // 跨回合行为不变:hint 焦点段失配 → 全文路径;「重复句。」出现两次,
    // 锚点唯一性护栏(#868)报「出现多次」让模型补上下文 — 不做焦点重切。
    const res = await tool.execute({ old_text: '重复句。', new_text: '重复句改。', summary: '改重复句' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('出现多次')
    expect(mocks.state.body).toBe('## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲改。重复句。')
  })

  test('无 latestBody 且区域新鲜命中 — 行为与既有区域优先一致', async () => {
    mocks.docFindFirst.mockImplementation(async () => ({ id: VALID_DOC_ID, body: mocks.state.body }))
    mocks.state.body = BODY
    const tool = makeTool()

    // old_text 在焦点段与段落零重复 — 区域优先命中段落一(位置必然正确)。
    const res = await tool.execute({ old_text: '重复句。', new_text: '重复句改。', summary: '改重复句' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output as string)
    expect(out.location).toContain('第 2 段')
    expect(mocks.state.body).toBe('## 段落零\n\n重复句。\n\n## 段落一\n\n句子甲。重复句改。')
  })
})
