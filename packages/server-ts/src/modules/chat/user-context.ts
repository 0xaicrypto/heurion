import path from 'path'
import fs from 'fs'
import { EventLog } from '../../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { ChatOrchestrator } from './chat.orchestrator.js'

const TTL_MS = 30 * 60 * 1000 // 30 minutes idle → evict
const GC_INTERVAL_MS = 5 * 60 * 1000

interface UserContext {
  eventLog: EventLog; facts: FactsStore; episodes: EpisodesStore; skills: SkillsStore; knowledge: KnowledgeStore
  orchestrator: ChatOrchestrator
  lastAccess: number
}

const contexts = new Map<string, UserContext>()
let gcTimer: ReturnType<typeof setInterval> | null = null

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
  const ctx = { eventLog, facts, episodes, skills, knowledge, orchestrator: new ChatOrchestrator(eventLog, facts, episodes, skills, contracts), lastAccess: Date.now() }
  contexts.set(userId, ctx)
  return ctx
}

/**
 * Build dynamic Persona from user's accumulated Facts and Knowledge.
 * Used as the system prompt prefix for all chat contexts.
 */
export function buildPersona(facts: FactsStore, knowledge: KnowledgeStore): string {
  const allFacts = facts.all()
  const prefs = allFacts.filter(f => f.category === 'preference').sort((a, b) => b.importance - a.importance)
  const goals = allFacts.filter(f => f.category === 'goal').slice(0, 3)
  const topFacts = allFacts.filter(f => f.category === 'fact').sort((a, b) => b.count - a.count).slice(0, 5)
  const knowledgeArticles = knowledge.all().filter(k => k.status === 'current').slice(0, 5)

  const parts: string[] = [
    'You are Heurion, a clinical AI assistant for oncology research.',
    'Be concise, evidence-based, and reference relevant patient data and accumulated knowledge.',
    'Only reference patients that appear in the Patient Roster above.',
    'Do not invent or hallucinate patient names, diagnoses, or clinical details.',
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

/**
 * Build file context block for a patient's recent files.
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
