import { describe, test, expect, vi, beforeEach } from 'vitest'
import { ChatOrchestrator } from '../src/modules/chat/chat.orchestrator'
import { EventLog } from '../src/core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../src/evolution/stores'
import { ContractEngine } from '../src/core/contracts'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  getApiKey: () => 'test-key',
}))

function createTestOrchestrator() {
  const baseDir = path.join(os.tmpdir(), `nexus-orch-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })

  const eventLog = new EventLog(baseDir)
  const factsStore = new FactsStore(baseDir)
  const episodesStore = new EpisodesStore(baseDir)
  const skillsStore = new SkillsStore(baseDir)
  const knowledgeStore = new KnowledgeStore(baseDir)
  const contracts = new ContractEngine([])

  return {
    orchestrator: new ChatOrchestrator(eventLog, factsStore, episodesStore, skillsStore, knowledgeStore, contracts),
    eventLog,
    factsStore,
    episodesStore,
    skillsStore,
    knowledgeStore,
  }
}

describe('ChatOrchestrator — router integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('normal query calls llmCall and returns route metadata', async () => {
    const { orchestrator } = createTestOrchestrator()
    const llmCall = vi.fn().mockResolvedValue('Response from LLM')

    const result = await orchestrator.turn({
      userId: 'user_1',
      message: '帮我总结一下 ZL 的情况',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall,
    })

    expect(llmCall).toHaveBeenCalledTimes(1)
    expect(result.response).toBe('Response from LLM')
    expect(result.route).toBeDefined()
    expect(result.route!.intent).toBe('mixed')
    expect(result.kbCommand).toBe(false)
    expect(result.budget.length).toBeGreaterThan(0)
  })

  test('knowledge command does not call llmCall', async () => {
    const { orchestrator, factsStore } = createTestOrchestrator()
    const llmCall = vi.fn().mockResolvedValue('Should not be called')

    const result = await orchestrator.turn({
      userId: 'user_1',
      message: '记住：ZQ 对 osimertinib 不耐受',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall,
    })

    expect(llmCall).not.toHaveBeenCalled()
    expect(result.kbCommand).toBe(true)
    expect(result.response).toContain('已记录')
    expect(factsStore.all().length).toBe(1)
    expect(factsStore.all()[0].content).toBe('ZQ 对 osimertinib 不耐受')
  })

  test('sql query skips accumulated memory in projection', async () => {
    const { orchestrator, factsStore, episodesStore, skillsStore } = createTestOrchestrator()
    factsStore.add({ category: 'fact', importance: 5, content: 'Test fact', sourceType: 'general' })
    episodesStore.upsert('session_1', 'Test episode', 1)
    skillsStore.recordTask('skillA', 'task', true, 'strategy')

    const llmCall = vi.fn().mockImplementation((systemPrompt: string) => {
      // The projection should not include accumulated memory for SQL intent
      expect(systemPrompt).not.toContain('Test fact')
      expect(systemPrompt).not.toContain('Test episode')
      expect(systemPrompt).not.toContain('skillA')
      return Promise.resolve('SQL result')
    })

    await orchestrator.turn({
      userId: 'user_1',
      message: 'ZL 的年龄是多少',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall,
    })

    expect(llmCall).toHaveBeenCalledTimes(1)
  })

  test('vector query keeps facts but skips episodes and skills', async () => {
    const { orchestrator, factsStore, episodesStore, skillsStore } = createTestOrchestrator()
    factsStore.add({ category: 'fact', importance: 5, content: 'EGFR fact', sourceType: 'general' })
    episodesStore.upsert('session_1', 'Test episode', 1)
    skillsStore.recordTask('skillA', 'task', true, 'strategy')

    const llmCall = vi.fn().mockImplementation((systemPrompt: string) => {
      expect(systemPrompt).toContain('EGFR fact')
      expect(systemPrompt).not.toContain('Test episode')
      expect(systemPrompt).not.toContain('skillA')
      return Promise.resolve('Vector result')
    })

    await orchestrator.turn({
      userId: 'user_1',
      message: 'EGFR 突变怎么治疗',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall,
    })

    expect(llmCall).toHaveBeenCalledTimes(1)
  })

  test('mixed query keeps all accumulated memory', async () => {
    const { orchestrator, factsStore, episodesStore, skillsStore } = createTestOrchestrator()
    factsStore.add({ category: 'fact', importance: 5, content: 'Patient fact', sourceType: 'general' })
    episodesStore.upsert('session_1', 'Test episode', 1)
    skillsStore.recordTask('skillA', 'task', true, 'strategy')

    let systemPromptReceived = ''
    const llmCall = vi.fn().mockImplementation((systemPrompt: string) => {
      systemPromptReceived = systemPrompt
      return Promise.resolve('Mixed result')
    })

    await orchestrator.turn({
      userId: 'user_1',
      message: '帮我总结一下 ZL 的情况',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall,
    })

    expect(systemPromptReceived).toContain('Patient fact')
    expect(systemPromptReceived).toContain('Test episode')
    expect(systemPromptReceived).toContain('skillA')
  })

  test('logs assistant response for knowledge command', async () => {
    const { orchestrator, eventLog } = createTestOrchestrator()

    await orchestrator.turn({
      userId: 'user_1',
      message: '搜索知识库关于 NSCLC',
      sessionId: 'session_1',
      patientHash: null,
      persona: 'You are a helpful assistant',
      llmCall: vi.fn(),
    })

    const events = eventLog.query({ sessionId: 'session_1' })
    const assistantEvents = events.filter(e => e.eventType === 'assistant_response')
    expect(assistantEvents.length).toBe(1)
    expect(assistantEvents[0].metadata.kbCommand).toBe(true)
  })
})

describe('ChatOrchestrator — postTurn regressions', () => {
  test('facts extraction still runs every 5 turns', async () => {
    const { deepseekChat } = await import('../src/common/llm.js')
    vi.mocked(deepseekChat).mockResolvedValue('[{"category":"fact","importance":5,"content":"Extracted fact","sourceType":"general"}]')

    const { orchestrator } = createTestOrchestrator()

    for (let i = 0; i < 6; i++) {
      await orchestrator.turn({
        userId: 'user_1',
        message: `turn ${i}`,
        sessionId: 'session_1',
        patientHash: null,
        persona: 'You are a helpful assistant',
        llmCall: vi.fn().mockResolvedValue('ok'),
      })
      await orchestrator.postTurn('user_1', 'session_1', `turn ${i}`)
    }

    // Only count the fact-extraction LLM call, not any router classifier calls.
    const extractionCalls = deepseekChat.mock.calls.filter(
      (call) => typeof call[0][0]?.content === 'string' && call[0][0].content.includes('Extract key facts'),
    )
    expect(extractionCalls).toHaveLength(1)
  })
})
