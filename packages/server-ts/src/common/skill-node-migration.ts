/**
 * #842 — CapturedSkill(confirmed)→ graph SkillNode v2 一次性迁移(幂等)。
 *
 * 设计 C1:graph SkillNode 单一事实源;CapturedSkill 降级为 intake 草稿区,
 * confirm 语义 = promote。D6:原行标 `promoted` 后零逻辑参与(纯归档,
 * 防内容漂移无据可查)。LearnedSkill/VersionedStore 退役归 #840 批次,不在本脚本。
 *
 * 幂等性三重保证:
 *  1. 只扫 status='confirmed' 的行 — promote 后状态变化,重跑零命中;
 *  2. stableId 固定为 `skill_cap_<capturedId>` — graph.addNode 按 id 覆盖,
 *     同 stableId 高版本号才替换,重复构建无副作用;
 *  3. PII 命中行跳过不迁移(行保持 confirmed,日志留痕,人工回炉)。
 */
import prisma from './prisma.js'
import { makeLogger } from './logger.js'
import { scanSkillPii } from './pii-scanner.js'
import type { SkillNode } from '../memory/memory.types.js'
import { buildSkillNode } from '../memory/skill-node-factory.js'

const log = makeLogger('migrate.skill-node')

export interface SkillNodeMigrationResult {
  migrated: number
  skippedPii: number
  promoted: number
}

export function skillCapStableId(capturedId: string): string {
  return `skill_cap_${capturedId}`
}

/** CapturedSkill 行 → SkillNode v2(纯映射,PII 检查由调用方先行)。 */
export function buildSkillNodeFromCaptured(
  ownerId: string,
  row: { id: string; name: string; description: string; steps: string; prompt: string; sourceSession?: string | null },
): SkillNode {
  let steps: string[] = []
  try {
    const parsed = JSON.parse(row.steps || '[]')
    if (Array.isArray(parsed)) steps = parsed.map(String).slice(0, 20)
  } catch { /* 旧格式 → 空步骤 */ }
  const name = String(row.name || '').slice(0, 120)
  const description = String(row.description || '').slice(0, 300)
  // #842: 构建统一走 skill-node-factory(v2 字段白名单收口)。
  return buildSkillNode(ownerId, {
    stableId: skillCapStableId(row.id),
    provenanceRef: `captured_skill:${row.id}`, // D6: promoted 行留档的审计反查链
    name,
    description,
    steps,
    promptTemplate: String(row.prompt || '').slice(0, 4000),
    // CapturedSkill 无动作标注 — 首发场景为写作/编辑流程(设计 D2)。
    taskKind: 'edit',
    triggers: [name].filter(Boolean),
    scope: 'personal',
    source: 'capture',
    evidence: {
      trajectoryIds: [],
      sessionIds: row.sourceSession ? [row.sourceSession] : [],
      observationCount: 0,
      correctionRate: 0,
    },
  })
}

export async function ensureSkillNodeMigration(): Promise<SkillNodeMigrationResult> {
  const result: SkillNodeMigrationResult = { migrated: 0, skippedPii: 0, promoted: 0 }
  try {
    const rows = await prisma.capturedSkill.findMany({ where: { status: 'confirmed' } })
    if (!rows || rows.length === 0) return result

    // 按 userId 分组,逐用户在其 graph 中落地。
    const { getUserContext } = await import('../modules/shared/user-context.js')
    const byUser = new Map<string, any[]>()
    for (const row of rows) {
      const list = byUser.get(row.userId) || []
      list.push(row)
      byUser.set(row.userId, list)
    }

    for (const [userId, userRows] of byUser) {
      let ctx: ReturnType<typeof getUserContext> | null = null
      try {
        ctx = getUserContext(userId)
      } catch (err) {
        log.warn('skill migration: user context unavailable', { userId, reason: (err as Error).message.slice(0, 120) })
        continue
      }
      for (const row of userRows) {
        const node = buildSkillNodeFromCaptured(userId, row)
        const pii = scanSkillPii({ name: node.name, description: node.description, steps: node.steps, promptTemplate: node.promptTemplate })
        if (!pii.clean) {
          result.skippedPii++
          log.warn('skill migration: PII hit, skipped (row stays confirmed for rework)', {
            capturedId: row.id, hits: pii.hits.map((h) => h.kind).join(','),
          })
          continue
        }
        ctx.memory.graph.addNode(node)
        await prisma.capturedSkill.update({
          where: { id: row.id },
          data: { status: 'promoted', updatedAt: new Date().toISOString() },
        })
        result.migrated++
        log.info('skill migration: captured → SkillNode', { capturedId: row.id, stableId: node.stableId })
      }
    }
    if (result.migrated > 0 || result.skippedPii > 0) {
      log.info('skill-node migration applied', { ...result })
    }
  } catch (err) {
    // 迁移失败不阻塞启动 — 下次 boot 幂等重试。
    log.warn('skill-node migration skipped', { reason: (err as Error).message.slice(0, 160) })
  }
  return result
}
