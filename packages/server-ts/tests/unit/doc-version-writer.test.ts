import { describe, test, expect, vi, beforeEach } from 'vitest'

// #904: writeDocVersion 的原子条件更新单测 — mock prisma（与
// execution-plane-fetchfile.test.ts 同款 factory 模式；交互事务把 tx
// 传回给被测函数，断言 updateMany 的乐观锁 where 与快照同帧内容）。
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  txDocUpdateMany: vi.fn(),
  txDocSnapshotCreate: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst },
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
  })

  test('未变化不落库不写快照（updatedAt 不被触碰）', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: DOC, body: 'A', deck: null })
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'A', snapshotLabel: 't' })
    expect(res).toEqual({ body: 'A', deck: null, changed: false })
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
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

  test('文档不存在 — error 返回且无任何写', async () => {
    mocks.docFindFirst.mockResolvedValue(null)
    const res = await writeDocVersion({ userId: USER, docId: DOC, body: 'B', snapshotLabel: 't' })
    expect(res.error).toContain('Document not found')
    expect(res.changed).toBe(false)
    expect(mocks.txDocUpdateMany).not.toHaveBeenCalled()
    expect(mocks.txDocSnapshotCreate).not.toHaveBeenCalled()
  })
})
