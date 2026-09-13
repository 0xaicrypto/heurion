import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1005 — DocReference → ReferenceItem/SessionReference 回填迁移:
 * 幂等（可重跑）、跨文档去重、file/kb/pasted 映射与 guideline 启发式归类。
 */
const db = vi.hoisted(() => ({
  items: new Map<string, any>(),
  sessionRefs: new Map<string, any>(),
  docRefs: [] as any[],
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    docReference: {
      count: vi.fn(async () => db.docRefs.length),
      findMany: vi.fn(async ({ skip, take }: any) => db.docRefs.slice(skip, skip + take)),
    },
    referenceItem: {
      findUnique: vi.fn(async ({ where }: any) => db.items.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (db.items.has(data.id)) throw new Error('unique')
        db.items.set(data.id, data)
        return data
      }),
    },
    sessionReference: {
      findUnique: vi.fn(async ({ where }: any) => {
        const r = db.sessionRefs.get(where.id)
        return r ? { ...r, reference: db.items.get(r.referenceId) } : null
      }),
      create: vi.fn(async ({ data }: any) => {
        if (db.sessionRefs.has(data.id)) throw new Error('unique')
        db.sessionRefs.set(data.id, data)
        return data
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    fileIndex: {
      findFirst: vi.fn(async ({ where }: any) => (where.id === 'file_1' ? { id: 'file_1' } : null)),
    },
  },
}))

/** #1005: 分类器由调用方注入（生产为 modules/shared/summary-lookup）。 */
const classifyGuideline = async (_userId: string, label: string) =>
  label === '已知摘要题目'
    ? { kind: 'kb_summary' as const, sourceRef: 'sum_x' }
    : { kind: 'pasted_text' as const, sourceRef: null }

import { ensureReferenceMigration } from '../../src/common/reference-migration.js'

beforeEach(() => {
  db.items.clear()
  db.sessionRefs.clear()
  db.docRefs = [
    { id: 'r1', docId: 'doc_a', userId: 'u1', refType: 'note', targetId: '', snapshot: '共享正文', sourceNodes: JSON.stringify({ label: '粘贴' }), createdAt: 't1' },
    { id: 'r2', docId: 'doc_b', userId: 'u1', refType: 'note', targetId: '', snapshot: '共享正文', sourceNodes: JSON.stringify({ label: '粘贴' }), createdAt: 't2' },
    { id: 'r3', docId: 'doc_a', userId: 'u1', refType: 'pdf', targetId: 'file_1', snapshot: 'paper.pdf', sourceNodes: JSON.stringify({ label: 'paper.pdf' }), createdAt: 't3' },
    { id: 'r4', docId: 'doc_a', userId: 'u1', refType: 'guideline', targetId: '', snapshot: '指南/摘要正文', sourceNodes: JSON.stringify({ label: '已知摘要题目' }), createdAt: 't4' },
    { id: 'r5', docId: 'doc_a', userId: 'u1', refType: 'guideline', targetId: '', snapshot: '临床指南粘贴正文', sourceNodes: JSON.stringify({ label: '某某指南' }), createdAt: 't5' },
  ]
})

describe('#1005 reference migration', () => {
  test('回填:跨文档去重(1 item + N mount)、file/kb/pasted 归类正确', async () => {
    await ensureReferenceMigration({ classifyGuideline })

    expect(db.items.size).toBe(4) // 共享正文(note) / paper.pdf / 摘要(kb) / 临床指南(pasted)
    expect(db.sessionRefs.size).toBe(5)

    const pasted = [...db.items.values()].find((i) => i.snapshot === '共享正文')!
    expect(pasted.kind).toBe('pasted_text')
    const mounts = [...db.sessionRefs.values()].filter((r) => r.referenceId === pasted.id)
    expect(mounts.map((m) => m.sessionId).sort()).toEqual(['doc-doc_a', 'doc-doc_b'])

    const file = [...db.items.values()].find((i) => i.snapshot === 'paper.pdf')!
    expect(file.kind).toBe('file')
    expect(file.sourceRef).toBe('file_1')

    const kb = [...db.items.values()].find((i) => i.label === '已知摘要题目')!
    expect(kb.kind).toBe('kb_summary')
    expect(kb.sourceRef).toBe('sum_x')

    const clinical = [...db.items.values()].find((i) => i.label === '某某指南')!
    expect(clinical.kind).toBe('pasted_text')
  })

  test('幂等:重复执行不产生新行(全部命中确定性 ID 跳过)', async () => {
    await ensureReferenceMigration({ classifyGuideline })
    const itemsAfterFirst = db.items.size
    const refsAfterFirst = db.sessionRefs.size

    await ensureReferenceMigration({ classifyGuideline })

    expect(db.items.size).toBe(itemsAfterFirst)
    expect(db.sessionRefs.size).toBe(refsAfterFirst)
  })

  test('空旧表:直接 no-op', async () => {
    db.docRefs = []
    await ensureReferenceMigration({ classifyGuideline })
    expect(db.items.size).toBe(0)
    expect(db.sessionRefs.size).toBe(0)
  })
})
