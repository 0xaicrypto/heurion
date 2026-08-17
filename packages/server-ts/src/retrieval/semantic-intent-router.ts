/**
 * #562 — semantic intent router: embedding three-way classification
 * (generate / veto / uncertain) placed BEFORE the LLM adjudication.
 *
 * Pipeline (final state):
 *   message → ① strong veto rules (EDIT/DISCUSSION, 0 cost)
 *           → ② semantic router (embedding similarity, ms-level, 0 LLM)
 *                ├─ high-confidence generate → direct pass (0 LLM)
 *                ├─ high-confidence veto     → direct conversation (0 LLM)
 *                └─ low-confidence/conflict  → ③ LLM adjudication (#557)
 *
 * Pattern follows Aurelio semantic-router (MIT): encode seed utterances per
 * intent, aggregate into per-intent centroids, cosine-similarity + per-intent
 * thresholds. Conservative by design: only a clearly-dominant score passes;
 * anything doubtful falls through to the LLM (never generate on doubt).
 *
 * Embedding is injected (test hook); production uses the existing local
 * embedding service via createAiProvider() (bge-m3), so no new runtime deps.
 */
import { cosineSimilarity } from '../memory/embedding-index.js'

export type SemanticVerdict = 'generate' | 'veto' | 'uncertain'

export interface SemanticIntentRouterOptions {
  /** Encodes a batch of texts into normalized vectors. */
  embed: (texts: string[]) => Promise<number[][]>
  /** Seed utterances that clearly ask to GENERATE a NEW file. */
  generateSeeds: string[]
  /** Seed utterances that discuss / edit EXISTING content (never generate). */
  vetoSeeds: string[]
  /**
   * Per-class minimum cosine similarity for a confident call.
   * #562 default 0.55 — conservative; low scores fall through to the LLM.
   */
  threshold?: number
  /**
   * Required gap between the best and second-best class score. A conflicting
   * (near-tie) result must NOT be decided here.
   * #562 default 0.02 — tuned offline against the SEMANTIC_TRUTH_* set with
   * bge-m3: margin 0.1 produced ~100% uncertain (int-class cosine deltas are
   * only ~0.04-0.05); 0.02 reaches generate recall ≥ 0.9 with zero mislabels.
   */
  margin?: number
}

interface ClassStats {
  centroid: number[]
  label: SemanticVerdict
}

export class SemanticIntentRouter {
  private opts: Required<Omit<SemanticIntentRouterOptions, 'embed'>> & Pick<SemanticIntentRouterOptions, 'embed'>
  private stats: ClassStats[] | null = null
  private initPromise: Promise<ClassStats[]> | null = null

  constructor(opts: SemanticIntentRouterOptions) {
    this.opts = {
      generateSeeds: opts.generateSeeds,
      vetoSeeds: opts.vetoSeeds,
      threshold: opts.threshold ?? 0.55,
      margin: opts.margin ?? 0.02,
      embed: opts.embed,
    }
  }

  /**
   * Lazy centroid building — the first classify() pays the seed-encoding
   * cost once; concurrent first calls share one promise.
   * Returns null when embedding fails (caller falls back to LLM).
   */
  private centroids(): Promise<ClassStats[] | null> {
    if (this.stats) return Promise.resolve(this.stats)
    if (!this.initPromise) {
      this.initPromise = (async (): Promise<ClassStats[]> => {
        const classes: Array<{ label: SemanticVerdict; seeds: string[] }> = [
          { label: 'generate', seeds: this.opts.generateSeeds },
          { label: 'veto', seeds: this.opts.vetoSeeds },
        ]
        const allSeeds = classes.flatMap((c) => c.seeds)
        if (allSeeds.length === 0) return []
        const allVecs = await this.opts.embed(allSeeds)
        const stats: ClassStats[] = []
        let cursor = 0
        for (const cls of classes) {
          const vecs = allVecs.slice(cursor, cursor + cls.seeds.length)
          cursor += cls.seeds.length
          if (vecs.length === 0) continue
          const centroid = vecs[0].map((_, i) => vecs.reduce((sum, v) => sum + v[i], 0) / vecs.length)
          stats.push({ centroid, label: cls.label })
        }
        this.stats = stats
        return stats
      })().catch(() => {
        // Embedding outage — degrade to no-classes; caller falls back to LLM.
        this.stats = []
        return this.stats
      })
    }
    return this.initPromise
  }

  /** #562 — embed the query once and score against each class centroid. */
  async classify(text: string): Promise<SemanticVerdict> {
    try {
      const classes = await this.centroids()
      if (!classes || classes.length < 2) return 'uncertain'
      const [queryVec] = await this.opts.embed([text])
      if (!queryVec) return 'uncertain'

      const scores = classes.map((cls) => ({
        label: cls.label,
        score: cosineSimilarity(queryVec, cls.centroid),
      }))
      scores.sort((a, b) => b.score - a.score)

      const best = scores[0]
      const second = scores[1]
      // High confidence requires: best class ≥ threshold AND a clear gap
      // over the runner-up. Anything else → LLM (conservative).
      if (best.score >= this.opts.threshold && best.score - second.score >= this.opts.margin) {
        return best.label
      }
      return 'uncertain'
    } catch {
      return 'uncertain'
    }
  }
}
