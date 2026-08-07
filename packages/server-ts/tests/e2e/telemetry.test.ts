import { describe, test, expect, beforeEach, vi } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { InMemoryTelemetryService, PrismaTelemetryService } from '../../src/modules/knowledge/telemetry.service'
import { ChatOrchestrator } from '../../src/modules/chat/chat.orchestrator'
import { EventLog } from '../../src/core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores'
import { ContractEngine } from '../../src/core/contracts'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

function createTestOrchestrator(telemetry: InMemoryTelemetryService) {
  const baseDir = path.join(os.tmpdir(), `nexus-tel-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })

  const eventLog = new EventLog(baseDir)
  const factsStore = new FactsStore(baseDir)
  const episodesStore = new EpisodesStore(baseDir)
  const skillsStore = new SkillsStore(baseDir)
  const knowledgeStore = new KnowledgeStore(baseDir)
  const contracts = new ContractEngine([])

  return {
    orchestrator: new ChatOrchestrator(eventLog, factsStore, episodesStore, skillsStore, knowledgeStore, contracts, telemetry),
    factsStore,
  }
}

describe('Telemetry — InMemory service', () => {
  let telemetry: InMemoryTelemetryService

  beforeEach(() => {
    telemetry = new InMemoryTelemetryService()
  })

  test('records and queries events', async () => {
    await telemetry.record({
      userId: 'u1',
      workspaceId: 'u1',
      category: 'router',
      action: 'vector',
      metadata: { ruleHit: true },
    })

    const events = await telemetry.query({ workspaceId: 'u1' })
    expect(events.length).toBe(1)
    expect(events[0].category).toBe('router')
    expect(events[0].action).toBe('vector')
  })

  test('dashboard aggregates router fallback and hit rates', async () => {
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'router', action: 'sql', metadata: { ruleHit: true, llmFallback: false } })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'router', action: 'vector', metadata: { ruleHit: true, llmFallback: false } })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'router', action: 'mixed', metadata: { ruleHit: false, llmFallback: true } })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'router', action: 'mixed', metadata: { ruleHit: false, llmFallback: true } })

    const dash = await telemetry.dashboard('u1')
    expect(dash.totalEvents).toBe(4)
    expect(dash.router.ruleHitRate).toBe(0.5)
    expect(dash.router.llmFallbackRate).toBe(0.5)
    expect(dash.router.byIntent.sql).toBe(1)
    expect(dash.router.byIntent.vector).toBe(1)
    expect(dash.router.byIntent.mixed).toBe(2)
  })

  test('dashboard aggregates kb commands and gaps', async () => {
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'kb_command', action: 'remember' })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'kb_command', action: 'search' })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'gap', action: 'created' })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'gap', action: 'answered' })
    await telemetry.record({ userId: 'u1', workspaceId: 'u1', category: 'gap', action: 'ignored' })

    const dash = await telemetry.dashboard('u1')
    expect(dash.kbCommands.remember).toBe(1)
    expect(dash.kbCommands.search).toBe(1)
    expect(dash.gaps.created).toBe(1)
    expect(dash.gaps.answered).toBe(1)
    expect(dash.gaps.ignored).toBe(1)
    expect(dash.gaps.resolutionRate).toBe(0.5)
  })

  test('dashboard aggregates llm cost by action and model', async () => {
    await telemetry.record({
      userId: 'u1', workspaceId: 'u1', category: 'llm_cost', action: 'chat.main',
      metadata: { model: 'deepseek-chat', promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.0001 },
    })
    await telemetry.record({
      userId: 'u1', workspaceId: 'u1', category: 'llm_cost', action: 'file.extract_facts',
      metadata: { model: 'deepseek-chat', promptTokens: 20, completionTokens: 10, totalTokens: 30, costUsd: 0.0002 },
    })
    await telemetry.record({
      userId: 'u1', workspaceId: 'u1', category: 'llm_cost', action: 'chat.main',
      metadata: { model: 'deepseek-v4-pro', promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.01 },
    })

    const dash = await telemetry.dashboard('u1')
    expect(dash.llmCost.totalCalls).toBe(3)
    expect(dash.llmCost.totalTokens).toBe(195)
    expect(dash.llmCost.totalCostUsd).toBeCloseTo(0.0103, 4)
    expect(dash.llmCost.byAction['chat.main']).toBe(2)
    expect(dash.llmCost.byAction['file.extract_facts']).toBe(1)
    expect(dash.llmCost.byModel['deepseek-chat'].calls).toBe(2)
    expect(dash.llmCost.byModel['deepseek-chat'].tokens).toBe(45)
    expect(dash.llmCost.byModel['deepseek-v4-pro'].costUsd).toBeCloseTo(0.01, 4)
  })
})

describe('Telemetry — API integration', () => {
  async function freshUser() {
    const app = await getApp()
    const username = `tel_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: `Telemetry User ${Math.random().toString(36).slice(2, 6)}` },
    })
    const token = JSON.parse(register.payload).jwt_token
    return { token, headers: { authorization: `Bearer ${token}` } }
  }

  test('GET /api/v1/knowledge/telemetry/dashboard requires auth', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/knowledge/telemetry/dashboard' })
    expect(res.statusCode).toBe(401)
  })

  test('gap lifecycle records telemetry events', async () => {
    const app = await getApp()
    const { headers } = await freshUser()

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Telemetry gap', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: 'Answer' },
    })

    const dashRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/telemetry/dashboard',
      headers,
    })
    expect(dashRes.statusCode).toBe(200)
    const dash = JSON.parse(dashRes.payload)
    expect(dash.gaps.created).toBe(1)
    expect(dash.gaps.answered).toBe(1)
  })
})

describe('Telemetry — Prisma service', () => {
  test('dashboard survives persistence round-trip', async () => {
    const userId = `tel_u_${Date.now()}`
    await (prisma as any).user.create({
      data: {
        id: userId,
        displayName: 'Telemetry Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })

    const service = new PrismaTelemetryService()
    await service.record({ userId, workspaceId: userId, category: 'router', action: 'sql', metadata: { ruleHit: true } })
    await service.record({ userId, workspaceId: userId, category: 'router', action: 'mixed', metadata: { llmFallback: true } })

    const dash = await service.dashboard(userId)
    expect(dash.totalEvents).toBe(2)
    expect(dash.router.byIntent.sql).toBe(1)
    expect(dash.router.byIntent.mixed).toBe(1)
    expect(dash.router.ruleHitRate).toBe(0.5)
    expect(dash.router.llmFallbackRate).toBe(0.5)
  })
})
