import { describe, test, expect, vi, beforeEach } from 'vitest'

// #904: writeDocVersion 的原子条件更新单测 — mock prisma（与
// execution-plane-fetchfile.test.ts 同款 factory 模式；交互事务把 tx
// 传回给被测函数，断言 updateMany 的乐观锁 where 与快照同帧内容）。
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docUpdateMany: vi.fn(),
  txDocUpdateMany: vi.fn(),
  txDocSnapshotCreate: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst, updateMany: mocks.docUpdateMany },
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        doc: { updateMany: mocks.txDocUpdateMany },
        docSnapshot: { create: mocks.txDocSnapshotCreate },
      }),
  },
}))

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
    const [args] = mocks.txDocUpdateMany.mock.calls[0]
    expect(args.where.body).toBe('A')
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
