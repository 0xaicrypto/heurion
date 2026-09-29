import { resolveTierModel } from '../../common/llm-gateway.js'
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
import { getUserContext } from '../shared/user-context.js'
import { getApiKey, deepseekChat} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import type { LlmTelemetryContext } from '../../common/llm.js'
import { makeLogger } from '../../common/logger.js'
import { acquireSchedulerLease } from '../../common/scheduler-lease.js'

const log = makeLogger('skills.experience-synthesis')

export interface ExperienceCandidate {
  name: string
  description: string
  steps: string[]
  prompt: string
  sources: string[] // fact stableIds
  sourceCount: number
  /** #844 收编:走提案闸门后的提案行引用(未走闸门的旧运行无此字段)。 */
  proposalId?: string
  proposalStatus?: string
}

const SYNTHESIS_SYSTEM = `你是临床经验沉淀助手。根据多条已确认的诊疗事实，合成一条可复用的经验（skill）。
要求：
- 只合成事实中共同支持的通用经验，不臆造
- 输出 STRICT JSON：{"name":"经验名","description":"一句话说明适用场景","steps":["步骤"],"prompt":"可直接复用的提示词模板"}
- 事实不足（<3条）或主题分散时，输出 {"name":"","description":"","steps":[],"prompt":""}`

function parseCandidate(raw: string | null | undefined): ExperienceCandidate | null {
  // #694: parseLlmJson — fence 剥离 + 容错，解析失败/无名时回 null。
  const parsed = parseLlmJson<Record<string, unknown>>(raw)
  if (!parsed || !parsed.name) return null
  return {
    name: String(parsed.name).slice(0, 120),
    description: String(parsed.description || '').slice(0, 300),
    steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: unknown) => String(s).slice(0, 500)) : [],
    prompt: String(parsed.prompt || '').slice(0, 4000),
    sources: [],
    sourceCount: 0,
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
    { model: resolveTierModel('fast'), maxTokens: 1200, telemetryContext },
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
      // #844 收编:产物不再落 CapturedSkill pending_review(绕过写入闸门),
      // 改走提案闸门(kind='skill' — PII 扫描 + 审批后经 applier 落图)。
      const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
      const { buildSkillProposalPayload } = await import('../../memory/skill-node-factory.js')
      const gateway = new MemoryGraphGateway(userId, ctx.memory)
      const proposal = await gateway.propose({
        scopeType: 'global',
        kind: 'skill',
        content: `${candidate.name} — ${candidate.description}`,
        importance: 3,
        confidence: 'medium',
        reason: `经验归纳(${candidate.sourceCount} 条已确认事实,主题 ${category})`,
        payload: buildSkillProposalPayload({
          name: candidate.name,
          description: candidate.description,
          steps: candidate.steps,
          promptTemplate: candidate.prompt,
          taskKind: 'edit',
          triggers: [candidate.name].filter(Boolean),
          scope: 'personal',
          source: 'synthesis',
          evidence: { trajectoryIds: [], sessionIds: [], observationCount: candidate.sourceCount, correctionRate: 0 },
        }, `experience:${category}`),
      })
      candidates.push({ ...candidate, proposalId: proposal.id, proposalStatus: proposal.status })
    } catch (err) {
      log.warn('[experience-synthesis] group failed:', (err as Error).message.slice(0, 150))
    }
  }
  return { candidates, groups: groups.length }
}

export interface ExperienceSynthesisScheduler {
  start(): void
  stop(): void
}

/** #1146: 每页用户数 — 旧实现 take:50 无游标,第 51 个用户永远轮不到。 */
export const EXPERIENCE_USER_PAGE_SIZE = 100

export interface ExperienceTickDeps {
  listUserPage?: (cursor: string | undefined, take: number) => Promise<Array<{ id: string }>>
  synthesize?: typeof synthesizeExperience
}

/**
 * #1146: 单轮经验归纳（导出供测试注入依赖）。
 *  - 游标分页遍历全部用户（orderBy id 保证稳定）；
 *  - 单个用户失败不中止整轮（旧实现一个用户抛错 → 后续用户全部跳过）。
 */
export async function runExperienceSynthesisTick(
  opts: { minFacts?: number; maxCandidates?: number } = {},
  deps: ExperienceTickDeps = {},
): Promise<{ users: number; created: number; failed: number }> {
  const listUserPage = deps.listUserPage ?? ((cursor, take) => prisma.user.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }))
  const synthesize = deps.synthesize ?? synthesizeExperience
  let cursor: string | undefined
  let users = 0
  let created = 0
  let failed = 0
  for (;;) {
    const rows = await listUserPage(cursor, EXPERIENCE_USER_PAGE_SIZE).catch(() => [] as Array<{ id: string }>)
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
    for (const { id: userId } of rows) {
      users++
      try {
        const r = await synthesize(userId, opts)
        created += r.candidates.length
      } catch (err) {
        failed++
        log.warn(`[EXPERIENCE-SYNTHESIS] user ${userId} failed: ${(err as Error).message.slice(0, 120)}`)
      }
    }
    if (rows.length < EXPERIENCE_USER_PAGE_SIZE) break
  }
  return { users, created, failed }
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
          // #1154: DB 租约防重入（多实例/滚动发布）。
          if (!(await acquireSchedulerLease('experience-synthesis', intervalMs))) {
            log.info('[EXPERIENCE-SYNTHESIS] tick skipped — lease held elsewhere')
            return
          }
          // #1146: 分页遍历全量用户 + 逐用户容错（旧实现 take:50 无排序/游标，
          // 且单用户抛错中止整轮）。
          const { users, created, failed } = await runExperienceSynthesisTick(opts)
          log.info(`[EXPERIENCE-SYNTHESIS] tick: ${users} users, ${created} candidates, ${failed} failed`)
        } catch (err) {
          log.error('[EXPERIENCE-SYNTHESIS] tick failed:', (err as Error).message.slice(0, 200))
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
