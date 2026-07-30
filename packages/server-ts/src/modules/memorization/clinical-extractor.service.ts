import { getApiKey, deepseekChat } from '../../common/llm.js'

export interface ClinicalEntity {
  node_type: 'finding' | 'med' | 'ddx' | 'measurement' | 'semantic_fact'
  content: { label: string; canonical_en?: string }
  evidence_quote: string
  confidence: number
}

export interface ExtractionResult {
  raw_llm_output: string
  entities: ClinicalEntity[]
  tokensIn: number
  tokensOut: number
  latencyMs: number
  drops: Record<string, number>
  rawCount: number
}

const SYSTEM_PROMPT = `You extract structured clinical entities from a chat encounter between a physician and a clinical assistant.

OUTPUT FORMAT — STRICT JSON ONLY. Your entire response is a single JSON object: {"entities": [ ... ]}. Never add prose before/after. Never use markdown fences.

Each entity:
  node_type: "finding" | "med" | "ddx" | "measurement" | "semantic_fact"
  content: { label: "<short canonical name>", canonical_en: "<optional English form>" }
  evidence_quote: VERBATIM substring of the source text
  confidence: 0.0-1.0

Language: match source text language for labels. Acronyms/units/scales keep canonical form.
Quality: Only extract what the chat clearly establishes. Skip speculative mentions. Prefer one canonical label per concept.`

function parseJsonSafe(raw: string): any {
  let s = (raw || '').trim()
  if (!s) return {}
  try { return JSON.parse(s) } catch {}
  const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try { return JSON.parse(fenced) } catch {}
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)) } catch {}
  }
  return {}
}

export async function extractClinicalEntities(
  sourceText: string,
  options?: { model?: string; maxTokens?: number },
): Promise<ExtractionResult> {
  const t0 = Date.now()
  const apiKey = getApiKey()
  const model = options?.model || 'deepseek-chat'
  const maxTokens = options?.maxTokens || 4000

  let raw = ''
  try {
    raw = await deepseekChat(
      [{ role: 'user', content: sourceText }],
      apiKey,
      { model, maxTokens, temperature: 0.2 },
    )
  } catch (err) {
    return {
      raw_llm_output: `(extractor error: ${(err as Error).message})`,
      entities: [],
      tokensIn: Math.ceil(sourceText.length / 4),
      tokensOut: 0,
      latencyMs: Date.now() - t0,
      drops: {},
      rawCount: 0,
    }
  }

  const parsed = parseJsonSafe(raw)
  const entitiesRaw = Array.isArray(parsed)
    ? parsed
    : parsed.entities || parsed.items || parsed.clinical_entities || []

  const drops = { not_dict: 0, bad_node_type: 0, no_label: 0, no_evidence: 0, not_verbatim: 0 }
  const validTypes = new Set(['finding', 'med', 'ddx', 'measurement', 'semantic_fact'])
  const entities: ClinicalEntity[] = []

  for (const item of entitiesRaw) {
    if (!item || typeof item !== 'object') { drops.not_dict++; continue }
    if (!validTypes.has(item.node_type)) { drops.bad_node_type++; continue }
    const content = item.content || {}
    if (!content.label) { drops.no_label++; continue }
    const evidence = (item.evidence_quote || '').trim()
    if (!evidence) { drops.no_evidence++; continue }
    if (!sourceText.includes(evidence)) { drops.not_verbatim++; continue }
    entities.push({
      node_type: item.node_type,
      content: { label: content.label, canonical_en: content.canonical_en },
      evidence_quote: evidence,
      confidence: Math.max(0, Math.min(1, parseFloat(item.confidence) || 0.7)),
    })
  }

  return {
    raw_llm_output: raw,
    entities,
    tokensIn: Math.ceil(sourceText.length / 4),
    tokensOut: Math.ceil(raw.length / 4),
    latencyMs: Date.now() - t0,
    drops,
    rawCount: entitiesRaw.length,
  }
}
