import { describe, test, expect, vi, beforeEach } from 'vitest'

// #904: writeDocVersion 的原子条件更新单测 — mock prisma（与
// execution-plane-fetchfile.test.ts 同款 factory 模式；交互事务把 tx
// 传回给被测函数，断言 updateMany 的乐观锁 where 与快照同帧内容）。
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docUpdateMany: vi.fn(),
  txDocUpdateMany: vi.fn(),
  txDocSnapshotCreate: vi.fn(),
  metaFindMany: vi.fn(),
  metaUpsert: vi.fn(),
  metaDeleteMany: vi.fn(),
  metaUpdateMany: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst, updateMany: mocks.docUpdateMany },
    // #996/#999: 节级元数据旁路表。
    docSectionMeta: {
      findMany: mocks.metaFindMany,
      upsert: mocks.metaUpsert,
      deleteMany: mocks.metaDeleteMany,
      updateMany: mocks.metaUpdateMany,
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        doc: { updateMany: mocks.txDocUpdateMany },
        docSnapshot: { create: mocks.txDocSnapshotCreate },
      }),
  },
}))
// #999: best-effort 日志降级 — 静音(避免单测噪音)。
vi.mock('../../src/common/logger.js', () => ({ makeLogger: () => new Proxy({}, { get: () => vi.fn() }) }))

import { writeDocVersion } from '../../src/tools/doc-version-writer.js'

const USER = 'user_1'
const DOC = 'doc_1'

describe('#904 writeDocVersion 乐观锁条件更新', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.txDocUpdateMany.mockResolvedValue({ count: 1 })
    mocks.txDocSnapshotCreate.mockResolvedValue({})
    mocks.docUpdateMany.mockResolvedValue({ count: 1 })
  })

  test('未变化不落库不写快照（updatedAt 不被触碰；存量行回填投影）', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'A', snapshotLabel: 't' })
    // #989: changed=false — body/deck 不变(零事务写),返回派生投影。
    expect(res).toMatchObject({ body: 'A', deck: null, changed: false })
    expect(res.projection).not.toBeNull()
    // 正文/快照零写入。
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
    // 存量行无投影字段 → 首次写回自动建投影(条件更新,body 匹配)。
    expect(mocks.docUpdateMany).toHaveBeenCalledTimes(1)
    const [backfill] = mocks.docUpdateMany.mock.calls[0]
    expect(backfill.where).toMatchObject({ id: DOC, userId: USER, body: 'A', deck: null })
  })

  test('变化时 updateMany 以读到的旧 body+旧 deck 为 where（deck null → IS NULL）', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    // deck 传 null（不是 undefined）— Prisma where 中 null 匹配 IS NULL 行。
    expect(args.where).toEqual({ id: DOC, userId: USER, body: 'A', deck: null })
    expect(args.where.deck).toBeNull()
    expect(args.data.body).toBe('B')
    expect(mocks.txDocSnapshotCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ docId: DOC, userId: USER, body: 'A', deck: null, label: 't' }),
    })
    expect(res.changed).toBe(true)
  })

  test('deck 非空 — where/快照带旧 deck 字符串，落库带新 deck 序列化值', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":1}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', deck: { v: 2 }, snapshotLabel: 't' })
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    expect(args.where.deck).toBe('{"v":1}')
    expect(args.data.deck).toBe('{"v":2}')
    expect(mocks.txDocSnapshotCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ body: 'A', deck: '{"v":1}' }),
    })
    // 返回的 deck 是解析后的对象。
    expect(res.deck).toEqual({ v: 2 })
  })

  test('deck 保持现值（input.deck 省略）— 落库 deck 原样、返回旧 deck 解析值', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":1}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    expect(args.data.deck).toBe('{"v":1}')
    expect(res.deck).toEqual({ v: 1 })
  })

  test('0 行命中 = 并发冲突 → conflict 标记 + 可重试 error，不写快照', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    mocks.txDocUpdateMany.mockResolvedValue({ count: 0 })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    expect(res.conflict).toBe(true)
    expect(res.changed).toBe(false)
    expect(res.error).toContain('并发修改')
    expect(res.error).toContain('重试')
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
  })

  // review 复核#5: baseBody 把「调用方读 → writer 读」窗口并入乐观锁。
  test('baseBody 与当前 body 不一致 → 冲突拒绝(调用方读-算-写窗口受保护)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'B', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'C', baseBody: 'A', snapshotLabel: 't' })
    expect(res.conflict).toBe(true)
    expect(res.changed).toBe(false)
    expect(res.projection).toBeNull()
    // 零写入
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
    expect(mocks.docUpdateMany).not.toHaveBeenCalled()
  })

  test('baseBody 与当前 body 一致 → 正常落库(where 用当前 body)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', baseBody: 'A', snapshotLabel: 't' })
    expect(res.conflict).toBeUndefined()
    expect(res.changed).toBe(true)
    // 复审轮 5 一致性债务: bodyChanged/deckChanged 权威暴露（调用方不再启发式重算）
    expect(res.bodyChanged).toBe(true)
    expect(res.deckChanged).toBe(false)
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    expect(args.where.body).toBe('A')
  })

  test('deck 变化 → deckChanged 权威标记为 true；未变化路径两者皆 false', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":1}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, deck: { v: 2 }, snapshotLabel: 't' })
    expect(res.deckChanged).toBe(true)
    expect(res.bodyChanged).toBe(false)
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":2}' })
    const unchanged = await writeDocVersion({ userId: USER, docId: DOC, snapshotLabel: 't' })
    expect(unchanged.bodyChanged).toBe(false)
    expect(unchanged.deckChanged).toBe(false)
  })

  // 复审轮 4 P1 — deck 侧与 body 同强度的输入级基线
  test('baseDeck 与当前 deck 不一致 → 冲突拒绝（调用方读-算-写窗口受保护，零写入）', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":2}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, deck: { v: 3 }, baseDeck: '{"v":1}', snapshotLabel: 't' })
    expect(res.conflict).toBe(true)
    expect(res.changed).toBe(false)
    expect(res.projection).toBeNull()
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
    expect(mocks.docUpdateMany).not.toHaveBeenCalled()
  })

  test('baseDeck 与当前 deck 一致 → 正常落库', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":1}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, deck: { v: 2 }, baseDeck: '{"v":1}', snapshotLabel: 't' })
    expect(res.conflict).toBeUndefined()
    expect(res.changed).toBe(true)
    expect(res.deck).toEqual({ v: 2 })
  })

  test('baseDeck null 与无 deck 行一致 → 不冲突；与有 deck 行不一致 → 冲突', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const ok = await writeDocVersion({ userId: USER, docId: DOC, deck: { v: 1 }, baseDeck: null, snapshotLabel: 't' })
    expect(ok.conflict).toBeUndefined()
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: '{"v":9}' })
    const conflict = await writeDocVersion({ userId: USER, docId: DOC, deck: { v: 1 }, baseDeck: null, snapshotLabel: 't' })
    expect(conflict.conflict).toBe(true)
  })

  test('文档不存在 — error 返回且无任何写', async () => {
    mocks.docFindFirst.mockResolvedValue(null)
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    expect(res.error).toContain('Document not found')
    expect(res.changed).toBe(false)
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
  })
})

describe('#review 复核#1 — title 随写回原子落库', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.txDocUpdateMany.mockResolvedValue({ count: 1 })
    mocks.txDocSnapshotCreate.mockResolvedValue({})
    mocks.docUpdateMany.mockResolvedValue({ count: 1 })
  })

  test('body+title 同时变化 → title 进同一事务 data(不再事务外补写)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', title: 'Old', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', title: 'New', snapshotLabel: 't' })
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    expect(args.data.title).toBe('New')
    expect(args.data.body).toBe('B')
    expect(res.changed).toBe(true)
  })

  test('title-only 变化 → 不变更路径:条件更新 title,不刷 updatedAt、不建快照', async () => {
    // 投影已与 body 一致 → 不触发回填,只剩 title 一笔更新
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')
    const fresh = JSON.stringify(buildBlockProjection('A'))
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', title: 'Old', deck: null, blockProjection: fresh })
    const res = await writeDocVersion({ userId: USER, docId: DOC, title: 'New', snapshotLabel: '保存版本' })
    expect(res).toMatchObject({ body: 'A', changed: false })
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
    // title 条件更新(带 body+deck 守卫)
    expect(mocks.docUpdateMany).toHaveBeenCalledTimes(1)
    const [args] = mocks.docUpdateMany.mock.calls[0]
    expect(args.where).toMatchObject({ id: DOC, userId: USER, body: 'A' })
    expect(args.data).toEqual({ title: 'New' })
  })

  test('title 无变化 → 零写入', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', title: 'Old', deck: null, blockProjection: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, title: 'Old', snapshotLabel: 't' })
    expect(res.changed).toBe(false)
    // 投影回填仍会发生(存量行),但无 title 更新
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
  })
})

describe('#989 Phase 1 — 块投影与 body 同帧(写回单点强一致)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.txDocUpdateMany.mockResolvedValue({ count: 1 })
    mocks.txDocSnapshotCreate.mockResolvedValue({})
    mocks.docUpdateMany.mockResolvedValue({ count: 1 })
  })
  test('body 变化 → updateMany data 同帧携带 blockProjection(与 body 同事务)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: '# T\n\n## S\nnew content', snapshotLabel: 't' })
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    // 投影 JSON 合法且与 nextBody 强一致
    const projection = JSON.parse(args.data.blockProjection)
    expect(projection.schema_version).toBe(1)
    expect(projection.nodes.some((n: any) => n.kind === 'section' && n.heading === 'S')).toBe(true)
    // 返回投影对象
    expect(res.projection).toEqual(projection)
    expect(res.projection!.body_hash).toHaveLength(12)
  })

  test('并发冲突 → 投影不落库不返回(null)', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    mocks.txDocUpdateMany.mockResolvedValue({ count: 0 })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    expect(res.conflict).toBe(true)
    expect(res.projection).toBeNull()
  })

  test('存量文档首次写回(unchanged 保存)→ 自动回填缺失投影', async () => {
    // 旧文档行无投影字段(存量)
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null, blockProjection: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'A', snapshotLabel: '保存版本' })
    expect(res.changed).toBe(false)
    // 回填投影(条件更新,body 匹配 — 非事务路径,投影缺失/过期修复)
    expect(mocks.docUpdateMany).toHaveBeenCalledTimes(1)
    const [args] = mocks.docUpdateMany.mock.calls[0]
    expect(args.where).toMatchObject({ id: DOC, userId: USER, body: 'A', deck: null })
    const projection = JSON.parse(args.data.blockProjection)
    expect(projection.body_hash).toHaveLength(12)
    expect(res.projection).toEqual(projection)
    // unchanged 不产生快照
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
  })

  test('投影已与 body 一致 → 零写入(unchanged 语义不破坏)', async () => {
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')
    const fresh = JSON.stringify(buildBlockProjection('A'))
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null, blockProjection: fresh })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'A', snapshotLabel: '保存版本' })
    expect(res.changed).toBe(false)
    expect(mocks.docUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
  })

  test('投影与 body 不一致(过期)→ unchanged 保存时修复', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null, blockProjection: '{"schema_version":1,"body_hash":"000000000000","nodes":[]}' })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'A', snapshotLabel: '保存版本' })
    expect(res.changed).toBe(false)
    const [args] = mocks.docUpdateMany.mock.calls[0]
    expect(JSON.parse(args.data.blockProjection).body_hash).not.toBe('000000000000')
  })
})

describe('#996/#999 — 节级元数据（作者轴+可信度轴,写回单点挂钩）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.txDocUpdateMany.mockResolvedValue({ count: 1 })
    mocks.txDocSnapshotCreate.mockResolvedValue({})
    mocks.docUpdateMany.mockResolvedValue({ count: 1 })
    mocks.metaUpsert.mockResolvedValue({})
    mocks.metaDeleteMany.mockResolvedValue({ count: 1 })
    mocks.metaUpdateMany.mockResolvedValue({ count: 1 })
    mocks.metaFindMany.mockResolvedValue([])
  })

  /** 让 fire-and-forget 的终态化器跑完(微任务 + 定时器队列各排空一轮)。 */
  async function drainFinalizer() {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  }

  test('AI 写回:变更节 upsert author=ai + pending,sectionMeta 随返回;终态化器翻 verified', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ id: DOC, body: '## S\n旧内容', deck: null })            // writer 读旧行
      .mockResolvedValueOnce({ id: DOC, body: '## S\n新内容', deck: null })            // 终态化器重读(一致)
    mocks.metaFindMany.mockResolvedValue([
      { sectionId: 's_new', author: 'ai', verifyStatus: 'pending', updatedAt: 't1' },
    ])

    const res = await writeDocVersion({ userId: USER, docId: DOC, body: '## S\n新内容', writeSource: 'ai', snapshotLabel: 't' })
    expect(res.changed).toBe(true)
    // 变更节(hash 变)upsert 为 ai/pending
    expect(mocks.metaUpsert).toHaveBeenCalledTimes(1)
    const [upsertArgs] = mocks.metaUpsert.mock.calls[0]
    expect(upsertArgs.create).toMatchObject({ docId: DOC, userId: USER, author: 'ai', verifyStatus: 'pending' })
    expect(upsertArgs.update).toMatchObject({ author: 'ai', verifyStatus: 'pending' })
    // sectionMeta 全量 map 随返回(SSE/响应透传)
    expect(res.sectionMeta).toEqual({ s_new: { author: 'ai', verify_status: 'pending', updated_at: 't1' } })
    // #996/#1003: 实际变更节(id+标题)随返回 — 聊天改动日志按轮持久化数据源。
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')
    const expected = buildBlockProjection('## S\n新内容').nodes.find((n) => n.kind === 'section')!
    expect(res.changedSections).toEqual([{ id: expected.id, heading: 'S' }])

    // 终态化器:重读正文一致 + body_hash 重建一致 → pending 翻 verified
    await drainFinalizer()
    expect(mocks.metaUpdateMany).toHaveBeenCalledTimes(1)
    const [fin] = mocks.metaUpdateMany.mock.calls[0]
    expect(fin.where).toMatchObject({ docId: DOC, verifyStatus: 'pending' })
    expect(fin.where.sectionId.in.length).toBe(1)
    expect(fin.data.verifyStatus).toBe('verified')
  })

  test('human 写回:变更节直接 verified(用户自己的输入无需系统验证)', async () => {
    mocks.docFindFirst.mockResolvedValueOnce({ id: DOC, body: '## S\n旧内容', deck: null })
    mocks.metaFindMany.mockResolvedValue([])

    const res = await writeDocVersion({ userId: USER, docId: DOC, body: '## S\n用户改过的内容', writeSource: 'human', snapshotLabel: 't' })
    expect(res.changed).toBe(true)
    expect(mocks.metaUpsert).toHaveBeenCalledTimes(1)
    const [upsertArgs] = mocks.metaUpsert.mock.calls[0]
    expect(upsertArgs.create).toMatchObject({ author: 'human', verifyStatus: 'verified' })
    // 不安排终态化器(human 无 pending)
    await drainFinalizer()
    expect(mocks.metaUpdateMany).not.toHaveBeenCalled()
  })

  test('节 hash 未变的 body 微调:不 upsert 不清理,meta 原样返回(最后编辑者不被误覆盖)', async () => {
    // prev 与 next 的节内容/标题完全一致(仅 frontmatter 级微调形态)
    mocks.docFindFirst.mockResolvedValueOnce({ id: DOC, body: 'A', deck: null })
    mocks.metaFindMany.mockResolvedValue([{ sectionId: 's_x', author: 'human', verifyStatus: 'verified', updatedAt: 't0' }])

    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', writeSource: 'ai', snapshotLabel: 't' })
    expect(res.changed).toBe(true)
    expect(mocks.metaUpsert).not.toHaveBeenCalled()
    expect(mocks.metaDeleteMany).not.toHaveBeenCalled()
    expect(res.sectionMeta).toEqual({ s_x: { author: 'human', verify_status: 'verified', updated_at: 't0' } })
    await drainFinalizer()
    expect(mocks.metaUpdateMany).not.toHaveBeenCalled()
  })

  test('节被删除:该节 meta 清理(deleteMany),终态化器不触达已消失节', async () => {
    const oldBody = '## Keep\n内容\n\n## Gone\n被删节'
    const nextBody = '## Keep\n内容'
    mocks.docFindFirst
      .mockResolvedValueOnce({ id: DOC, body: oldBody, deck: null })
      .mockResolvedValueOnce({ id: DOC, body: nextBody, deck: null }) // 终态化器重读
    mocks.metaFindMany.mockResolvedValue([{ sectionId: 's_keep', author: 'ai', verifyStatus: 'pending', updatedAt: 't1' }])

    const res = await writeDocVersion({ userId: USER, docId: DOC, body: nextBody, writeSource: 'ai', snapshotLabel: 't' })
    expect(res.changed).toBe(true)
    // 删除节 → 另一节 hash 未变?全文变化会让 Keep 节 hash 不变(内容一致) —
    // 只剩 Gone 消失 → deleteMany 清理,upsert 不发生
    expect(mocks.metaDeleteMany).toHaveBeenCalledTimes(1)
    const [del] = mocks.metaDeleteMany.mock.calls[0]
    expect(del.where.sectionId.in).toHaveLength(1)
    // #996/#1003: 被删除节也计入改动日志(连同旧投影标题)
    const { buildBlockProjection } = await import('../../src/lib/block-projection.js')
    const gone = buildBlockProjection(oldBody).nodes.find((n) => n.kind === 'section' && n.heading === 'Gone')!
    expect(res.changedSections).toEqual([{ id: gone.id, heading: 'Gone' }])
    await drainFinalizer()
    // 无变更节 → 终态化器不触发
    expect(mocks.metaUpdateMany).not.toHaveBeenCalled()
  })

  test('终态化器重读发现正文已被并发推进 → 不翻牌(下一次写回的 pending 接管)', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ id: DOC, body: 'A', deck: null })
      .mockResolvedValueOnce({ id: DOC, body: '已变成别的正文', deck: null })
    mocks.metaFindMany.mockResolvedValue([])

    await writeDocVersion({ userId: USER, docId: DOC, body: '# T\n\n## S\nx', writeSource: 'ai', snapshotLabel: 't' })
    await drainFinalizer()
    expect(mocks.metaUpdateMany).not.toHaveBeenCalled()
  })

  test('元数据写入失败 → best-effort 降级(sectionMeta 缺省),正文写回不受影响', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    mocks.metaFindMany.mockRejectedValue(new Error('meta db down'))

    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    expect(res.changed).toBe(true)
    expect(res.body).toBe('B')
    expect(res.sectionMeta).toBeUndefined()
  })
})
