import { describe, test, expect, beforeEach } from 'vitest'
import { getApp, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import { ensureSkillNodeMigration, skillCapStableId } from '../../src/common/skill-node-migration.js'
import { listCapturedSkills } from '../../src/modules/skills/skill-capture.service.js'

/**
 * #842 — CapturedSkill(confirmed)→ graph SkillNode v2 迁移。
 * 验收:迁移幂等(重复执行零副作用)/ promoted 行不参与 / PII 命中跳过。
 */

async function seedCaptured(userId: string, over: Partial<Record<string, string>> = {}): Promise<string> {
  const row = await (prisma as any).capturedSkill.create({
    data: {
      userId,
      name: over.name ?? 'References 检索纪律流程',
      description: over.description ?? '写作前强制 search_citation 真实检索',
      steps: JSON.stringify(['search_citation 检索主题', '核对 PMID/DOI', '写入 References']),
      prompt: over.prompt ?? '新增引用前必须先检索,零编造。',
      sourceSession: over.sourceSession ?? null,
      status: over.status ?? 'confirmed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  return row.id
}

describe('#842 SkillNode v2 迁移', () => {
  beforeEach(async () => {
    await (prisma as any).capturedSkill.deleteMany({})
  })

  test('confirmed 行迁入 graph(v2 契约),原行标 promoted 且不再出现在 confirmed 列表', async () => {
    const userId = await getAuthUserId()
    const capturedId = await seedCaptured(userId)

    const result = await ensureSkillNodeMigration()
    expect(result.migrated).toBe(1)

    const ctx = getUserContext(userId)
    const node: any = ctx.memory.graph.getLatestByStableId(skillCapStableId(capturedId))
    expect(node).toBeTruthy()
    // v2 契约字段
    expect(node.type).toBe('skill')
    expect(node.name).toContain('References')
    expect(node.steps.length).toBe(3)
    expect(node.promptTemplate).toContain('零编造')
    expect(node.taskKind).toBe('edit')
    expect(node.scope).toBe('personal')
    expect(node.source).toBe('capture')
    expect(node.lifecycle).toBe('active')
    expect(node.followRate).toBe(0)
    expect(node.evidence).toEqual({ trajectoryIds: [], sessionIds: [], observationCount: 0, correctionRate: 0 })
    expect(node.provenance.sourceRef).toBe(`captured_skill:${capturedId}`)

    // D6:原行 promoted 纯归档 — confirmed 列表不再含它(零逻辑参与)
    const row = await (prisma as any).capturedSkill.findUnique({ where: { id: capturedId } })
    expect(row.status).toBe('promoted')
    const confirmedList = await listCapturedSkills(userId, 'confirmed')
    expect(confirmedList.some((r: any) => r.id === capturedId)).toBe(false)
  })

  test('重复执行零副作用(幂等)', async () => {
    const userId = await getAuthUserId()
    const capturedId = await seedCaptured(userId)

    const first = await ensureSkillNodeMigration()
    expect(first.migrated).toBe(1)
    const graphBefore = getUserContext(userId).memory.graph.getNodesByType('skill').length

    const second = await ensureSkillNodeMigration()
    expect(second.migrated).toBe(0)
    expect(second.skippedPii).toBe(0)
    const graphAfter = getUserContext(userId).memory.graph.getNodesByType('skill').length
    expect(graphAfter).toBe(graphBefore)

    // 行为不会从 promoted 回到 confirmed
    const row = await (prisma as any).capturedSkill.findUnique({ where: { id: capturedId } })
    expect(row.status).toBe('promoted')
  })

  test('PII 命中行跳过:不迁入 graph,行保持 confirmed 待回炉', async () => {
    const userId = await getAuthUserId()
    const capturedId = await seedCaptured(userId, {
      name: '带 PII 的流程',
      prompt: '请为患者王芳(住院号 2025088123)生成小结',
    })

    const result = await ensureSkillNodeMigration()
    expect(result.migrated).toBe(0)
    expect(result.skippedPii).toBe(1)

    const ctx = getUserContext(userId)
    expect(ctx.memory.graph.getLatestByStableId(skillCapStableId(capturedId))).toBeUndefined()
    const row = await (prisma as any).capturedSkill.findUnique({ where: { id: capturedId } })
    expect(row.status).toBe('confirmed')
  })

  test('draft 行不迁移', async () => {
    const userId = await getAuthUserId()
    await seedCaptured(userId, { status: 'draft' })
    // 共享 user context 的 graph 带有前序测试节点 — 用相对断言
    const before = getUserContext(userId).memory.graph.getNodesByType('skill').length
    const result = await ensureSkillNodeMigration()
    expect(result.migrated).toBe(0)
    expect(getUserContext(userId).memory.graph.getNodesByType('skill').length).toBe(before)
  })
})
