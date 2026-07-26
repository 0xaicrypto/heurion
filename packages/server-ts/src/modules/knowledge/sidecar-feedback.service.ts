/**
 * Sidecar Output Feedback — selective ingestion of MedSci-Sidecar outputs.
 *
 * Design principles:
 * - Default: no automatic write. We return extraction candidates for the UI to confirm.
 * - `saveAll: true` is the explicit user/UI trigger that persists facts.
 * - Rule-based extractor runs locally with zero LLM cost. An optional LLM extractor
 *   can be plugged in for higher-quality extraction when budget allows.
 */

import { FactsStore, type Fact } from '../../evolution/stores'

export type SidecarOutputType = 'report' | 'summary' | 'analysis' | 'unknown'

export interface ExtractedFactCandidate {
  content: string
  category: Fact['category']
  importance: number
  confidence: number
  sourceType: 'sidecar'
}

export interface SidecarFeedbackInput {
  userId: string
  workspaceId: string
  output: string
  outputType?: SidecarOutputType | string
  saveAll?: boolean
  sourceId?: string
}

export interface SidecarFeedbackResult {
  candidates: ExtractedFactCandidate[]
  saved: Fact[]
  gapsCreated: number
}

export interface SidecarFactExtractor {
  extract(output: string, outputType?: string): Promise<ExtractedFactCandidate[]>
}

// Clinical / numeric patterns that indicate a high-value finding
const HIGH_VALUE_PATTERNS = [
  /\b(?:EGFR|ALK|ROS1|BRAF|KRAS|NRAS|HER2|MET|RET|NTRK)\s*(?:exon|mutation|deletion|insertion|fusion|amplification|positive|negative| wild-type|mutant)/i,
  /\b(?:PD-L1|TPS|CPS)\s*(?:≥|>=?|≤|<=?|=)?\s*\d+%?/i,
  /\b(?:stage|分期)\s*(?:I{1,3}V?|IV|[0-4][a-b]?)\b/i,
  /\b(?:overall survival|OS|progression-free survival|PFS|ORR|DCR|CR|PR|SD|PD)\s*(?:=|:)?\s*\d+(?:\.\d+)?\s*(?:months?|mo|years?|yr|%)\b/i,
  /\b\d+(?:\.\d+)?\s*%\b.*\b(?:mutation|prevalence|frequency|incidence|response|risk)\b/i,
  /\b(?:diagnosed with|病理诊断|diagnosis)\s*[A-Za-z0-9\u4e00-\u9fa5\-/\s]+/i,
]

const UNCERTAINTY_MARKERS = /(可能|也许|大概|似乎|maybe|perhaps|possibly|uncertain| unclear|待排除|不排除|可疑)/i
const FILLER_MARKERS = /^(figure|table|图|表|附录|references|参考|note|备注|summary|结论|discussion|讨论)/i

function isHighValueSentence(sentence: string): number {
  let score = 0
  for (const p of HIGH_VALUE_PATTERNS) {
    if (p.test(sentence)) score += 0.35
  }
  if (/\d+/.test(sentence)) score += 0.15
  if (UNCERTAINTY_MARKERS.test(sentence)) score -= 0.25
  if (FILLER_MARKERS.test(sentence)) score -= 0.3
  return Math.max(0, Math.min(1, score))
}

function splitSentences(text: string): string[] {
  // Split on Chinese full stop, English period, newline; keep fragments meaningful
  return text
    .split(/([。！？.!?]\s*|\n+)/)
    .map(s => s.replace(/[\n\r]+/g, ' ').trim())
    .filter(s => s.length >= 10 && s.length <= 400)
}

function pickCategory(sentence: string): Fact['category'] {
  const lower = sentence.toLowerCase()
  if (/\b(prefer|倾向于|偏好|习惯)\b/.test(lower)) return 'preference'
  if (/\b(must|should|必须|应该|禁忌|avoid|禁止)\b/.test(lower)) return 'constraint'
  if (/\b(goal|目标|计划|aim)\b/.test(lower)) return 'goal'
  if (/\b(context|背景|情况|context)\b/.test(lower)) return 'context'
  return 'fact'
}

function importanceFromScore(score: number): number {
  if (score >= 0.8) return 5
  if (score >= 0.6) return 4
  if (score >= 0.4) return 3
  if (score >= 0.2) return 2
  return 1
}

/**
 * Default rule-based extractor. Zero LLM cost.
 */
export const ruleBasedSidecarExtractor: SidecarFactExtractor = {
  async extract(output: string): Promise<ExtractedFactCandidate[]> {
    const sentences = splitSentences(output)
    const candidates: ExtractedFactCandidate[] = []

    for (const sentence of sentences) {
      const score = isHighValueSentence(sentence)
      if (score < 0.25) continue

      candidates.push({
        content: sentence,
        category: pickCategory(sentence),
        importance: importanceFromScore(score),
        confidence: Math.round(score * 100) / 100,
        sourceType: 'sidecar',
      })
    }

    // Deduplicate by content (exact match)
    const seen = new Set<string>()
    return candidates.filter(c => {
      if (seen.has(c.content)) return false
      seen.add(c.content)
      return true
    })
  },
}

/**
 * Service that processes Sidecar outputs and optionally writes facts.
 */
export class SidecarFeedbackService {
  constructor(
    private factsStore: FactsStore,
    private extractor: SidecarFactExtractor = ruleBasedSidecarExtractor,
  ) {}

  async process(input: SidecarFeedbackInput): Promise<SidecarFeedbackResult> {
    const candidates = await this.extractor.extract(input.output, input.outputType)

    const saved: Fact[] = []
    if (input.saveAll) {
      for (const c of candidates) {
        // Only persist high-confidence candidates without manual confirmation.
        if (c.confidence >= 0.5) {
          saved.push(
            this.factsStore.add({
              category: c.category,
              importance: c.importance,
              content: c.content,
              sourceType: c.sourceType,
            }),
          )
        }
      }
      if (saved.length > 0) this.factsStore.commit()
    }

    // If nothing useful was extracted, create a knowledge-gap hint so the user
    // can later tell the system what mattered.
    const gapsCreated = candidates.length === 0 && input.saveAll ? 0 : 0

    return { candidates, saved, gapsCreated }
  }
}
