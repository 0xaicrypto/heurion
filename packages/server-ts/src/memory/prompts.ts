/**
 * #683 — shared LLM prompt templates.
 *
 * Extraction/synthesis prompts were hand-rolled per call site (compaction
 * runner vs files.router; knowledge.router vs knowledge-synthesis), drifting
 * in language and schema. Canonical templates live here; call sites only
 * pass data.
 */
import { EXTRACTION_RULES } from './compaction/budget.js'

export { EXTRACTION_RULES }

// ── Fact extraction ────────────────────────────────────────────

export interface FactExtractionPromptOptions {
  text: string
  /** Extra context (scope facts, patient context) injected before the text. */
  contextBlock?: string
  /** Dynamic quality guidance from acceptance stats (13.4F). */
  qualityGuidance?: string
  /** document → file-upload extraction; conversation → compaction runner. */
  mode?: 'document' | 'conversation'
}

export function factExtractionPrompt({ text, contextBlock, qualityGuidance, mode = 'conversation' }: FactExtractionPromptOptions): string {
  if (mode === 'document') {
    return `Extract key facts from this clinical document. Return ONLY a JSON array of objects with: category (fact/preference/constraint/goal/context), importance (1-5), content (short sentence), sourceType (patient/doctor/research/general).\n\n${text}\n\n[JSON array]:`
  }
  return `You are a clinical memory extractor. From the conversation below, extract ONLY facts worth persisting for future reference.

${EXTRACTION_RULES}

Return ONLY a JSON array:
[{"content": "consolidated fact", "category": "diagnosis|symptom|exam|medication|allergy|constraint|preference|plan", "importance": 1-5, "sourceType": "patient|doctor|research", "conflictsWith": ["stableId of a same-scope confirmed fact, only when contradicting"]}]

Importance: 5 = changes treatment/diagnosis; 4 = important clinical fact; 3 = general; 1-2 = marginal (omit).
${qualityGuidance}
${contextBlock}
Conversation:
${text}

[JSON array]:`
}

// ── Knowledge-article synthesis ───────────────────────────────

export const ARTICLE_SYNTHESIS_PERSONA = {
  zh: '你是临床知识合成器。基于以下已确认的事实合成一篇简短知识文章（1-2 段，临床可执行）：',
  researcherEn: `You are synthesizing clinical findings for an oncology researcher.
Synthesize the following facts into a concise, clinically actionable knowledge article.
Keep it to 1-2 paragraphs and a short title.`,
} as const

export function articleSynthesisPrompt(factList: string, persona: string = ARTICLE_SYNTHESIS_PERSONA.zh): string {
  const isEn = persona.includes('You are')
  return `${persona}\n\nFacts:\n${factList}\n\n${isEn ? 'Return ONLY JSON' : '返回 ONLY JSON'}: { "title": "...", "content": "..." }`
}

// ── Clinical entity extraction (chat-ingester / evolution worker) ──

export const CLINICAL_ENTITY_SCHEMA = `[
  {
    "node_type": "finding|med|ddx|measurement|semantic_fact",
    "content": { "label": "...", "canonical_en": "optional English term" },
    "evidence_quote": "verbatim substring from the conversation",
    "confidence": 0.0-1.0
  }
]`

export function clinicalEntityExtractionPrompt(sourceText: string): string {
  return `Extract structured clinical entities from the conversation. Return ONLY a JSON array in this shape:
${CLINICAL_ENTITY_SCHEMA}

Rules:
- node_type: finding (symptom/exam result), med (medication), ddx (differential diagnosis), measurement (lab value), semantic_fact (other)
- evidence_quote MUST be a verbatim substring of the source text
- confidence 0.0-1.0

Conversation:
${sourceText}

[JSON array]:`
}
