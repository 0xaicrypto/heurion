/**
 * #844 环② — 轨迹归纳器(epic #841 Phase 1,设计 §3.2)。
 *
 * 聚类:同 taskKind + 工具序列指纹(toolsUsed hash);触发:observationCount≥5
 * ∧ 时间跨度≥14 天 ∧ correctionRate≤0.3。首发范围(D2):仅
 * action='generate' ∧ scene='document'(写作流程)。
 *
 * LLM 归纳复用 experience-synthesis 模式(#24):fast tier + STRICT JSON +
 * parseLlmJson(#694)。输入为轨迹聚类摘要 — **零正文**(操作元数据:工具
 * 序列/编辑计数/场景/耗时,无 query、无文档内容)。
 *
 * 产物路径:候选 → gateway.propose(kind='skill',#839 闸门),绝不直写。
 * 证据强制:候选必须携带 ≥5 条 trajectoryId + 溯源 sessionIds。
 */
import { getUserContext } from '../shared/user-context.js'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'
import { buildSkillProposalPayload } from '../../memory/skill-node-factory.js'
import { TaskTrajectoryProjection, type TaskTrajectory } from '../../evolution/trajectory.js'
import { hashContent } from '../../memory/node-base.js'
import { resolveTierModel } from '../../common/llm-gateway.js'
import { getApiKey, deepseekChat, type LlmTelemetryContext } from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { scanSkillPii } from '../../common/pii-scanner.js'
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('skills.trajectory-induction')

// ── 阈值(设计 §3.2;可被 opts 覆盖,调度器读 env)──
export const INDUCTION_DEFAULTS = {
  minObservations: 5,
  minSpanDays: 14,
  maxCorrectionRate: 0.3,
}

/** 聚类 key:taskKind + 工具序列指纹 — "做法"的最小充分统计。 */
export function clusterKey(t: Pick<TaskTrajectory, 'action' | 'toolsUsed'>): string {
  return `${t.action}|${hashContent(t.toolsUsed.join('>')).slice(0, 16)}`
}

/** 按 D2 首发范围过滤:仅写作流程(action=generate ∧ scene=document)。 */
export function inFirstWaveScope(t: Pick<TaskTrajectory, 'action' | 'scene'>): boolean {
  return t.action === 'generate' && t.scene === 'document'
}

export interface ClusterEvaluation {
  eligible: boolean
  reasons: string[]
  observationCount: number
  spanDays: number
  correctionRate: number
}

/** 阈值判定(纯函数,可测试注入任意轨迹集)。 */
export function evaluateCluster(
  cluster: Array<Pick<TaskTrajectory, 'action' | 'scene' | 'toolsUsed' | 'createdAt' | 'userCorrection'>>,
  opts: { minObservations?: number; minSpanDays?: number; maxCorrectionRate?: number } = {},
): ClusterEvaluation {
  const minObservations = opts.minObservations ?? INDUCTION_DEFAULTS.minObservations
  const minSpanDays = opts.minSpanDays ?? INDUCTION_DEFAULTS.minSpanDays
  const maxCorrectionRate = opts.maxCorrectionRate ?? INDUCTION_DEFAULTS.maxCorrectionRate

  const reasons: string[] = []
  const observationCount = cluster.length
  if (observationCount < minObservations) reasons.push(`观察不足(${observationCount}/${minObservations})`)
  const times = cluster.map((t) => t.createdAt)
  const spanDays = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / (24 * 3600 * 1000) : 0
  if (spanDays < minSpanDays) reasons.push(`时间跨度不足(${spanDays.toFixed(1)}/${minSpanDays} 天)`)
  const correctionCount = cluster.filter((t) => t.userCorrection).length
  const correctionRate = observationCount > 0 ? correctionCount / observationCount : 1
  if (correctionRate > maxCorrectionRate) reasons.push(`修正率过高(${(correctionRate * 100).toFixed(0)}%)`)

  return { eligible: reasons.length === 0, reasons, observationCount, spanDays, correctionRate }
}

/**
 * 归纳输入构造 — **零正文**审查点:只取操作元数据(工具序列/编辑计数/结局/
 * 耗时/日期),绝不携带 query、文档内容、患者信息。
 */
export function buildInductionSummary(cluster: TaskTrajectory[]): string {
  const perTurn = cluster.map((t) =>
    `- 工具序列:[${t.toolsUsed.join(' > ') || '无'}];编辑 ${t.docEdits} 次;结局 ${t.outcome};耗时 ${(t.durationMs / 1000).toFixed(0)}s;日期 ${new Date(t.createdAt).toISOString().slice(0, 10)}`)
  const corrected = cluster.filter((t) => t.userCorrection).length
  return [
    `动作类型:${cluster[0]?.action}`,
    `场景:${cluster[0]?.scene}`,
    `观察次数:${cluster.length}(用户重做 ${corrected} 次)`,
    `轨迹明细:`,
    ...perTurn,
  ].join('\n')
}

export interface InducedCandidate {
  name: string
  description: string
  steps: string[]
  promptTemplate: string
  triggers: string[]
}

const INDUCTION_SYSTEM = `你是写作流程沉淀助手。根据同一"任务轨迹聚类"的操作元数据(工具序列/编辑次数/结局),归纳一条可复用的写作流程技能(skill)。
要求:
- 只归纳轨迹共同支持的流程做法,不臆造任何具体医学内容
- 输出 STRICT JSON:{"name":"技能名","description":"一句话适用场景","steps":["步骤"],"promptTemplate":"可直接复用的提示词模板","triggers":["激活关键词1","关键词2"]}
- 轨迹不足或做法分散时,输出 {"name":"","description":"","steps":[],"promptTemplate":"","triggers":[]}`

function parseInduced(raw: string | null | undefined): InducedCandidate | null {
  const parsed = parseLlmJson<Record<string, unknown>>(raw)
  if (!parsed || !parsed.name || String(parsed.name).trim() === '') return null
  return {
    name: String(parsed.name).slice(0, 120),
    description: String(parsed.description || '').slice(0, 300),
    steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: unknown) => String(s).slice(0, 500)) : [],
    promptTemplate: String(parsed.promptTemplate || '').slice(0, 4000),
    triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map((t: unknown) => String(t).slice(0, 60)) : [],
  }
}

export interface InductionRunResult {
  proposed: number
  evaluated: number
  piiRejected: number
  details: Array<{ fingerprint: string; eligible: boolean; reasons?: string[]; proposalId?: string; piiHit?: boolean }>
}

/**
 * 单用户归纳运行:聚类 → 阈值 → LLM → PII → gateway.propose(kind='skill')。
 * 证据强制:候选 payload 携带聚类全部 trajectoryIds(≥5 由阈值保证)+ 溯源 sessionIds。
 */
export async function induceSkillsFromTrajectories(
  userId: string,
  opts: {
    minObservations?: number
    minSpanDays?: number
    maxCorrectionRate?: number
    maxProposals?: number
    telemetryContext?: LlmTelemetryContext
  } = {},
): Promise<InductionRunResult> {
  const maxProposals = opts.maxProposals ?? 2
  const result: InductionRunResult = { proposed: 0, evaluated: 0, piiRejected: 0, details: [] }

  const ctx = getUserContext(userId)
  const projection = new TaskTrajectoryProjection(ctx.eventLog)
  const trajectories = projection.query().filter(inFirstWaveScope)
  if (trajectories.length === 0) return result

  // #840-r5: pending 去重闸 — 闸门语义去重索引只含已审批内容,pending 提案
  // 不在其中;不做本闸,同一聚类会随每次 tick 重复提案直到审批完成。
  const pendingSkillRows = await (prisma as any).memoryProposal.findMany({
    where: { userId, kind: 'skill', status: 'pending' },
    select: { payload: true },
  }).catch(() => [] as Array<{ payload: string | null }>)
  const pendingFingerprints = new Set<string>(
    pendingSkillRows
      .map((r: any) => { try { return JSON.parse(r.payload || '{}')?.fingerprint } catch { return undefined } })
      .filter((f: unknown): f is string => typeof f === 'string'),
  )

  // 聚类
  const clusters = new Map<string, TaskTrajectory[]>()
  for (const t of trajectories) {
    const key = clusterKey(t)
    const list = clusters.get(key) || []
    list.push(t)
    clusters.set(key, list)
  }

  for (const [fingerprint, cluster] of clusters) {
    if (result.proposed >= maxProposals) break
    const evaluation = evaluateCluster(cluster, opts)
    result.evaluated++
    if (!evaluation.eligible) {
      result.details.push({ fingerprint, eligible: false, reasons: evaluation.reasons })
      continue
    }
    if (pendingFingerprints.has(fingerprint)) {
      result.details.push({ fingerprint, eligible: true, reasons: ['pending_duplicate_skipped'] })
      continue
    }

    // LLM 归纳(零正文输入)
    const summary = buildInductionSummary(cluster)
    let candidate: InducedCandidate | null = null
    try {
      const raw = await deepseekChat(
        [
          { role: 'system', content: INDUCTION_SYSTEM },
          { role: 'user', content: `轨迹聚类摘要(fingerprint ${fingerprint.slice(0, 8)}):\n${summary.slice(0, 6000)}` },
        ],
        getApiKey(),
        { model: resolveTierModel('fast'), maxTokens: 1200, telemetryContext: opts.telemetryContext ?? { userId, workspaceId: userId, action: 'skill.induce' } },
      )
      candidate = parseInduced(raw)
    } catch (err) {
      log.warn('[induction] llm failed:', (err as Error).message.slice(0, 150))
      result.details.push({ fingerprint, eligible: true, reasons: [`llm_failed:${(err as Error).message.slice(0, 80)}`] })
      continue
    }
    if (!candidate || candidate.steps.length === 0) {
      result.details.push({ fingerprint, eligible: true, reasons: ['llm_declined'] })
      continue
    }

    // PII 硬线(闸门前再拦一次;闸门入口亦有同扫描,纵深防御)
    const pii = scanSkillPii({ name: candidate.name, description: candidate.description, steps: candidate.steps, promptTemplate: candidate.promptTemplate })
    if (!pii.clean) {
      result.piiRejected++
      result.details.push({ fingerprint, eligible: true, piiHit: true })
      continue
    }

    // 证据强制:trajectoryIds 反查可验证(来自本投影的真实轨迹 id)
    const evidence = {
      trajectoryIds: cluster.map((t) => t.id),
      sessionIds: [...new Set(cluster.map((t) => t.sessionId))],
      observationCount: evaluation.observationCount,
      correctionRate: Number(evaluation.correctionRate.toFixed(2)),
    }

    const gateway = new MemoryGraphGateway(userId, ctx.memory)
    const proposal = await gateway.propose({
      scopeType: 'global',
      kind: 'skill',
      content: `${candidate.name} — ${candidate.description}`,
      importance: 3,
      confidence: 'medium',
      reason: `轨迹归纳(${evidence.observationCount} 条观察,修正率 ${(evidence.correctionRate * 100).toFixed(0)}%)`,
      payload: buildSkillProposalPayload({
        name: candidate.name,
        description: candidate.description,
        steps: candidate.steps,
        promptTemplate: candidate.promptTemplate,
        taskKind: 'generate',
        triggers: candidate.triggers,
        scope: 'personal',
        source: 'synthesis',
        evidence,
        toolsSequence: cluster[0]?.toolsUsed ?? [],
      }, fingerprint),
    })
    if (proposal.status === 'rejected') {
      // 闸门拒单(语义重复/工具通知过滤)— 不计 proposed,原因留痕
      result.details.push({ fingerprint, eligible: true, reasons: [`gate_rejected:${(proposal.rejectedReason ?? '').slice(0, 60)}`] })
      continue
    }
    result.proposed++
    result.details.push({ fingerprint, eligible: true, proposalId: proposal.id })
  }
  return result
}

export interface SkillInductionScheduler {
  start(): void
  stop(): void
}

/** 周期调度(默认 24h;env SKILL_INDUCE_INTERVAL_MS / SKILL_INDUCE_ENABLED)。 */
export function createSkillInductionScheduler(intervalMs: number): SkillInductionScheduler {
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    start() {
      if (timer) return
      timer = setInterval(async () => {
        try {
          // 轨迹在 per-user eventLog(JSONL)— 枚举用户,归纳器内部自查薄数据。
          const rows = await (prisma as any).user.findMany({ select: { id: true }, take: 50 }).catch(() => [] as Array<{ id: string }>)
          let proposed = 0
          for (const r of rows as Array<{ id: string }>) {
            const res = await induceSkillsFromTrajectories(r.id).catch(() => null)
            proposed += res?.proposed ?? 0
          }
          if (proposed > 0) log.info(`[SKILL-INDUCTION] tick: ${proposed} proposals`)
        } catch (err) {
          log.error('[SKILL-INDUCTION] tick failed:', (err as Error).message.slice(0, 200))
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
