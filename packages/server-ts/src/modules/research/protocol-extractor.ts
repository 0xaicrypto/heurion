import { deepseekChat, getApiKey } from '../../common/llm.js'

export interface ProtocolRule {
  id: string
  category: 'inclusion' | 'exclusion' | 'safety' | 'schedule'
  rule: string
  confirmed: boolean
  extractedAt: string
}

// In-memory store for pending rules (per study)
const pendingRules = new Map<string, ProtocolRule[]>()

/**
 * Extract structured rules from protocol text using DeepSeek.
 * Returns proposed rules organized by category.
 */
export async function extractRulesFromProtocol(
  studyId: string, protocolText: string
): Promise<ProtocolRule[]> {
  const prompt = `Extract structured clinical trial rules from this protocol. Return ONLY a JSON object with these keys:

{
  "inclusion": ["rule 1", "rule 2", ...],
  "exclusion": ["rule 1", "rule 2", ...],
  "safety": [{"name": "DLT definition", "rule": "...", "grade": N, "triggered": false}, ...],
  "schedule": [{"visit": "Screening", "timing": "Day -28 to -1", "assessments": ["CT", "labs"]}, ...]
}

Protocol text:
${protocolText.slice(0, 8000)}`

  try {
    const result = await deepseekChat([{ role: 'user', content: prompt }], getApiKey())
    const match = result.match(/\{[\s\S]*\}/)
    if (!match) return []

    const data = JSON.parse(match[0])
    const now = new Date().toISOString()
    const rules: ProtocolRule[] = []

    // Inclusions
    for (const r of (data.inclusion || [])) {
      rules.push({ id: `inc_${rules.length}`, category: 'inclusion', rule: r, confirmed: false, extractedAt: now })
    }
    // Exclusions
    for (const r of (data.exclusion || [])) {
      rules.push({ id: `exc_${rules.length}`, category: 'exclusion', rule: r, confirmed: false, extractedAt: now })
    }
    // Safety rules
    for (const r of (data.safety || [])) {
      rules.push({ id: `saf_${rules.length}`, category: 'safety', rule: `${r.name}: ${r.rule}`, confirmed: false, extractedAt: now })
    }
    // Schedule
    for (const r of (data.schedule || [])) {
      rules.push({
        id: `sch_${rules.length}`, category: 'schedule',
        rule: `${r.visit} (${r.timing}): ${(r.assessments || []).join(', ')}`,
        confirmed: false, extractedAt: now,
      })
    }

    pendingRules.set(studyId, rules)
    return rules
  } catch {
    return []
  }
}

export function getPendingRules(studyId: string): ProtocolRule[] {
  return pendingRules.get(studyId) || []
}

export function confirmRule(studyId: string, ruleId: string): ProtocolRule | null {
  const rules = pendingRules.get(studyId) || []
  const rule = rules.find(r => r.id === ruleId)
  if (rule) rule.confirmed = true
  return rule || null
}

export function rejectRule(studyId: string, ruleId: string): boolean {
  const rules = pendingRules.get(studyId) || []
  const idx = rules.findIndex(r => r.id === ruleId)
  if (idx >= 0) { rules.splice(idx, 1); return true }
  return false
}

export function getConfirmationStatus(studyId: string): { total: number; confirmed: number; pending: number } {
  const rules = pendingRules.get(studyId) || []
  return {
    total: rules.length,
    confirmed: rules.filter(r => r.confirmed).length,
    pending: rules.filter(r => !r.confirmed).length,
  }
}
