import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { unifiedSearch } from '../../src/retrieval/unified-search.js'

function makeStores(baseDir: string) {
  const facts = new FactsStore(baseDir)
  const knowledge = new KnowledgeStore(baseDir)
  knowledge.add({ title: 'NSCLC 靶向治疗进展', content: '三代 EGFR-TKI 一线治疗显著延长 PFS。', status: 'current', sourceType: 'research' })
  facts.add({ content: '患者 EGFR 突变阳性', category: 'fact', importance: 4, sourceType: 'patient' })
  facts.commit(); knowledge.commit()
  return { facts, knowledge }
}

/** Stub vector 路 — 命中 document(向量独有)。 */
function stubEmbedding(hits: Array<{ stableId: string; content: string; type: string; score: number }>) {
  return {
    retrieve: async () => hits,
  } as any
}

describe('#632 unified search (keyword + vector RRF)', () => {
  test('无 embedding → 纯词法路,精确词命中', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-kw-'))
    try {
      const { facts, knowledge } = makeStores(baseDir)
      const hits = await unifiedSearch('EGFR', facts, knowledge, { topK: 5 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.map((h) => h.kind)).toContain('fact')
      expect(hits.map((h) => h.kind)).toContain('knowledge')
      // 词法命中携带去重/渲染元数据
      const f = hits.find((h) => h.kind === 'fact')
      expect(f?.factHash).toBeTruthy()
      expect(f?.category).toBe('fact')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('双路 RRF:向量独有命中(document)进入 Top-K,词法命中不降级', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-rrf-'))
    try {
      const { facts, knowledge } = makeStores(baseDir)
      const embedding = stubEmbedding([
        { stableId: 'doc_1', content: '放疗抵抗机制综述内容全文…', type: 'document', score: 0.8 },
      ])
      const hits = await unifiedSearch('EGFR', facts, knowledge, { embedding, topK: 5 })
      expect(hits.length).toBeGreaterThanOrEqual(2)
      // 词法精确命中(fact)仍在 — 不因向量路而丢失
      expect(hits.some((h) => h.kind === 'fact')).toBe(true)
      // 向量独有 document 也进入
      expect(hits.some((h) => h.kind === 'document' && h.content.includes('放疗抵抗'))).toBe(true)
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('embedding 故障 → 自动回落词法,行为不破', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-fall-'))
    try {
      const { facts, knowledge } = makeStores(baseDir)
      const embedding = {
        retrieve: async () => { throw new Error('embedding service down') },
      } as any
      const hits = await unifiedSearch('EGFR', facts, knowledge, { embedding, topK: 5 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.kind !== 'document')).toBe(true)
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('患者过滤:向量路只返回该患者的记录', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-scope-'))
    try {
      const { facts, knowledge } = makeStores(baseDir)
      const seen: any[] = []
      const embedding = {
        retrieve: async (_q: string, scope: any) => {
          seen.push(scope)
          return []
        },
      } as any
      await unifiedSearch('EGFR', facts, knowledge, { embedding, patientHash: 'p1' })
      expect(seen[0].patientHash).toBe('p1')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
