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

// ── Knowledge-summary synthesis ───────────────────────────────

export const SUMMARY_SYNTHESIS_PERSONA = {
  zh: '你是临床知识合成器。把以下已确认事实合成为一篇 answer-ready 的知识单元——面向问题自包含、每条依据可溯源到事实 ID、不确定性显式暴露。',
  researcherEn: `You are synthesizing clinical findings for an oncology researcher.
Synthesize the following facts into an answer-ready knowledge unit: self-contained for the question it answers, every claim traceable to fact IDs, uncertainty explicit.`,
} as const

/**
 * #813: answer-ready 合成契约 — 结论/依据/caveat 结构化,每个论断回指
 * 源 fact stableId(注入层据此渲染溯源标记;合成期幻觉经 factId 过滤
 * 后不会静默进入文章)。factList 每行格式:`[<stableId>] ...<content>`。
 */
export function summarySynthesisPrompt(factList: string, persona: string = SUMMARY_SYNTHESIS_PERSONA.zh): string {
  const isEn = persona.includes('You are')
  if (isEn) {
    return `${persona}

Facts (each line starts with its stable ID in brackets):
${factList}

Return ONLY JSON:
{
  "title": "short title",
  "question": "the self-contained question this knowledge answers (include subject context)",
  "conclusion": "the actionable conclusion, 1-3 sentences",
  "evidence": [
    { "claim": "one supporting point", "factIds": ["fact_xxx"], "confidence": "high|medium|low" }
  ],
  "caveats": ["uncertainty / applicability boundary / conflicting evidence"]
}

Rules:
- Every claim in "evidence" MUST cite factIds copied from the bracketed IDs above — never invent IDs.
- Anything you cannot trace to a provided fact goes into "caveats", not "evidence" or "conclusion".
- If facts conflict, state the conflict in "caveats" instead of silently picking one.

[JSON]:`
  }
  return `${persona}

Facts（每行以方括号内的稳定 ID 开头）:
${factList}

返回 ONLY JSON:
{
  "title": "简短标题",
  "question": "这段知识回答的问题（自包含,含对象语境）",
  "conclusion": "核心结论,1-3 句,临床可执行",
  "evidence": [
    { "claim": "一条依据要点", "factIds": ["fact_xxx"], "confidence": "high|medium|low" }
  ],
  "caveats": ["不确定性/适用边界/证据冲突"]
}

规则:
- evidence 中每条论断必须引用上方方括号内的 factId — 禁止编造 ID。
- 无法追溯到给定 fact 的内容一律放 caveats,不得进入 conclusion/evidence。
- 事实之间存在冲突时,在 caveats 中写明冲突,不要静默择一。

[JSON]:`
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
