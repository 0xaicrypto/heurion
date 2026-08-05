/**
 * §5.1 (#189): module-level registries — registered once at module load,
 * looked up per user. Kept from the original gateway unchanged (already
 * fixed for multi-user safety, #130).
 */
import type { MemoryService } from './memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores'
import type { MemoryProposalRow } from './contracts.js'
import type { MemoryNode } from './memory.types'

export type ContextResolver = (userId: string) => {
  memory: MemoryService
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
} | null

let contextResolver: ContextResolver | null = null

export function registerContextResolver(fn: ContextResolver): void {
  contextResolver = fn
}

export type ProposalApplier = (userId: string, proposal: MemoryProposalRow) => MemoryNode | null

let proposalApplier: ProposalApplier | null = null

export function registerProposalApplier(fn: ProposalApplier): void {
  proposalApplier = fn
}

export function getProposalApplier(): ProposalApplier | null {
  return proposalApplier
}

// Default applier: fact/article → memory service write via the resolver.
export function defaultProposalApplier(userId: string, proposal: MemoryProposalRow): MemoryNode | null {
  const ctx = contextResolver?.(userId)
  if (!ctx) return null
  // §5.7: approving a proposal that contradicts same-scope confirmed facts
  // IS the human verdict — supersede the old memories first (history kept),
  // then write the new fact.
  if (proposal.kind === 'fact' && proposal.conflictsWith) {
    try {
      const conflicts = JSON.parse(proposal.conflictsWith) as Array<{ stableId: string; content: string }>
      for (const c of conflicts) {
        if (ctx.memory.supersedeFact(c.stableId, `Superseded by approved proposal ${proposal.id}`, 'system')) {
          console.log(`[MEMORY] Superseded conflicting fact ${c.stableId} (approved proposal ${proposal.id})`)
        }
      }
    } catch (err) {
      console.log('[MEMORY] Conflict supersede skipped:', (err as Error).message.slice(0, 120))
    }
  }
  if (proposal.kind === 'fact') {
    return ctx.memory.addFact(
      {
        content: proposal.content,
        category: 'fact',
        importance: proposal.importance,
        patientHash: proposal.patientHash || undefined,
        sourceType: proposal.scopeType === 'patient' ? 'patient' : 'general',
        provenance: { sourceKind: 'proposal', sourceRef: proposal.id },
      },
      'system',
    )
  }
  if (proposal.kind === 'article') {
    return ctx.memory.addArticle(
      {
        title: proposal.content.split('\n')[0].slice(0, 120) || '知识文章',
        content: proposal.content,
        provenance: { sourceKind: 'proposal', sourceRef: proposal.id },
      },
      'system',
    )
  }
  return null
}
