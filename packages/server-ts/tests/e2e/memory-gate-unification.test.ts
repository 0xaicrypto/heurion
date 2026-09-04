import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import { executeCommand, type CommandContext } from '../../src/modules/knowledge/knowledge-command-handler.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { InMemoryKnowledgeGapService } from '../../src/modules/knowledge/knowledge-gap.service.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import { createApprovalRequest, confirmApproval } from '../../src/modules/approvals/approval.service.js'
import { recordScanFindingsAsFacts } from '../../src/modules/patients/patient-record.service.js'
import { GapResearchService } from '../../src/modules/knowledge/gap-research.service.js'
import type { WebSearchProvider, WebSearchResult } from '../../src/modules/knowledge/web-search.service.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #839 写入闸门统一 — 回归锁定:
 *  - 用户显式高置信写(kb_remember / gap answer / 直接建总结)走 fast-track 提案:
 *    闸门检查照常、立即落图、提案行 approved 留痕、不建审核收件箱。
 *  - 机器自动写(gap-research / sidecar saveAll / 扫描发现)走 pending 人工审。
 *  - factsStore 直写 fallback 消灭;memory/import 是唯一白名单直写。
 */

function uniq(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function confirmProposal(userId: string, proposalId: string): Promise<void> {
  const proposal = await (prisma as any).memoryProposal.findUnique({ where: { id: proposalId } })
  const req = await createApprovalRequest(userId, {
    targetType: 'MemoryProposal',
    targetId: proposalId,
    payload: proposal,
  })
  await confirmApproval(userId, req.id)
}

describe('#839 gate unification — fast-track explicit writes', () => {
  test('kb_remember: fast-tracks through the gate, audit row approved, no inbox item', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const cmdCtx: CommandContext = {
      workspaceId: userId,
      userId,
      factsStore: ctx.facts,
      knowledgeStore: ctx.knowledge,
      gapService: new InMemoryKnowledgeGapService(),
      memory: ctx.memory,
    }
    const content = `${uniq('ZQ 记忆回归测试')}：对测试用药物不耐受`
    const result = await executeCommand(cmdCtx, 'kb_remember', content)
    expect(result.type).toBe('kb_remembered')

    // 提案行 approved + fast-track 留痕
    const row = await (prisma as any).memoryProposal.findFirst({ where: { userId, kind: 'fact', content } })
    expect(row).toBeTruthy()
    expect(row.status).toBe('approved')
    expect(row.resolvedBy).toBe('fast-track')

    // 不进审核收件箱(fast-track 不需要人审)
    const reqs = await (prisma as any).approvalRequest.findMany({
      where: { userId, targetType: 'MemoryProposal', targetId: row.id },
    })
    expect(reqs.length).toBe(0)

    // 事实已落图(与人工审批同一 applier)
    const factId = (result as any).factId
    const node = ctx.memory.graph.getLatestByStableId(factId)
    expect(node).toBeTruthy()
    expect((node as any).content).toBe(content)
  })

  test('kb_remember without memory: legacy factsStore fallback eliminated', async () => {
    const baseDir = path.join(os.tmpdir(), `gate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const cmdCtx: CommandContext = {
      workspaceId: 'ws_gate',
      userId: 'user_gate',
      factsStore: new FactsStore(baseDir),
      knowledgeStore: new KnowledgeStore(baseDir),
      gapService: new InMemoryKnowledgeGapService(),
      // memory: 故意缺失
    }
    const result = await executeCommand(cmdCtx, 'kb_remember', 'X 对 Y 明确不耐受')
    expect(result.type).toBe('error')
    expect(cmdCtx.factsStore.all().length).toBe(0)
  })

  test('gap answer API: fast-tracks, links graph gap, resolves prisma gap', async () => {
    const app = await getApp()
    const username = `gate_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: 'Gate User' },
    })
    const headers = { authorization: `Bearer ${JSON.parse(register.payload).jwt_token}` }

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'gate 回答测试问题', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    const answer = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: uniq('闸门测试回答内容') },
    })
    expect(answer.statusCode).toBe(200)
    const body = JSON.parse(answer.payload)
    expect(body.status).toBe('answered')

    const userId = JSON.parse(Buffer.from(headers.authorization.split('.')[1], 'base64').toString()).userId
    const row = await (prisma as any).memoryProposal.findFirst({
      where: { userId, kind: 'fact', sourceRange: `gap:${gap.id}` },
    })
    expect(row).toBeTruthy()
    expect(row.status).toBe('approved')
    expect(row.resolvedBy).toBe('fast-track')

    // 事实落图 + 图谱 gap 节点关联(best-effort;此处 gap 仅在 Prisma,不 assert 关联)
    const ctx = getUserContext(userId)
    const node = ctx.memory.graph.getLatestByStableId(body.answerId)
    expect(node).toBeTruthy()
  })

  test('direct summary API: fast-tracks with dedup/conflict checks, response shape intact', async () => {
    const app = await getApp()
    const headers = await authHeader()
    const title = uniq('闸门直接总结')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/summaries',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { title, content: '总结正文内容', sources: [] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeTruthy()
    expect(body.title).toBe(title)

    // 审计行 approved(fast-track)
    const userId = await getAuthUserId()
    const row = await (prisma as any).memoryProposal.findFirst({
      where: { userId, kind: 'summary', status: 'approved', resolvedBy: 'fast-track' },
      orderBy: { createdAt: 'desc' },
    })
    expect(row).toBeTruthy()
    expect(row.content.startsWith(title)).toBe(true)
  })
})

describe('#839 gate unification — machine writes stay pending', () => {
  test('scan findings → pending proposal, applied with document provenance on approval', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const studyId = uniq('study-gate')
    const content = uniq('扫描发现:右肺上叶磨玻璃结节')

    await recordScanFindingsAsFacts(userId, studyId, [{ type: 'finding', content }])

    const row = await (prisma as any).memoryProposal.findFirst({
      where: { userId, kind: 'fact', sourceRange: `file:${studyId}` },
    })
    expect(row).toBeTruthy()
    expect(row.status).toBe('pending')

    // 审批前图谱无此事实
    const before = ctx.memory.graph.getCurrentNodesByType('fact').filter((n: any) => n.content === content)
    expect(before.length).toBe(0)

    await confirmProposal(userId, row.id)

    const node = ctx.memory.graph.getCurrentNodesByType('fact').find((n: any) => n.content === content)
    expect(node).toBeTruthy()
    expect(JSON.stringify(node)).toContain(studyId)
  })

  test('gap-research found → pending proposal with gap provenance; approval writes fact', async () => {
    const userId = await getAuthUserId()
    const gapContent = uniq('自动研究问题')
    const gapRow = await (prisma as any).knowledgeGap.create({
      data: {
        userId,
        workspaceId: userId,
        content: gapContent,
        source: 'chat',
        status: 'open',
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    })
    const answerText = uniq('自动研究命中内容')
    const provider: WebSearchProvider = {
      name: 'test',
      search: async (): Promise<WebSearchResult> => ({ found: true, text: answerText }),
    }

    const service = new GapResearchService(provider)
    await service.researchOpenGaps({ maxPerRun: 5, minAgeMs: 0 })

    const row = await (prisma as any).memoryProposal.findFirst({
      where: { userId, kind: 'fact', sourceRange: `gap:${gapRow.id}` },
    })
    expect(row).toBeTruthy()
    expect(row.status).toBe('pending')

    // 审批通过 → 事实落图(approval.service 识别 gap: 溯源, best-effort 补挂)
    await confirmProposal(userId, row.id)
    const ctx = getUserContext(userId)
    const node = ctx.memory.graph.getCurrentNodesByType('fact').find((n: any) => n.content === answerText)
    expect(node).toBeTruthy()
  })
})

describe('#839 gate unification — whitelist exception', () => {
  test('memory/import stays a direct write (registered whitelist path)', async () => {
    const app = await getApp()
    const headers = await authHeader()
    const factContent = uniq('白名单导入事实')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/import',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { facts: [{ category: 'fact', importance: 3, content: factContent, sourceType: 'general' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).imported).toBe(1)

    // 直写生效,不产生提案
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    expect(ctx.facts.all().some((f: any) => f.content === factContent)).toBe(true)
    const proposal = await (prisma as any).memoryProposal.findFirst({ where: { userId, content: factContent } })
    expect(proposal).toBeNull()
  })
})
