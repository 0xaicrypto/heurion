import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * #1009 — 文件/文本类 ReferenceItem 语义索引 + 患者隔离。
 */
const mocks = vi.hoisted(() => ({
  fileIndexFindFirst: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    fileIndex: { findFirst: mocks.fileIndexFindFirst },
  },
}))
vi.mock('../../src/common/logger.js', () => ({ makeLogger: () => new Proxy({}, { get: () => vi.fn() }) }))

import { indexReferenceItem } from '../../src/memory/reference-embedding.js'
import { EmbeddingService } from '../../src/memory/embedding/embedding.service.js'

/** 确定性假 embedder：按关键词出向量，便于断言语义命中。 */
const fakeEmbed = (texts: string[]) => Promise.resolve(texts.map((t) => [t.includes('EGFR') ? 1 : 0, t.includes('BRAF') ? 1 : 0, 0.2]))

describe('#1009 indexReferenceItem', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-ref-embed-${Date.now()}`)
  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(path.join(tmpDir, 'u1', 'uploads'), { recursive: true })
    mocks.fileIndexFindFirst.mockReset()
    mocks.fileIndexFindFirst.mockResolvedValue(null)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('文本类引用：分块写入 type=reference，语义检索可命中', async () => {
    const n = await indexReferenceItem(
      { id: 'ref_text_1', userId: 'u1', kind: 'pasted_text', snapshot: 'EGFR 突变患者的治疗策略与耐药机制', label: '材料' },
      { embedFn: fakeEmbed },
    )
    expect(n).toBeGreaterThanOrEqual(1)

    const service = new EmbeddingService('u1', undefined, fakeEmbed)
    const hits = await service.retrieve('EGFR 治疗', {}, { minScore: 0.5 })
    const refHits = hits.filter((h) => h.type === 'reference')
    expect(refHits.length).toBeGreaterThanOrEqual(1)
    expect(refHits[0].content).toContain('EGFR')
  })

  test('文件类引用：携带 FileIndex.patientHash，检索按患者范围隔离', async () => {
    const fileId = '1750000999_ref.txt'
    fs.writeFileSync(path.join(tmpDir, 'u1', 'uploads', fileId), 'BRAF 抑制剂耐药后的联合治疗策略。', 'utf-8')
    mocks.fileIndexFindFirst.mockResolvedValue({ id: fileId, patientHash: 'p1' })

    const n = await indexReferenceItem(
      { id: 'ref_file_1', userId: 'u1', kind: 'file', sourceRef: fileId, snapshot: 'ref.txt', label: 'ref.txt' },
      { embedFn: fakeEmbed },
    )
    expect(n).toBeGreaterThanOrEqual(1)

    const service = new EmbeddingService('u1', undefined, fakeEmbed)
    // 患者 p1 命中；患者 p2 被隔离；无患者范围（全局）可见（record 带 patientHash 但 scope 为空不过滤）。
    const p1 = (await service.retrieve('BRAF 耐药', { patientHash: 'p1' }, { minScore: 0.5 })).filter((h) => h.type === 'reference')
    const p2 = (await service.retrieve('BRAF 耐药', { patientHash: 'p2' }, { minScore: 0.5 })).filter((h) => h.type === 'reference')
    expect(p1.length).toBeGreaterThanOrEqual(1)
    expect(p2.length).toBe(0)
  })

  test('无正文/无来源 → 0 块且不抛', async () => {
    expect(await indexReferenceItem({ id: 'x', userId: 'u1', kind: 'pasted_text', snapshot: '  ' }, { embedFn: fakeEmbed })).toBe(0)
    expect(await indexReferenceItem({ id: 'y', userId: 'u1', kind: 'file', snapshot: 'missing.txt' }, { embedFn: fakeEmbed })).toBe(0)
  })
})
