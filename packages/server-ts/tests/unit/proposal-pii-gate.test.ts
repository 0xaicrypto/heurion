import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import prisma from '../../src/common/prisma.js'
import { ProposalService } from '../../src/memory/proposal/proposal.service.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'

/**
 * #912 — skill 提案 PII 闸门 fail-closed:
 *  - payload 坏 JSON → 拒绝建提案(此前 catch 吞掉后放行进审批队列);
 *  - scanSkillPii 异常 → 拒绝建提案(不再 fail-open);
 *  - 正常 PII 命中路径保持既有语义(命中即拒 + 原因可见)。
 * 闸门在 prisma 写行之前 — 拒绝类用例零 DB 依赖(embedding stub 返回 null,
 * 跳过语义去重)。
 */

const piiMockState = { throwOnScan: false }

vi.mock('../../src/common/pii-scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/common/pii-scanner.js')>()
  return {
    ...actual,
    scanSkillPii: (input: { name: string; description: string; steps: string[]; promptTemplate: string }) => {
      if (piiMockState.throwOnScan) throw new Error('scanner unavailable')
      return actual.scanSkillPii(input)
    },
  }
})

function makeService(userId: string) {
  const baseDir = path.join(os.tmpdir(), `pii-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  const memory = new MemoryService({
    eventLog: new EventLog(baseDir), baseDir,
    legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: userId,
  })
  const embedding = {
    embedOrNull: async () => null,
    embeddingIndex: () => ({ findMostSimilar: () => null }),
    indexApproved: async () => {},
  }
  return new ProposalService(userId, memory, embedding as any)
}

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
      evidence: { trajectoryIds: [], sessionIds: ['s1'], observationCount: 5, correctionRate: 0.1 },
      ...over,
    },
    fingerprint: 'test',
  })
}

const BASE_INPUT = {
  scopeType: 'global' as const,
  kind: 'skill' as const,
  content: '文献写作流程 — 检索→核对',
  importance: 3,
  confidence: 'medium' as const,
  reason: '轨迹归纳(5 条观察)',
}

describe('#912 skill 提案 PII 闸门 fail-closed', () => {
  beforeEach(() => {
    piiMockState.throwOnScan = false
  })

  afterEach(async () => {
    piiMockState.throwOnScan = false
    await (prisma as any).memoryProposal.deleteMany({ where: { userId: 'u_pii_gate' } }).catch(() => {})
  })

  test('payload 坏 JSON → 提案被拒(不建行、不进审批队列)', async () => {
    const svc = makeService('u_pii_gate')
    const row = await svc.propose({ ...BASE_INPUT, payload: 'not-valid-json{{' })
    expect(row.status).toBe('rejected')
    expect(row.rejectedReason ?? '').toContain('无法解析')
    expect(row.rejectedReason ?? '').toContain('fail-closed')
  })

  test('scanSkillPii 异常 → 提案被拒(fail-closed,不再放行)', async () => {
    piiMockState.throwOnScan = true
    const svc = makeService('u_pii_gate')
    const row = await svc.propose({ ...BASE_INPUT, payload: skillPayload() })
    expect(row.status).toBe('rejected')
    expect(row.rejectedReason ?? '').toContain('PII 扫描异常')
  })

  test('正常 PII 命中路径不变:命中即拒且原因可见', async () => {
    const svc = makeService('u_pii_gate')
    const row = await svc.propose({
      ...BASE_INPUT,
      payload: skillPayload({ steps: ['填写住院号 2025088123', '检索文献'] }),
    })
    expect(row.status).toBe('rejected')
    expect(row.rejectedReason ?? '').toContain('PII 扫描命中')
    expect(row.rejectedReason ?? '').toContain('medical_record_no')
  })

  test('干净 payload → 闸门放行,提案正常进入 pending(落库)', async () => {
    const svc = makeService('u_pii_gate')
    const row = await svc.propose({ ...BASE_INPUT, payload: skillPayload() })
    expect(row.status).toBe('pending')
    const inDb = await (prisma as any).memoryProposal.findUnique({ where: { id: row.id } })
    expect(inDb).toBeTruthy()
  })
})
