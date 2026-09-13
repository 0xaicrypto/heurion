import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1005 — 引用材料两层模型 store:确定性 ID / 幂等 upsert / 会话挂载语义。
 * 内存版 prisma mock（ReferenceItem/SessionReference/FileIndex）。
 */
const db = vi.hoisted(() => ({
  items: new Map<string, any>(),
  sessionRefs: new Map<string, any>(),
  fileIndexFindFirst: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    referenceItem: {
      findUnique: vi.fn(async ({ where }: any) => db.items.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (db.items.has(data.id)) throw new Error('unique constraint')
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
        if (db.sessionRefs.has(data.id)) throw new Error('unique constraint')
        db.sessionRefs.set(data.id, data)
        return data
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...db.sessionRefs.values()]
          .filter((r: any) => r.userId === where.userId && r.sessionId === where.sessionId)
          .map((r: any) => ({ ...r, reference: db.items.get(r.referenceId) }))),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0
        for (const [id, r] of [...db.sessionRefs.entries()]) {
          if (r.userId === where.userId && r.sessionId === where.sessionId && r.referenceId === where.referenceId) {
            db.sessionRefs.delete(id)
            count++
          }
        }
        return { count }
      }),
    },
    fileIndex: { findFirst: db.fileIndexFindFirst },
  },
}))

import {
  referenceIdentityKey, referenceItemId, sessionReferenceId,
  normalizeLegacyRefType, resolveOrCreateReferenceItem, addSessionReference,
  listSessionReferences, removeSessionReference, removeSessionReferenceByContent,
  resolveFileSourceRef, docSessionId,
} from '../../src/lib/reference-store.js'

beforeEach(() => {
  db.items.clear()
  db.sessionRefs.clear()
  db.fileIndexFindFirst.mockReset()
  db.fileIndexFindFirst.mockResolvedValue(null)
})

describe('#1005 reference-store — 确定性 ID 与 identity', () => {
  test('pasted_text 按正文哈希去重;file/kb 按来源 id', () => {
    expect(referenceIdentityKey({ kind: 'pasted_text', snapshot: '同一段文字' }))
      .toBe(referenceIdentityKey({ kind: 'pasted_text', snapshot: '同一段文字' }))
    expect(referenceIdentityKey({ kind: 'pasted_text', snapshot: 'A' }))
      .not.toBe(referenceIdentityKey({ kind: 'pasted_text', snapshot: 'B' }))
    // file:sourceRef 相同时 label 不同也视为同一素材
    expect(referenceIdentityKey({ kind: 'file', sourceRef: 'f1', label: 'a.pdf' }))
      .toBe(referenceIdentityKey({ kind: 'file', sourceRef: 'f1', label: 'b.pdf' }))
  })

  test('确定性 id:同输入稳定,不同用户隔离;session 挂载 id 稳定', () => {
    const key = referenceIdentityKey({ kind: 'pasted_text', snapshot: 'x' })
    expect(referenceItemId('u1', key)).toBe(referenceItemId('u1', key))
    expect(referenceItemId('u1', key)).not.toBe(referenceItemId('u2', key))
    expect(sessionReferenceId('doc-1', 'ref_a')).toBe(sessionReferenceId('doc-1', 'ref_a'))
    expect(docSessionId('doc_abc')).toBe('doc-doc_abc')
  })

  test('旧 refType → 新 kind 结构映射', () => {
    expect(normalizeLegacyRefType('pdf')).toBe('file')
    expect(normalizeLegacyRefType('docx')).toBe('file')
    expect(normalizeLegacyRefType('file')).toBe('file')
    expect(normalizeLegacyRefType('note')).toBe('pasted_text')
    expect(normalizeLegacyRefType('kb_summary')).toBe('kb_summary')
    expect(normalizeLegacyRefType(undefined)).toBe('pasted_text')
  })
})

describe('#1005 reference-store — 幂等挂载与删除语义', () => {
  test('同一内容跨会话:1 个 item + N 个 session refs,重复调用幂等', async () => {
    const item = { userId: 'u1', kind: 'pasted_text' as const, snapshot: '共享正文' }
    const a1 = await addSessionReference({ userId: 'u1', sessionId: 'doc-1', item })
    const a2 = await addSessionReference({ userId: 'u1', sessionId: 'doc-1', item }) // 幂等重放
    const b = await addSessionReference({ userId: 'u1', sessionId: 'doc-2', item })
    expect(a1.item.id).toBe(a2.item.id)
    expect(a1.item.id).toBe(b.item.id)
    expect(db.items.size).toBe(1)
    expect(db.sessionRefs.size).toBe(2)
    expect((await listSessionReferences('u1', 'doc-1')).map((r) => r.referenceId)).toEqual([a1.item.id])
  })

  test('取消引用只删会话挂载,item 本体保留', async () => {
    const added = await addSessionReference({ userId: 'u1', sessionId: 'doc-1', item: { userId: 'u1', kind: 'pasted_text', snapshot: 'x' } })
    expect(await removeSessionReference('u1', 'doc-1', added.item.id)).toBe(true)
    expect(db.sessionRefs.size).toBe(0)
    expect(db.items.size).toBe(1)
    // 幂等:再删返回 false
    expect(await removeSessionReference('u1', 'doc-1', added.item.id)).toBe(false)
  })

  test('旧 DELETE 适配:按 snapshot 匹配删除挂载', async () => {
    await addSessionReference({ userId: 'u1', sessionId: 'doc-1', item: { userId: 'u1', kind: 'pasted_text', snapshot: '要删的正文' } })
    await addSessionReference({ userId: 'u1', sessionId: 'doc-1', item: { userId: 'u1', kind: 'pasted_text', snapshot: '保留的正文' } })
    expect(await removeSessionReferenceByContent('u1', 'doc-1', { snapshot: '要删的正文' })).toBe(true)
    expect((await listSessionReferences('u1', 'doc-1')).some((r) => r.item.snapshot === '要删的正文')).toBe(false)
    expect((await listSessionReferences('u1', 'doc-1')).some((r) => r.item.snapshot === '保留的正文')).toBe(true)
  })

  test('file sourceRef:targetId 是真 FileIndex id 时优先;否则按名字兜底', async () => {
    db.fileIndexFindFirst.mockResolvedValueOnce({ id: 'file_123' })
    expect(await resolveFileSourceRef('u1', 'file_123', 'paper.pdf')).toBe('file_123')
    db.fileIndexFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'file_byname' })
    expect(await resolveFileSourceRef('u1', 'patient_hash_deadbeef', 'paper.pdf')).toBe('file_byname')
    db.fileIndexFindFirst.mockResolvedValue(null)
    expect(await resolveFileSourceRef('u1', '', 'missing.pdf')).toBeNull()
  })
})
