import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import { recencyWeight, daysAgo } from './attention.js'

/**
 * §5.4 (#197): single persona builder shared by user-context and the
 * memory gateway. §13.3A: the global persona must never contain
 * patient-scoped facts; §13.3B: top facts rank by importance × recency.
 */
export function personaFactScore(f: { importance?: number; lastSeenAt?: number; createdAt?: number }): number {
  const ts = (f.lastSeenAt || f.createdAt || Date.now())
  return (f.importance ?? 3) * recencyWeight(daysAgo(ts), 0.3)
}

export function buildPersona(facts: FactsStore, knowledge: KnowledgeStore): string {
  const allFacts = facts.all().filter(f => !f.patientHash && !f.studyId)
  const prefs = allFacts.filter(f => f.category === 'preference').sort((a, b) => b.importance - a.importance)
  const goals = allFacts.filter(f => f.category === 'goal').slice(0, 3)
  const topFacts = allFacts
    .filter(f => f.category === 'fact')
    .sort((a, b) => personaFactScore(b) - personaFactScore(a))
    .slice(0, 5)
  const knowledgeArticles = knowledge.all().filter(k => k.status === 'current').slice(0, 5)

  const parts: string[] = [
    'You are Heurion, a clinical AI assistant for oncology research.',
    'Be concise, evidence-based, and reference relevant patient data and accumulated knowledge.',
    'Only reference patients that appear in the Patient Roster above.',
    'Do not invent or hallucinate patient names, diagnoses, or clinical details.',
    'When stating a diagnosis, use only the exact terminology present in the patient profile or source documents. Do not infer or upgrade to a more specific diagnosis (for example, do not say "lung adenocarcinoma" if the profile only indicates NSCLC or a suspicious nodule).',
  ]

  if (prefs.length > 0) {
    parts.push('\nYour accumulated preferences:')
    for (const p of prefs.slice(0, 5)) {
      parts.push(`- ${p.content} (importance: ${p.importance}/5)`)
    }
  }

  if (goals.length > 0) {
    parts.push('\nActive goals:')
    for (const g of goals) parts.push(`- ${g.content}`)
  }

  if (knowledgeArticles.length > 0) {
    parts.push('\nYour knowledge base includes:')
    for (const k of knowledgeArticles) parts.push(`- ${k.title}`)
  }

  if (topFacts.length > 0) {
    parts.push('\nKey clinical facts you track:')
    for (const f of topFacts.slice(0, 3)) parts.push(`- ${f.content}`)
  }

  return parts.join('\n')
}
