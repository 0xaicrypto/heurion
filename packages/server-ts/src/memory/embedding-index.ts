import fs from 'fs'
import path from 'path'

/**
 * Per-user embedding index (JSONL). Keeps a normalized vector per memory node
 * (fact/article) so semantic retrieval is a plain cosine scan — brute-force is
 * fine at per-user scale (#23). Only reviewed memories (applyApproved) enter
 * this index (BRAIN2_MEMORY_LIFECYCLE §4.5).
 */
export interface EmbeddingRecord {
  nodeId: string
  stableId: string
  type: 'fact' | 'article'
  patientHash?: string
  studyId?: string
  contentHash: string
  vector: number[]
  model: string
  norm: number
  updatedAt: number
}

export interface SearchHit {
  record: EmbeddingRecord
  score: number
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function normalizeVector(v: number[]): number {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum) || 1
}

export class EmbeddingIndex {
  private filePath: string
  private records: EmbeddingRecord[] = []

  constructor(baseDir: string) {
    const dir = path.join(baseDir, 'embeddings')
    fs.mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, 'index.jsonl')
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return
    try {
      const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean)
      this.records = lines.map((l) => JSON.parse(l))
    } catch {
      this.records = []
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }

  upsert(record: EmbeddingRecord): void {
    const idx = this.records.findIndex((r) => r.stableId === record.stableId && r.type === record.type)
    if (idx >= 0) this.records[idx] = record
    else this.records.push(record)
    this.persist()
  }

  remove(stableId: string, type: 'fact' | 'article'): void {
    this.records = this.records.filter((r) => !(r.stableId === stableId && r.type === type))
    this.persist()
  }

  all(): EmbeddingRecord[] {
    return [...this.records]
  }

  /**
   * Cosine scan within an optional scope (patient isolation: default only the
   * scope's records; cross-patient only when explicitly requested).
   */
  search(
    queryVec: number[],
    opts: { patientHash?: string; studyId?: string; includeCrossPatient?: boolean; topK?: number; minScore?: number } = {},
  ): SearchHit[] {
    const topK = opts.topK ?? 5
    const minScore = opts.minScore ?? 0.35
    const queryNorm = normalizeVector(queryVec)

    const hits: SearchHit[] = []
    for (const r of this.records) {
      if (opts.patientHash && r.patientHash && r.patientHash !== opts.patientHash && !opts.includeCrossPatient) continue
      if (opts.studyId && r.studyId && r.studyId !== opts.studyId) continue
      const score = cosineSimilarity(queryVec, r.vector)
      if (score < minScore) continue
      hits.push({ record: r, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /**
   * Semantic dedup: highest similarity to an existing record in the same scope.
   */
  findMostSimilar(queryVec: number[], opts: { patientHash?: string; studyId?: string } = {}): SearchHit | null {
    const hits = this.search(queryVec, { ...opts, topK: 1, minScore: 0 })
    return hits[0] ?? null
  }

  count(): number {
    return this.records.length
  }
}
