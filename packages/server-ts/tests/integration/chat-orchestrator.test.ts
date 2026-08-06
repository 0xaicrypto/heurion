import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { ChatOrchestrator } from '../../src/modules/chat/chat.orchestrator'
import { EventLog } from '../../src/core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores'
import { ContractEngine } from '../../src/core/contracts'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

function orchestratorEventLog(eventLog: EventLog, message: string, sessionId = 'session_1') {
  eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: 'user_message',
    content: message,
    metadata: {},
    agentId: 'user_1',
    sessionId,
  })
}

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

describe('ChatOrchestrator — postTurn regressions', () => {
  test('short conversations without signals do not trigger extraction (K1/K2)', async () => {
    const { deepseekChat } = await import('../../src/common/llm.js')
    vi.mocked(deepseekChat).mockResolvedValue('[{"category":"fact","importance":5,"content":"Extracted fact","sourceType":"general"}]')

    const { orchestrator, eventLog } = createTestOrchestrator()

    for (let i = 0; i < 6; i++) {
      orchestratorEventLog(eventLog, `turn ${i}`)
      await orchestrator.postTurn('user_1', 'session_1', `turn ${i}`)
    }

    // Extraction is event-driven (incremental length / key signals), not
    // turn-count based — six trivial turns never trigger it.
    const extractionCalls = deepseekChat.mock.calls.filter(
      (call) => typeof call[0][0]?.content === 'string' && call[0][0].content.includes('clinical memory extractor'),
    )
    expect(extractionCalls).toHaveLength(0)
  })

  test('postTurn no longer schedules real-time extraction (S1)', async () => {
    const { deepseekChat } = await import('../../src/common/llm.js')
    vi.mocked(deepseekChat).mockResolvedValue('[{"category":"fact","importance":5,"content":"Extracted fact","sourceType":"general"}]')

    const { orchestrator, eventLog } = createTestOrchestrator()

    eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'user_message',
      content: '记住：患者对青霉素过敏',
      metadata: {},
      agentId: 'user_1',
      sessionId: 'session_1',
    })

    await orchestrator.postTurn('user_1', 'session_1', '记住：患者对青霉素过敏')

    // No debounced extraction fires anymore — Tier 1 is removed (S1).
    await new Promise((r) => setTimeout(r, 2500))

    const extractionCalls = deepseekChat.mock.calls.filter(
      (call) => typeof call[0][0]?.content === 'string' && call[0][0].content.includes('clinical memory extractor'),
    )
    expect(extractionCalls).toHaveLength(0)
  })
})
