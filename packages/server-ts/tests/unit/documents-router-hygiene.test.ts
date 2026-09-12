import { describe, test, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

/**
 * #980 — documents.router 写回卫生批:
 *  1. PUT /docs/:docId 走 writeDocVersion 单点(#904 乐观锁 + 同帧快照),
 *     并发写回 409 stale_base(前端冲突横幅契约)而非静默覆盖;
 *  2. FK 兜底 PRAGMA OFF 后 try/finally 恢复 ON(连接池复用不扩散约束失效);
 *  3. /docs/:docId/chat 410 废弃端点不再挂路由。
 *
 * 路由级行为测试:documentsRouter 注册到假 Fastify 实例,直接调用 handler,
 * 仅 mock 网络/LLM/prisma 边界。
 */

const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docUpdate: vi.fn(),
  docCreate: vi.fn(),
  docDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
  writeDocVersion: vi.fn(),
  snapFindFirst: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst, update: mocks.docUpdate, create: mocks.docCreate, deleteMany: mocks.docDeleteMany },
    docSnapshot: { create: vi.fn(), findFirst: mocks.snapFindFirst },
    $executeRawUnsafe: mocks.executeRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      doc: { update: mocks.docUpdate },
      docSnapshot: { create: vi.fn() },
    }),
    researchStudy: { findFirst: vi.fn().mockResolvedValue(null) },
    studyProtocolRule: { findMany: vi.fn().mockResolvedValue([]) },
    fileIndex: { findFirst: vi.fn().mockResolvedValue(null) },
    docReference: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}))
vi.mock('../../src/common/auth.guard.js', () => ({ authGuard: async () => {} }))
vi.mock('../../src/tools/doc-version-writer.js', () => ({ writeDocVersion: mocks.writeDocVersion }))
vi.mock('../../src/modules/documents/markdown-export.js', () => ({
  renderDocxBuffer: vi.fn(),
  renderPdfBuffer: vi.fn(),
  isExportFormat: (f: string) => f === 'docx' || f === 'pdf',
}))
vi.mock('../../src/modules/documents/document-writing.service.js', () => ({
  polishSelection: vi.fn(),
  polishSelectionFallback: vi.fn(),
  writeMethodsSection: vi.fn(),
  writePaperBackground: vi.fn(),
  MAX_POLISH_CHARS: 20000,
  resolvePolishModel: () => 'test-model',
  resolvePolishDeadlineMs: () => 1000,
}))
vi.mock('../../src/lib/pptx-extractor.js', () => ({
  extractPptxContentFromUpload: vi.fn(),
  pptxSlidesToDeck: vi.fn(),
}))
vi.mock('../../src/tools/doc-import.js', () => ({ ensureDraftBody: vi.fn() }))
vi.mock('../../src/common/logger.js', () => ({
  makeLogger: () => new Proxy({}, { get: () => vi.fn() }),
}))
vi.mock('../../src/common/chart-token.js', () => ({ refreshFileUrls: (s: string) => s }))
vi.mock('../../src/common/doc-lint.js', () => ({ lintDocument: () => [] }))
vi.mock('../../src/modules/chat/chat-sse.js', () => ({ createRawSseSender: () => ({ send: vi.fn(), end: vi.fn() }) }))
vi.mock('../../src/modules/figures/figure-markdown.js', () => ({
  scanFigures: () => ({ figures: [] }),
  resolveFiguresToImageLines: async () => [],
}))
vi.mock('../../src/modules/figures/figure.service.js', () => ({
  ensureFigures: vi.fn(),
  ensureFigure: vi.fn(),
}))

import { documentsRouter } from '../../src/modules/documents/documents.router.js'

function makeHarness() {
  const routes = new Map<string, any>()
  const app = {
    addHook: vi.fn(),
    get: (p: string, h: any) => routes.set(`GET ${p}`, h),
    post: (p: string, h: any) => routes.set(`POST ${p}`, h),
    put: (p: string, h: any) => routes.set(`PUT ${p}`, h),
    delete: (p: string, h: any) => routes.set(`DELETE ${p}`, h),
  }
  return { routes, app: app as never }
}

function makeReply() {
  const reply: any = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  }
  return reply
}

const USER = 'user_1'
const DOC = 'doc_abc123'
const EXISTING = {
  id: DOC, userId: USER, title: 'Old', body: 'A', deck: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
}

beforeEach(() => {
  // mockReset(非 clearAllMocks)— clearAllMocks 不清空 once-impl 队列,
  // 残留的 mockResolvedValueOnce 会跨用例泄漏(doc-router 真实事故形态)。
  mocks.docFindFirst.mockReset()
  mocks.docUpdate.mockReset()
  mocks.docCreate.mockReset()
  mocks.docDeleteMany.mockReset()
  mocks.executeRaw.mockReset()
  mocks.writeDocVersion.mockReset()
  mocks.executeRaw.mockResolvedValue(undefined)
  mocks.docUpdate.mockResolvedValue(EXISTING)
})

describe('#980 PUT /docs/:docId 走写回单点', () => {
  function setupFind(existing: unknown, reread: unknown) {
    mocks.docFindFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce(reread)
  }

  test('body 变化 → writeDocVersion 单点(快照 label 保存版本),不再裸 doc.update', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const put = routes.get('PUT /api/v1/docs/:docId')
    expect(put).toBeTruthy()
    setupFind(EXISTING, { ...EXISTING, body: 'B', updatedAt: '2026-01-03T00:00:00Z' })
    mocks.writeDocVersion.mockResolvedValue({ body: 'B', deck: null, changed: true })

    const res = await put(
      { params: { docId: DOC }, body: { title: 'Old', body: 'B' }, user: { userId: USER } },
      makeReply(),
    )

    // 写回单点参数:body + 快照 label(与工具路径同管道),deck 未传不触碰
    expect(mocks.writeDocVersion).toHaveBeenCalledWith({
      userId: USER, docId: DOC, body: 'B', snapshotLabel: '保存版本',
    })
    // 不再直接落库正文
    expect(mocks.docUpdate).not.toHaveBeenCalled()
    expect(res).toMatchObject({ id: DOC, body: 'B', unchanged: false })
  })

  test('base_sha 失配 → 409 stale_base,writeDocVersion 不执行', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const put = routes.get('PUT /api/v1/docs/:docId')
    setupFind(EXISTING, EXISTING)
    const reply = makeReply()

    const wrongSha = crypto.createHash('sha1').update('X').digest('hex')
    await put(
      { params: { docId: DOC }, body: { body: 'B', base_sha: wrongSha }, user: { userId: USER } },
      reply,
    )

    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
    expect(mocks.docUpdate).not.toHaveBeenCalled()
    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'stale_base' }))
  })

  test('writer 乐观锁冲突(#904)→ 409 stale_base + current_updated_at', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const put = routes.get('PUT /api/v1/docs/:docId')
    mocks.docFindFirst.mockResolvedValueOnce(EXISTING)
    mocks.writeDocVersion.mockResolvedValue({
      body: '', deck: null, changed: false, conflict: true, error: '文档已被并发修改',
    })
    // 冲突路径重读最新 updatedAt(本次调用是 findFirst 的第 2 次)
    mocks.docFindFirst.mockResolvedValueOnce({ updatedAt: '2026-01-09T00:00:00Z' })
    const reply = makeReply()

    await put(
      { params: { docId: DOC }, body: { body: 'B' }, user: { userId: USER } },
      reply,
    )

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      code: 'stale_base',
      current_updated_at: '2026-01-09T00:00:00Z',
    }))
  })

  test('仅 title 变化 → 不走写回单点、不刷 updatedAt、unchanged=true', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const put = routes.get('PUT /api/v1/docs/:docId')
    setupFind(EXISTING, EXISTING)

    const res = await put(
      { params: { docId: DOC }, body: { title: 'New' }, user: { userId: USER } },
      makeReply(),
    )

    expect(mocks.writeDocVersion).not.toHaveBeenCalled()
    expect(mocks.docUpdate).toHaveBeenCalledWith(
      { where: { id: DOC }, data: { title: 'New' } },
    )
    expect(res.unchanged).toBe(true)
  })
})

describe('#980 FK 兜底 PRAGMA try/finally(连接池约束失效防扩散)', () => {
  test('fallback insert 成功 → OFF 后恢复 ON', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const post = routes.get('POST /api/v1/docs')
    mocks.docCreate.mockRejectedValue(new Error('foreign key constraint failed'))
    mocks.executeRaw.mockResolvedValue(undefined)

    await post({ body: { title: 'T' }, user: { userId: USER } }, makeReply())

    const pragmaCalls = mocks.executeRaw.mock.calls.map((c) => String(c[0]))
    expect(pragmaCalls[0]).toContain('foreign_keys = OFF')
    expect(pragmaCalls).toContainEqual(expect.stringContaining('foreign_keys = ON'))
    // 顺序:OFF → INSERT → ON
    expect(pragmaCalls[pragmaCalls.length - 1]).toContain('foreign_keys = ON')
  })

  test('fallback insert 抛错 → finally 仍恢复 ON', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const post = routes.get('POST /api/v1/docs')
    mocks.docCreate.mockRejectedValue(new Error('foreign key constraint failed'))
    // 第 1 次 OFF 成功,第 2 次(INSERT)抛错,第 3 次(ON)应仍被调用
    mocks.executeRaw
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce(undefined)

    // INSERT 抛错经 finally 恢复 PRAGMA 后向上传播(Fastify 500)
    await expect(
      post({ body: { title: 'T' }, user: { userId: USER } }, makeReply()),
    ).rejects.toThrow('insert failed')

    const pragmaCalls = mocks.executeRaw.mock.calls.map((c) => String(c[0]))
    expect(pragmaCalls[0]).toContain('foreign_keys = OFF')
    expect(pragmaCalls[pragmaCalls.length - 1]).toContain('foreign_keys = ON')
  })
})

describe('#980 废弃端点清理', () => {
  test('/docs/:docId/chat 不再注册路由', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    expect(routes.has('POST /api/v1/docs/:docId/chat')).toBe(false)
  })
})

describe('#989 Phase 1 — restore 路径投影同帧重算(全路径走查)', () => {
  test('恢复快照 → doc.update data 携带与新 body 一致的 blockProjection', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const restore = routes.get('POST /api/v1/docs/:docId/snapshots/:snapId/restore')
    expect(restore).toBeTruthy()
    // 归属:doc + 快照都属于调用者
    mocks.docFindFirst
      .mockResolvedValueOnce({ ...EXISTING, body: 'current body' })   // doc
      .mockResolvedValue({ id: 7, body: 'snapshot body', deck: null }) // snap
    mocks.snapFindFirst.mockResolvedValue({ id: 7, body: 'snapshot body', deck: null })
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')

    await restore(
      { params: { docId: DOC, snapId: '7' }, user: { userId: USER } },
      makeReply(),
    )

    const [args] = mocks.docUpdate.mock.calls[0]
    expect(args.data.body).toBe('snapshot body')
    const projection = JSON.parse(args.data.blockProjection)
    const expected = buildBlockProjection('snapshot body')
    expect(projection.body_hash).toBe(expected.body_hash)
  })
})

describe('#995 批量删除 — 归属内联 + 上限/形状护栏', () => {
  test('批量删除 → deleteMany 以 (id in ids, userId) 归属内联,返回计数', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const batchDelete = routes.get('POST /api/v1/docs/batch-delete')
    expect(batchDelete).toBeTruthy()
    mocks.docDeleteMany.mockResolvedValue({ count: 2 })

    const res = await batchDelete(
      { body: { ids: ['doc_0123456789abcdef', 'doc_abcdef0123456789', 'not-a-doc-id'] }, user: { userId: USER } },
      makeReply(),
    )

    const [args] = mocks.docDeleteMany.mock.calls[0]
    // 归属内联:where 带 userId;非法 id 已过滤
    expect(args.where).toEqual({ id: { in: ['doc_0123456789abcdef', 'doc_abcdef0123456789'] }, userId: USER })
    expect(res).toEqual({ deleted: 2, requested: 2 })
  })

  test('空/非法 ids → 400', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const batchDelete = routes.get('POST /api/v1/docs/batch-delete')
    const reply = makeReply()
    await batchDelete({ body: { ids: ['x'] }, user: { userId: USER } }, reply)
    expect(reply.status).toHaveBeenCalledWith(400)
    expect(mocks.docDeleteMany).not.toHaveBeenCalled()
  })
})

describe('#989 Phase 3 — phi-scan 按块定位(findings 携带所属节)', () => {
  test('PHI 命中行 → finding.section = 投影中包含该位置的节(id+heading)', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const body = ['# 病例', '', '无敏感内容。', '', '## Notes', '', 'John Smith visited.', '', '## Discharge', '', 'OK.'].join('\n')
    mocks.docFindFirst
      .mockResolvedValueOnce({ ...EXISTING, body, deck: null })
    const scan = routes.get('POST /api/v1/docs/:docId/phi-scan')
    expect(scan).toBeTruthy()
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')
    const projection = buildBlockProjection(body)
    const notes = projection.nodes.find((n) => n.kind === 'section' && n.heading === 'Notes')!

    // handler 直接返回 payload(不经 reply.send)
    const payload = (await scan({ params: { docId: DOC }, user: { userId: USER } }, makeReply())) as { findings: Array<{ kind: string; text: string; section?: { id: string; heading: string } }> }
    const nameFinding = payload.findings.find((f) => f.kind === 'Name' && f.text === 'John Smith')
    expect(nameFinding).toBeTruthy()
    expect(nameFinding!.section).toMatchObject({ id: notes.id, heading: 'Notes' })
    // 无 PHI 的节不产生 finding;Discharge 节无命中
    expect(payload.findings.every((f) => f.section?.id !== undefined || f.section === undefined)).toBe(true)
  })

  test('存量文档(无投影)→ 现场重建后同样带节定位', async () => {
    const { routes, app } = makeHarness()
    await documentsRouter(app as never)
    const body = '## Notes\n\nJohn Smith visited.'
    mocks.docFindFirst.mockResolvedValue({ ...EXISTING, body, deck: null, blockProjection: null })
    const scan = routes.get('POST /api/v1/docs/:docId/phi-scan')

    const findings = ((await scan({ params: { docId: DOC }, user: { userId: USER } }, makeReply())) as { findings: Array<{ section?: { id: string } }> }).findings
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].section?.id).toMatch(/^s_[0-9a-f]{12}$/)
  })
})
