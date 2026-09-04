/**
 * §5.1 (#189): module-level registries — registered once at module load,
 * looked up per user. Kept from the original gateway unchanged (already
 * fixed for multi-user safety, #130).
 */
import type { MemoryService } from './memory.service.js'
import { makeLogger } from '../common/logger.js'
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

const log = makeLogger('memory.registry')

export function registerContextResolver(fn: ContextResolver): void {
  contextResolver = fn
}

export function getContextResolver(): ContextResolver | null {
  return contextResolver
}

export type ProposalApplier = (userId: string, proposal: MemoryProposalRow) => MemoryNode | null

let proposalApplier: ProposalApplier | null = null

export function registerProposalApplier(fn: ProposalApplier): void {
  proposalApplier = fn
}

export function getProposalApplier(): ProposalApplier | null {
  return proposalApplier
}

/**
 * #666: approval-request side effect (approvals module) — inverted via a
 * module-level hook so `memory/` never imports `modules/*`. Registered once
 * by user-context.ts; ProposalService invokes it after persisting a
 * proposal.
 */
export type ProposalCreatedHandler = (userId: string, proposal: MemoryProposalRow) => void | Promise<void>

let proposalCreatedHandler: ProposalCreatedHandler | null = null

export function registerProposalCreatedHandler(fn: ProposalCreatedHandler): void {
  proposalCreatedHandler = fn
}

export function getProposalCreatedHandler(): ProposalCreatedHandler | null {
  return proposalCreatedHandler
}

// Default applier: fact/summary → memory service write via the resolver.
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
          log.info('superseded conflicting fact', { stableId: c.stableId, proposalId: proposal.id })
        }
      }
    } catch (err) {
      log.warn('conflict supersede skipped', { reason: (err as Error).message.slice(0, 120) })
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
  if (proposal.kind === 'summary') {
    // #736/#748: carry the synthesized-from fact stableIds into the summary —
    // without them, maybeSynthesizeSummary's used-set stays empty and the
    // same batch of facts re-triggers synthesis forever.
    let sourceFactStableIds: string[] = []
    if (proposal.relatedFacts) {
      try {
        const parsed = JSON.parse(proposal.relatedFacts)
        if (Array.isArray(parsed)) sourceFactStableIds = parsed.map(String)
      } catch (err) {
        log.warn('relatedFacts parse skipped', { reason: (err as Error).message.slice(0, 120) })
      }
    }
    return ctx.memory.addSummary(
      {
        title: proposal.content.split('\n')[0].slice(0, 120) || '知识文章',
        content: proposal.content,
        sourceFactStableIds,
        provenance: { sourceKind: 'proposal', sourceRef: proposal.id },
      },
      'system',
    )
  }
  return null
}
