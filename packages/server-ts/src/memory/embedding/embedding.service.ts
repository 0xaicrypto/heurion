import path from 'path'
import { makeLogger } from '../../common/logger.js'
import { EmbeddingIndex, normalizeVector } from '../embedding-index.js'
import type { MemoryService } from '../../memory/memory.service.js'
import type { MemoryScope } from '../contracts.js'
import { isNodeSuperseded } from '../memory.types.js'

/**
 * §5.1 (#189): embedding concerns extracted from the gateway.
 * Lazy-loads the embedder/index; concurrent first calls share one
 * creation promise (fixes the double-initialization race).
 */
const log = makeLogger('memory.embedding.service')

export class EmbeddingService {
  private _embeddingIndex: EmbeddingIndex | null = null
  private _embed: Promise<((texts: string[]) => Promise<number[][]>) | null> | null = null

  constructor(
    private userId: string,
    private memory?: MemoryService,
    private embedFn?: (texts: string[]) => Promise<number[][]>,
  ) {}

  embeddingIndex(): EmbeddingIndex {
    if (!this._embeddingIndex) {
      const baseDir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.userId)
      this._embeddingIndex = new EmbeddingIndex(baseDir)
    }
    return this._embeddingIndex
  }

  private embedder(): Promise<((texts: string[]) => Promise<number[][]>) | null> {
    if (this.embedFn) return Promise.resolve(this.embedFn)
    if (!this._embed) {
      // Single creation promise — concurrent callers await the same one.
      this._embed = (async () => {
        try {
          const { createAiProvider } = await import('../../common/ai/ai-provider.js')
          const provider = createAiProvider()
          return (texts: string[]) => provider.embed(texts)
        } catch {
          return null
        }
      })()
    }
    return this._embed
  }

  /** Embed text; returns null when the embedding service is unavailable. */
  async embedOrNull(text: string): Promise<number[] | null> {
    try {
      const embed = await this.embedder()
      if (!embed) return null
      const vecs = await embed([text])
      return vecs[0] ?? null
    } catch (err) {
      log.warn('embedding unavailable', { reason: (err as Error).message.slice(0, 120) })
      return null
    }
  }

  /** §5.1 (#189): index an approved memory (reviewed memories only enter RAG). */
  async indexApproved(input: {
    nodeId: string
    stableId: string
    type: 'fact' | 'article'
    content: string
    patientHash?: string | null
    studyId?: string | null
  }): Promise<void> {
    try {
      const vec = await this.embedOrNull(input.content)
      if (!vec) return
      this.embeddingIndex().upsert({
        nodeId: input.nodeId,
        stableId: input.stableId,
        type: input.type,
        patientHash: input.patientHash || undefined,
        studyId: input.studyId || undefined,
        contentHash: input.content.slice(0, 16),
        vector: vec,
        model: 'bge-m3',
        norm: normalizeVector(vec),
        updatedAt: Date.now(),
      })
    } catch (err) {
      log.warn('embedding index write skipped', { reason: (err as Error).message.slice(0, 120) })
    }
  }

  /**
   * Semantic retrieval (Tier 2). Superseded/deleted facts are never
   * surfaced (§2.2 #183) — an edited or removed fact must not be fed back
   * to the LLM as context.
   */
  async retrieve(
    query: string,
    scope: MemoryScope,
    opts: { topK?: number; minScore?: number; includeCrossPatient?: boolean } = {},
  ): Promise<Array<{ stableId: string; content: string; type: string; score: number }>> {
    const vec = await this.embedOrNull(query)
    if (!vec) return []
    return this.retrieveWithVec(vec, scope, opts)
  }

  /** Same as retrieve but with a pre-embedded query vector (gateway injects a stubbed embedder in tests). */
  async retrieveWithVec(
    vec: number[],
    scope: MemoryScope,
    opts: { topK?: number; minScore?: number; includeCrossPatient?: boolean } = {},
  ): Promise<Array<{ stableId: string; content: string; type: string; score: number }>> {
    const hits = this.embeddingIndex().search(vec, {
      patientHash: scope.patientHash,
      studyId: scope.studyId,
      includeCrossPatient: opts.includeCrossPatient,
      topK: opts.topK ?? 5,
      minScore: opts.minScore ?? 0.35,
    })
    const results: Array<{ stableId: string; content: string; type: string; score: number }> = []
    for (const h of hits) {
      let content = h.record.contentHash
      try {
        const node = this.memory?.graph.getLatestByStableId(h.record.stableId) as any
        if (node && isNodeSuperseded(node)) continue
        if (node?.content) content = node.content
      } catch { /* keep hash preview */ }
      results.push({
        stableId: h.record.stableId,
        content,
        type: h.record.type,
        score: h.score,
      })
    }
    return results
  }
}
