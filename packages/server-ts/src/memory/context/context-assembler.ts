import type { MemoryService } from '../memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { buildPersona } from '../../common/persona.js'
import type { MemoryScope, ContextBundle } from '../contracts.js'

/**
 * §5.1 (#189): per-scope context assembly extracted from the gateway.
 * Patient isolation rules (BRAIN2_MEMORY_LIFECYCLE §4.2):
 *   - patient scope: own facts in full, cross-patient only importance>=4
 *   - global scope: all facts grouped by patient
 *   - study scope: only studyId-matched facts
 */
export class ContextAssembler {
  constructor(
    private memory: MemoryService,
    private facts: FactsStore,
    private episodes: EpisodesStore,
    private skills: SkillsStore,
    private knowledge: KnowledgeStore,
  ) {}

  readContext(scope: MemoryScope): ContextBundle {
    const allFacts = this.facts.all()

    const facts = scope.patientHash
      ? this.isolatePatientFacts(allFacts, scope.patientHash)
      : scope.studyId
        ? allFacts.filter((f) => f.studyId === scope.studyId)
        : allFacts

    const episodes = this.episodes.all()
      .map((ep) => ({ daysAgo: Math.round((Date.now() - ep.createdAt) / 86400_000), summary: ep.summary }))
      .sort((a, b) => a.daysAgo - b.daysAgo)
      .slice(0, 10)

    const skills = this.skills.all()
      .filter((s) => s.successCount > 0)
      .slice(0, 5)
      .map((s) => ({ name: s.name, strategy: s.bestStrategy, successCount: s.successCount, taskCount: s.taskCount }))

    return {
      persona: buildPersona(this.facts, this.knowledge),
      patient: scope.patientHash ? this.buildPatientContext(scope.patientHash) : null,
      episodes,
      facts: facts.map((f) => ({
        stableId: f.id,
        content: f.content,
        category: f.category,
        importance: f.importance ?? 3,
        sourceType: f.sourceType,
        patientHash: f.patientHash,
        studyId: f.studyId,
        daysAgo: Math.round((Date.now() - (f.lastSeenAt || f.createdAt)) / 86400_000),
      })),
      skills,
    }
  }

  private isolatePatientFacts(allFacts: any[], patientHash: string): any[] {
    const own = allFacts.filter((f) => f.patientHash === patientHash)
    const cross = allFacts
      .filter((f) => f.patientHash && f.patientHash !== patientHash && (f.importance ?? 3) >= 4)
      .slice(0, 5)
    return [...own, ...cross]
  }

  private buildPatientContext(patientHash: string): { basicInfo: string; findings: string } | null {
    try {
      const nodes = this.memory.graph.getAllNodes()
      const findings = nodes
        .filter((n: any) => n.type === 'fact' && n.patientHash === patientHash)
        .slice(0, 20)
        .map((n: any) => `[${n.category}] ${n.content}`)
      return {
        basicInfo: `Patient: ${patientHash}`,
        findings: findings.length > 0 ? findings.join('\n') : '',
      }
    } catch {
      return null
    }
  }
}
