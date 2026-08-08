import path from 'path'
import fs from 'fs'
import { EventLog } from '../../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { ChatOrchestrator } from './chat.orchestrator.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { MemoryService } from '../../memory/memory.service.js'
import { defaultProposalApplier, registerContextResolver, registerProposalApplier } from '../../memory/memory-gateway.js'
// §5.4 (#197): persona lives in common/persona.ts (shared with memory gateway).
import { buildPersona, personaFactScore } from '../../common/persona.js'
export { buildPersona, personaFactScore }

const TTL_MS = 30 * 60 * 1000 // 30 minutes idle → evict
const telemetry = new PrismaTelemetryService()
const GC_INTERVAL_MS = 5 * 60 * 1000

interface UserContext {
  eventLog: EventLog; facts: FactsStore; episodes: EpisodesStore; skills: SkillsStore; knowledge: KnowledgeStore
  memory: MemoryService
  orchestrator: ChatOrchestrator
  lastAccess: number
}

const contexts = new Map<string, UserContext>()
let gcTimer: ReturnType<typeof setInterval> | null = null

// Per-user memory access for the approval flow. Registered ONCE at module
// load with a closure over the contexts map — resolving by the requested
// userId at call time keeps every user's memory strictly isolated (a naive
// per-getUserContext registration would overwrite the previous user's).
registerContextResolver((applierUserId) => {
  const current = contexts.get(applierUserId)
  if (!current) return null
  return {
    memory: current.memory,
    facts: current.facts,
    episodes: current.episodes,
    skills: current.skills,
    knowledge: current.knowledge,
  }
})
registerProposalApplier(defaultProposalApplier)

export function evictUserContext(userId: string): void {
  const ctx = contexts.get(userId)
  if (ctx) {
    try { ctx.eventLog.close() } catch { /* ignore */ }
    contexts.delete(userId)
  }
}

function ensureGC() {
  if (gcTimer) return
  gcTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, ctx] of contexts) {
      if (now - ctx.lastAccess > TTL_MS) {
        ctx.eventLog.close()
        contexts.delete(id)
      }
    }
  }, GC_INTERVAL_MS).unref()
}

export function getUserContext(userId: string): Omit<UserContext, 'lastAccess'> {
  ensureGC()
  const existing = contexts.get(userId)
  if (existing) { existing.lastAccess = Date.now(); return existing }
  const baseDir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId)
  fs.mkdirSync(baseDir, { recursive: true })
  const eventLog = new EventLog(baseDir, userId)
  const facts = new FactsStore(baseDir)
  const episodes = new EpisodesStore(baseDir)
  const skills = new SkillsStore(baseDir)
  const knowledge = new KnowledgeStore(baseDir)
  const contracts = new ContractEngine()
  contracts.addRule({
    name: 'max_response_length',
    description: 'Response should not exceed 2000 tokens',
    check: (ctx) => {
      const est = Math.ceil(ctx.length / 4)
      return est > 2000 ? { passed: false, violations: [`Too long (${est} tokens)`], score: 0.5 } : { passed: true, violations: [], score: 1 }
    },
  })
  const memory = new MemoryService({
    eventLog,
    baseDir,
    legacyFacts: facts,
    legacyKnowledge: knowledge,
    ownerId: userId,
  })
  const orchestrator = new ChatOrchestrator(eventLog, facts, episodes, skills, knowledge, contracts, telemetry, memory)
  const ctx = { eventLog, facts, episodes, skills, knowledge, memory, orchestrator, lastAccess: Date.now() }
  contexts.set(userId, ctx)

  return ctx
}

/**
 * Build dynamic Persona from user's accumulated Facts and Knowledge.
 * Used as the system prompt prefix for all chat contexts.
 */
/**
 * K5 — persona cache. The persona only depends on facts + knowledge, so it
 * is rebuilt only when either store's version changes (any commit bumps the
 * VersionedStore version); identical turns reuse the cached string.
 */
// #301: bounded LRU persona cache — Map insertion order doubles as recency
// (every hit re-inserts); eviction drops the least-recently-used entry.
const PERSONA_CACHE_MAX = 100
const personaCache = new Map<string, { factsVersion: string | null; knowledgeVersion: string | null; persona: string }>()

export function buildCachedPersona(userId: string, facts: FactsStore, knowledge: KnowledgeStore): string {
  const fv = facts.currentVersion()
  const kv = knowledge.currentVersion()
  const cached = personaCache.get(userId)
  if (cached && cached.factsVersion === fv && cached.knowledgeVersion === kv) {
    // LRU touch: move to the most-recent end.
    personaCache.delete(userId)
    personaCache.set(userId, cached)
    return cached.persona
  }
  const persona = buildPersona(facts, knowledge)
  personaCache.delete(userId)
  personaCache.set(userId, { factsVersion: fv, knowledgeVersion: kv, persona })
  if (personaCache.size > PERSONA_CACHE_MAX) {
    // Evict the least-recently-used entry (oldest insertion order).
    const oldest = personaCache.keys().next().value
    if (oldest !== undefined) personaCache.delete(oldest)
  }
  return persona
}

/**
 * §13.3B — importance × recency score (attentionScore semantics):
 * score = importance × e^(-0.3 × daysAgo). Recency decays ~74% per day.
 */
export function buildFileContext(files: Array<{
  file_id: string; name: string; size_bytes: number;
  textContent?: string | null; createdAt: string
}>): string {
  if (!files || files.length === 0) return ''
  const parts = ['## Recent Files']
  for (const f of files.slice(0, 5)) {
    const size = f.size_bytes < 1024 ? `${f.size_bytes}B`
      : f.size_bytes < 1024 * 1024 ? `${(f.size_bytes / 1024).toFixed(1)}KB`
      : `${(f.size_bytes / (1024 * 1024)).toFixed(1)}MB`
    const excerpt = f.textContent ? f.textContent.slice(0, 120) : ''
    parts.push(`- ${f.name} (${size})${excerpt ? ': ' + excerpt : ''}`)
  }
  return parts.join('\n')
}
