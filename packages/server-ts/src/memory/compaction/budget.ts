import type { EventLog } from '../../core/event-log'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import type { MemoryService } from '../memory.service.js'

/**
 * #353: input budget & context shaping for compaction/extraction.
 * Everything that decides HOW MUCH conversation/fact context goes into an
 * LLM call lives here (prompt blocks, related-fact caps, event thresholds).
 */

export interface CompactionCtx {
  userId: string
  eventLog: EventLog
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
  memory?: MemoryService
}

export interface ExtractedFact {
  content: string
  category: string
  importance: number
  sourceType: string
  patientHash?: string
  conflictsWith?: string[]
}

/** Minimum events in a segment for compaction to bother running. */
export const MIN_COMPACT_EVENTS = 4
/** Minimum events in a segment for incremental extraction. */
export const MIN_EXTRACT_EVENTS = 2
/** Max related facts injected into the prompt (budget guard). */
export const MAX_RELATED_FACTS = 10
/** Max chars per event line injected into the prompt. */
export const MAX_EVENT_CHARS = 500

export const EXTRACTION_RULES = `Rules:
1. AGGREGATE: merge related information about the same subject into ONE consolidated fact (e.g. symptoms+course → one disease-course fact; related exam values → one finding fact). Do not split a single topic into multiple fragments.
2. LIMIT: output at most 5 facts — the most important only.
3. IMPORTANCE GATE: only facts that affect future decisions (diagnosis, treatment, monitoring, patient safety). Omit marginal details.
4. SELF-CONTAINED: include subject (patient/doctor), time or trend, and concrete values.
   GOOD: "患者 ZQ 发热持续3周伴胸痛咳嗽，亚急性病程（7月末起）"
   BAD: "针对发热+胸痛需考虑肺部感染"
5. Exclude: conversational filler ("用户想学习", "谢谢"), generic advice ("需要做检查") unless it is a concrete conclusion for this patient, system state ("名册为空"), general knowledge.
6. CONFLICT: if new information contradicts an existing confirmed fact listed in the context (same subject, opposing or updated conclusion — e.g. allergy vs no-allergy, dose/plan change), set "conflictsWith": [the stableId of the conflicting fact]. Facts of OTHER patients are never conflicts — only facts tagged with the current scope.
   GOOD: {"content": "患者当前可用青霉素（既往过敏记录有误）", "conflictsWith": ["fact_xxx"]}
   BAD: flagging a different patient's fact as a conflict.`

/**
 * §5.7: facts carry scope identity — only same-scope facts (this patient
 * or user-level global facts) are injected for dedup/conflict judgement.
 * Other patients' facts are NEVER injected (cross-patient ≠ contradiction).
 */
export function buildContextBlock(ctx: CompactionCtx, patientHash: string | undefined, sessionId: string, conversation: string): string {
  const kw = conversation.toLowerCase().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length > 3)
  const existingFacts = ctx.facts.all()
  const relatedFacts = existingFacts
    .filter(f => {
      if (f.patientHash) return f.patientHash === patientHash
      return true
    })
    .map(f => ({ f, score: kw.some(w => f.content.toLowerCase().includes(w)) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELATED_FACTS)
    .map(x => x.f)
  const episode = ctx.episodes.all().find(e => e.sessionId === sessionId)
  const contextLines: string[] = []
  if (patientHash) {
    contextLines.push(`Current patient: ${patientHash}`)
    contextLines.push('Facts about this patient should use sourceType: "patient" and include the patientHash.')
  }
  if (episode) {
    contextLines.push(`Session summary so far: ${episode.summary}`)
  }
  if (relatedFacts.length > 0) {
    contextLines.push('Existing confirmed facts in the SAME scope (use these for dedup AND conflict judgement — never flag a different patient\'s fact):')
    relatedFacts.forEach(f => {
      const tag = f.patientHash ? f.patientHash : 'user-level'
      contextLines.push(`- [${f.sourceType || 'general'}] [${tag}] (${f.id}) ${f.content}`)
    })
  }
  return contextLines.length > 0 ? `\n${contextLines.join('\n')}\n` : ''
}

/** Parse the extraction LLM output as a JSON array; null when unparseable. */
export function parseExtractionResult(result: string): Array<Record<string, any>> | null {
  const jsonMatch = result.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0])
    return Array.isArray(parsed) ? (parsed as Array<Record<string, any>>) : null
  } catch {
    return null
  }
}
