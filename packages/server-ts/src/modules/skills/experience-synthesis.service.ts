/**
 * #24 — Experience Synthesis Worker: distill reusable clinical experience
 * candidates from MULTIPLE confirmed cases (memory-graph facts), in
 * contrast to skill capture (#298) which works from a single conversation.
 *
 * Flow: collect confirmed facts (importance ≥ 3) → group by category →
 * LLM synthesizes one candidate per group (name / description / steps /
 * prompt) with provenance (source fact ids) → persisted as a CapturedSkill
 * with status 'pending_review' so the doctor approves in the Skills page.
 *
 * Triggers: manual (POST /api/v1/skills/synthesize) + periodic scheduler.
 */
import prisma from '../../common/prisma.js'
import { getUserContext } from '../chat/user-context.js'
import { getApiKey, deepseekChat, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import type { LlmTelemetryContext } from '../../common/llm.js'

export interface ExperienceCandidate {
  name: string
  description: string
  steps: string[]
  prompt: string
  sources: string[] // fact stableIds
  sourceCount: number
}

const SYNTHESIS_SYSTEM = `你是临床经验沉淀助手。根据多条已确认的诊疗事实，合成一条可复用的经验（skill）。
要求：
- 只合成事实中共同支持的通用经验，不臆造
- 输出 STRICT JSON：{"name":"经验名","description":"一句话说明适用场景","steps":["步骤"],"prompt":"可直接复用的提示词模板"}
- 事实不足（<3条）或主题分散时，输出 {"name":"","description":"","steps":[],"prompt":""}`

function parseCandidate(raw: string | null | undefined): ExperienceCandidate | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed.name) return null
    return {
      name: String(parsed.name).slice(0, 120),
      description: String(parsed.description || '').slice(0, 300),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: unknown) => String(s).slice(0, 500)) : [],
      prompt: String(parsed.prompt || '').slice(0, 4000),
      sources: [],
      sourceCount: 0,
    }
  } catch {
    return null
  }
}

async function synthesizeGroup(
  category: string,
  facts: Array<{ stableId: string; content: string }>,
  telemetryContext?: LlmTelemetryContext,
): Promise<ExperienceCandidate | null> {
  const factBlock = facts
    .map((f) => `- ${f.content}`)
    .join('\n')
  const raw = await deepseekChat(
    [
      { role: 'system', content: SYNTHESIS_SYSTEM },
      { role: 'user', content: `主题分类：${category}\n已确认事实（${facts.length} 条）：\n${factBlock.slice(0, 6000)}` },
    ],
    getApiKey(),
    { model: DEEPSEEK_CHAT_MODEL, maxTokens: 1200, telemetryContext },
  )
  const candidate = parseCandidate(raw)
  if (!candidate) return null
  candidate.sources = facts.map((f) => f.stableId)
  candidate.sourceCount = facts.length
  return candidate
}

/**
 * Run synthesis for one user. Groups the user's confirmed facts by
 * category; groups with ≥ minFacts produce a candidate. Returns the
 * candidates created (persisted as pending_review skills).
 */
export async function synthesizeExperience(
  userId: string,
  opts: { minFacts?: number; maxCandidates?: number } = {},
): Promise<{ candidates: ExperienceCandidate[]; groups: number }> {
  const minFacts = opts.minFacts ?? 3
  const maxCandidates = opts.maxCandidates ?? 3
  const ctx = getUserContext(userId)

  const current = ctx.memory.graph
    .getCurrentNodesByType('fact')
    .filter((n: any) => (n.importance ?? 0) >= 3 && n.status !== 'superseded') as any[]

  // Group by category.
  const byCategory = new Map<string, Array<{ stableId: string; content: string }>>()
  for (const n of current) {
    const cat = String(n.category || 'fact')
    const list = byCategory.get(cat)
    const entry = { stableId: n.stableId, content: String(n.content || '') }
    if (list) list.push(entry)
    else byCategory.set(cat, [entry])
  }

  const groups = Array.from(byCategory.entries())
    .filter(([, facts]) => facts.length >= minFacts)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCandidates)

  const candidates: ExperienceCandidate[] = []
  for (const [category, facts] of groups) {
    try {
      const candidate = await synthesizeGroup(category, facts, {
        userId,
        workspaceId: userId,
        action: 'experience.synthesize',
      })
      if (!candidate) continue
      // Persist as a pending-review skill with provenance.
      const now = new Date().toISOString()
      await (prisma as any).capturedSkill.create({
        data: {
          userId,
          name: candidate.name,
          description: candidate.description,
          steps: JSON.stringify(candidate.steps),
          prompt: candidate.prompt,
          sourceSession: JSON.stringify({ kind: 'experience-synthesis', category, sources: candidate.sources, at: now }),
          status: 'pending_review',
          createdAt: now,
          updatedAt: now,
        },
      })
      candidates.push(candidate)
    } catch (err) {
      console.warn('[experience-synthesis] group failed:', (err as Error).message.slice(0, 150))
    }
  }
  return { candidates, groups: groups.length }
}

export interface ExperienceSynthesisScheduler {
  start(): void
  stop(): void
}

/** Periodic synthesis over all users with enough material (every 24h). */
export function createExperienceSynthesisScheduler(
  intervalMs: number,
  opts: { minFacts?: number; maxCandidates?: number } = {},
): ExperienceSynthesisScheduler {
  let timer: ReturnType<typeof setInterval> | null = null

  return {
    start() {
      if (timer) return
      timer = setInterval(async () => {
        try {
          // Facts live in per-user JSONL (memory graph), not Prisma —
          // enumerate users and let synthesizeExperience skip thin graphs.
          const rows = await (prisma as any).user.findMany({
            select: { id: true },
            take: 50,
          }).catch(() => [] as Array<{ id: string }>)
          const userIds = (rows as Array<{ id: string }>).map((r) => r.id)
          let created = 0
          for (const userId of userIds) {
            const r = await synthesizeExperience(userId, opts)
            created += r.candidates.length
          }
          console.log(`[EXPERIENCE-SYNTHESIS] tick: ${userIds.length} users, ${created} candidates`)
        } catch (err) {
          console.error('[EXPERIENCE-SYNTHESIS] tick failed:', (err as Error).message.slice(0, 200))
        }
      }, intervalMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
