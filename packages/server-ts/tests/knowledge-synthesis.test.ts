import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { EpisodesStore } from '../src/evolution/stores.js'
import { updateEpisodeSummary, maybeSynthesizeArticle } from '../src/memory/knowledge-synthesis.js'
import { MemoryGraphGateway, registerProposalApplier } from '../src/memory/memory-gateway.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

function makeBaseDir() {
  const dir = path.join(os.tmpdir(), `k34-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('K3 — incremental episode summary', () => {
  test('generates a real summary (not a message prefix) and persists it', async () => {
    const base = makeBaseDir()
    const episodes = new EpisodesStore(base)
    vi.mocked(deepseekChat).mockResolvedValue('患者 ZQ 发热伴胸痛，初步考虑肺部感染，待 CT 确认。')

    const summary = await updateEpisodeSummary({
      userId: 'user_1',
      sessionId: 'session_1',
      episodes,
      incrementalText: 'USER: 患者发热3周\nAI: 考虑肺部感染',
      turnCount: 1,
    })

    expect(summary).toContain('肺部感染')
    const stored = episodes.all().find((e) => e.sessionId === 'session_1')
    expect(stored?.summary).toBe(summary)
    expect(stored?.summary).not.toContain('USER: 患者发热')
  })

  test('second update prompts with the previous summary (incremental update)', async () => {
    const base = makeBaseDir()
    const episodes = new EpisodesStore(base)
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('旧摘要：发热待查')
      .mockResolvedValueOnce('更新摘要：发热待查，CT 提示结节')

    await updateEpisodeSummary({ userId: 'u1', sessionId: 's1', episodes, incrementalText: 'A', turnCount: 1 })
    await updateEpisodeSummary({ userId: 'u1', sessionId: 's1', episodes, incrementalText: 'B', turnCount: 2 })

    const secondPrompt = vi.mocked(deepseekChat).mock.calls[1][0][0].content as string
    expect(secondPrompt).toContain('previous-summary')
    expect(secondPrompt).toContain('旧摘要：发热待查')
  })

  test('LLM failure keeps the old summary', async () => {
    const base = makeBaseDir()
    const episodes = new EpisodesStore(base)
    vi.mocked(deepseekChat).mockRejectedValueOnce(new Error('llm down'))
    episodes.upsert('session_1', '保留的旧摘要', 1)
    episodes.commit()

    const summary = await updateEpisodeSummary({
      userId: 'u1', sessionId: 'session_1', episodes, incrementalText: 'X', turnCount: 2,
    })
    expect(summary).toBe('保留的旧摘要')
    expect(episodes.all().find((e) => e.sessionId === 'session_1')?.summary).toBe('保留的旧摘要')
  })
})

describe('K4 — article synthesis from new confirmed facts', () => {
  test('synthesizes when >= 3 unused confirmed facts of a category exist', async () => {
    const base = makeBaseDir()
    const { MemoryService } = await import('../src/memory/memory.service.js')
    const { EventLog } = await import('../src/core/event-log.js')
    const { FactsStore, KnowledgeStore } = await import('../src/evolution/stores.js')

    const eventLog = new EventLog(base, 'user_1')
    const facts = new FactsStore(base)
    const knowledge = new KnowledgeStore(base)
    const memory = new MemoryService({
      eventLog, baseDir: base, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'user_1',
    })

    // 3 confirmed facts of category 'exam' in scope patient_p1
    for (const c of ['WBC 11.2 偏高', 'CRP 68 mg/L 升高', '中性粒细胞比例 85%']) {
      memory.addFact({ content: c, category: 'exam', importance: 4, patientHash: 'patient_p1', sourceType: 'patient' }, 'system')
    }

    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify({ title: '感染指标汇总', content: '三项感染指标均升高，提示细菌感染可能。' }))
    registerProposalApplier(() => null)

    await maybeSynthesizeArticle('user_1', { patientHash: 'patient_p1' }, memory)

    expect(deepseekChat).toHaveBeenCalled()
    const articlePrompt = vi.mocked(deepseekChat).mock.calls[0][0][0].content as string
    expect(articlePrompt).toContain('WBC 11.2 偏高')

    // Article proposal reaches the pending review queue (real prisma write)
    const prisma = (await import('../src/common/prisma.js')).default
    const proposal = await (prisma as any).memoryProposal.findFirst({
      where: { userId: 'user_1', kind: 'article', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    expect(proposal).toBeTruthy()
    expect(proposal.content).toContain('感染指标汇总')
  }, 30000)

  test('does not synthesize when all facts are older than 7 days (13.3C)', async () => {
    const base = makeBaseDir()
    const { MemoryService } = await import('../src/memory/memory.service.js')
    const { EventLog } = await import('../src/core/event-log.js')
    const { FactsStore, KnowledgeStore } = await import('../src/evolution/stores.js')

    const eventLog = new EventLog(base, 'user_1')
    const facts = new FactsStore(base)
    const knowledge = new KnowledgeStore(base)
    const memory = new MemoryService({
      eventLog, baseDir: base, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'user_1',
    })

    const eightDaysAgo = Date.now() - 8 * 86400_000
    for (const c of ['WBC 11.2 偏高', 'CRP 68 mg/L 升高', '中性粒细胞比例 85%']) {
      const node = memory.addFact({ content: c, category: 'exam', importance: 4, patientHash: 'patient_p1', sourceType: 'patient' }, 'system') as any
      if (node && typeof node.createdAt === 'number') node.createdAt = eightDaysAgo
    }

    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify({ title: 'x', content: 'y' }))
    registerProposalApplier(() => null)

    await maybeSynthesizeArticle('user_1', { patientHash: 'patient_p1' }, memory)

    // No synthesis for historical-only facts
    expect(deepseekChat).not.toHaveBeenCalled()
  }, 30000)

  test('does not synthesize when facts are already used by an article', async () => {
    const base = makeBaseDir()
    const { MemoryService } = await import('../src/memory/memory.service.js')
    const { EventLog } = await import('../src/core/event-log.js')
    const { FactsStore, KnowledgeStore } = await import('../src/evolution/stores.js')

    const eventLog = new EventLog(base, 'user_2')
    const facts = new FactsStore(base)
    const knowledge = new KnowledgeStore(base)
    const memory = new MemoryService({
      eventLog, baseDir: base, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'user_2',
    })

    const factNodes: any[] = []
    for (const c of ['WBC 11.2 偏高', 'CRP 68 mg/L 升高', '中性粒细胞比例 85%']) {
      factNodes.push(memory.addFact({ content: c, category: 'exam', importance: 4, patientHash: 'p1', sourceType: 'patient' }, 'system'))
    }
    // Mark all as used by an existing article
    memory.addArticle({
      title: '已有文章',
      content: '旧文章',
      sourceFactStableIds: factNodes.map((f) => f.stableId),
    }, 'system')

    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify({ title: 'x', content: 'y' }))
    await maybeSynthesizeArticle('user_2', { patientHash: 'p1' }, memory)
    expect(deepseekChat).not.toHaveBeenCalled()
  }, 30000)
})
