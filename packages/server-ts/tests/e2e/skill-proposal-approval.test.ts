import { describe, test, expect, beforeEach } from 'vitest'
import { getApp, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import { createApprovalRequest, confirmApproval } from '../../src/modules/approvals/approval.service.js'
import { renderSkillProposalCard, renderSkillDiff } from '../../src/memory/skill-card.js'

/**
 * #845 环③ — skill 提案审批:
 * diff 预览可见(剧本卡 + evidence)/ PII 拒且原因可见 /
 * institution 无管理员确认不可通过 / 确认语义(capture → promoted)。
 */

function skillPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    skill: {
      name: '文献写作流程',
      description: '检索→核对→写入 References',
      steps: ['search_citation 检索', '核对 PMID/DOI', '写入 References'],
      promptTemplate: '新增引用前先检索,零编造。',
      taskKind: 'generate',
      triggers: ['references'],
      scope: 'personal',
      source: 'synthesis',
      evidence: {
        trajectoryIds: [`trj_${Math.random().toString(36).slice(2, 8)}`, `trj_${Math.random().toString(36).slice(2, 8)}`, `trj_${Math.random().toString(36).slice(2, 8)}`, `trj_${Math.random().toString(36).slice(2, 8)}`, `trj_${Math.random().toString(36).slice(2, 8)}`],
        sessionIds: ['s_ev1'],
        observationCount: 5,
        correctionRate: 0.1,
      },
      ...over,
    },
    fingerprint: 'test',
  })
}

async function proposeSkill(userId: string, payload: string) {
  const ctx = getUserContext(userId)
  const gateway = new MemoryGraphGateway(userId, ctx.memory)
  return gateway.propose({
    scopeType: 'global',
    kind: 'skill',
    content: `文献写作流程 — 检索→核对`,
    importance: 3,
    confidence: 'medium',
    reason: '轨迹归纳(5 条观察)',
    payload,
  })
}

async function freshUser(display: string): Promise<string> {
  const app = await getApp()
  const username = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { username, password: 'test123456', display_name: `${display}_${Math.random().toString(36).slice(2, 8)}` },
  })
  expect(register.statusCode).toBe(200)
  return JSON.parse(Buffer.from(JSON.parse(register.payload).jwt_token.split('.')[1], 'base64').toString()).userId
}

describe('#845 skill 提案审批', () => {
  beforeEach(async () => {
    await (prisma as any).memoryProposal.deleteMany({})
    await (prisma as any).approvalRequest.deleteMany({})
  })

  test('diff 预览可见:审批请求携带剧本卡 + 证据展示', async () => {
    const userId = await getAuthUserId()
    const proposal = await proposeSkill(userId, skillPayload())
    expect(proposal.status).toBe('pending')

    // 服务层渲染器:剧本卡形状与设计 §3.4 激活摘要一致
    const card = renderSkillProposalCard(proposal)
    expect(card).toBeTruthy()
    expect(card!.title).toBe('文献写作流程')
    expect(card!.steps.length).toBe(3)
    expect(card!.evidence.observationCount).toBe(5)
    expect(card!.evidence.trajectoryCount).toBe(5)
    expect(card!.followRate).toContain('新技能')
    const diff = renderSkillDiff(card!)
    expect(diff.after).toContain('技能卡:文献写作流程')
    expect(diff.after).toContain('search_citation')

    // 审批请求:payload 携带 skillCard,diff 列非空(E2E 可见)
    const req = await (prisma as any).approvalRequest.findFirst({
      where: { userId, targetType: 'MemoryProposal', targetId: proposal.id },
    })
    expect(req).toBeTruthy()
    const reqPayload = JSON.parse(req.payload)
    expect(reqPayload.skillCard).toBeTruthy()
    expect(reqPayload.skillCard.steps.length).toBe(3)
    expect(reqPayload.skillCard.evidence.observationCount).toBe(5)
    const reqDiff = JSON.parse(req.diff)
    expect(reqDiff.after).toContain('技能卡')
  })

  test('PII 样本提案被拒且原因可见', async () => {
    const userId = await getAuthUserId()
    const proposal = await proposeSkill(userId, skillPayload({
      steps: ['填写住院号 2025088123', '检索文献'],
    }))
    expect(proposal.status).toBe('rejected')
    expect(proposal.rejectedReason ?? '').toContain('PII')
    expect(proposal.rejectedReason ?? '').toContain('medical_record_no')
    // 不产生审批请求
    const reqs = await (prisma as any).approvalRequest.findMany({ where: { userId, targetType: 'MemoryProposal', targetId: proposal.id } })
    expect(reqs.length).toBe(0)
  })

  test('institution 提案:非管理员确认被拒;管理员可过(scope 落图)', async () => {
    // 非管理员用户
    const userId = await freshUser('appr_nonadmin')
    const proposal = await proposeSkill(userId, skillPayload({ scope: 'institution' }))
    expect(proposal.status).toBe('pending')
    const req = await createApprovalRequest(userId, { targetType: 'MemoryProposal', targetId: proposal.id, payload: proposal as any })
    await expect(confirmApproval(userId, req.id)).rejects.toThrow('机构管理员')

    // 管理员:全量运行时 setup 共享用户不一定是首个注册者 — 从 DB 取真实 admin
    const admin = await (prisma as any).user.findFirst({ where: { role: 'admin' } })
    expect(admin).toBeTruthy()
    const adminId = admin.id as string
    const adminProposal = await proposeSkill(adminId, skillPayload({ scope: 'institution' }))
    const req2 = await createApprovalRequest(adminId, { targetType: 'MemoryProposal', targetId: adminProposal.id, payload: adminProposal as any })
    await confirmApproval(adminId, req2.id)
    const node: any = getUserContext(adminId).memory.graph.getNodesByType('skill').find((n) => n.name === '文献写作流程' && n.scope === 'institution')
    expect(node).toBeTruthy()
    expect(node.scope).toBe('institution')
  })

  test('确认语义(D6):capture 提案通过 → SkillNode 落图 + CapturedSkill 行标 promoted', async () => {
    const userId = await getAuthUserId()
    const row = await (prisma as any).capturedSkill.create({
      data: {
        userId,
        name: 'SOAP 笔记流程',
        description: '结构化 SOAP 记录',
        steps: JSON.stringify(['收集主观信息', '客观检查', '评估计划']),
        prompt: '请按 SOAP 生成。',
        sourceSession: 's_cap1',
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })

    // confirm(经 #845 改造的 confirmSkillDraft)→ 提案
    const { confirmSkillDraft } = await import('../../src/modules/skills/skill-capture.service.js')
    const result = await confirmSkillDraft(userId, row.id)
    expect(result.ok).toBe(true)
    expect(result.proposalId).toBeTruthy()
    // 行保持 draft(未审批)
    const before = await (prisma as any).capturedSkill.findUnique({ where: { id: row.id } })
    expect(before.status).toBe('draft')

    // 审批通过 → 落图 + promoted
    const approvalReq = await (prisma as any).approvalRequest.findFirst({ where: { targetType: 'MemoryProposal', targetId: result.proposalId } })
    await confirmApproval(userId, approvalReq.id)

    const ctx = getUserContext(userId)
    const node: any = ctx.memory.graph.getLatestByStableId(`skill_cap_${row.id}`)
    expect(node).toBeTruthy()
    expect(node.source).toBe('capture')
    expect(node.evidence.sessionIds).toEqual(['s_cap1'])
    const after = await (prisma as any).capturedSkill.findUnique({ where: { id: row.id } })
    expect(after.status).toBe('promoted')
  })
})
