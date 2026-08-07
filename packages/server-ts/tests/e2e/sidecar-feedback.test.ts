import { describe, test, expect, beforeEach } from 'vitest'
import { ruleBasedSidecarExtractor, SidecarFeedbackService } from '../../src/modules/knowledge/sidecar-feedback.service'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import { EventLog } from '../../src/core/event-log'
import { MemoryService } from '../../src/memory/memory.service'
import { getApp, authHeader } from '../setup.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Sidecar feedback — rule-based extractor', () => {
  test('extracts high-value clinical findings', async () => {
    const output = `
      Patient Report
      ==============
      EGFR exon 19 deletion was detected in 45% of samples.
      PD-L1 TPS = 80%.
      The patient was diagnosed with lung adenocarcinoma stage IIIA.
      Note: this is a preliminary report.
    `
    const candidates = await ruleBasedSidecarExtractor.extract(output)
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const contents = candidates.map(c => c.content)
    expect(contents.some(c => c.includes('EGFR'))).toBe(true)
    expect(contents.some(c => c.includes('PD-L1'))).toBe(true)
    expect(contents.some(c => c.includes('diagnosed'))).toBe(true)
  })

  test('ignores filler and uncertainty', async () => {
    const output = `
      Figure 1: Kaplan-Meier curve
      Table 2: baseline characteristics
      Maybe possibly the drug works.
      References
    `
    const candidates = await ruleBasedSidecarExtractor.extract(output)
    expect(candidates.length).toBe(0)
  })

  test('deduplicates repeated sentences', async () => {
    const output = 'EGFR exon 19 deletion detected. EGFR exon 19 deletion detected.'
    const candidates = await ruleBasedSidecarExtractor.extract(output)
    expect(candidates.length).toBe(1)
  })
})

describe('Sidecar feedback — service', () => {
  function makeService() {
    const baseDir = path.join(os.tmpdir(), `sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const eventLog = new EventLog(baseDir)
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    const memory = new MemoryService({ eventLog, baseDir, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'u1' })
    return { service: new SidecarFeedbackService(memory), facts, memory }
  }

  test('saveAll false returns candidates without persisting', async () => {
    const { service, facts } = makeService()
    const output = 'EGFR exon 19 deletion detected in 45% of samples.'
    const result = await service.process({
      userId: 'u1',
      workspaceId: 'u1',
      output,
      saveAll: false,
    })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.saved.length).toBe(0)
    expect(facts.all().length).toBe(0)
  })

  test('saveAll true persists high-confidence facts', async () => {
    const { service, facts } = makeService()
    const output = 'EGFR exon 19 deletion detected in 45% of samples. PD-L1 TPS = 80%.'
    const result = await service.process({
      userId: 'u1',
      workspaceId: 'u1',
      output,
      saveAll: true,
    })
    expect(result.saved.length).toBeGreaterThan(0)
    expect(facts.all().length).toBe(result.saved.length)
    for (const f of facts.all()) {
      expect(f.sourceType).toBe('sidecar')
    }
  })
})

describe('Sidecar feedback — API', () => {
  async function freshUser() {
    const app = await getApp()
    const username = `sidecar_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: `Sidecar User ${Math.random().toString(36).slice(2, 6)}` },
    })
    const token = JSON.parse(register.payload).jwt_token
    return { token, headers: { authorization: `Bearer ${token}` } }
  }

  test('POST requires output', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/sidecar/feedback',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  test('POST with saveAll false returns candidates and does not persist facts', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/sidecar/feedback',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {
        output: 'EGFR exon 19 deletion detected in 45% of samples.',
        saveAll: false,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.candidates.length).toBeGreaterThan(0)
    expect(body.saved.length).toBe(0)
  })

  test('POST with saveAll true persists facts', async () => {
    const app = await getApp()
    const { token, headers } = await freshUser()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/sidecar/feedback',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {
        output: 'EGFR exon 19 deletion detected in 45% of samples. PD-L1 TPS = 80%.',
        saveAll: true,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.saved.length).toBeGreaterThan(0)

    // Verify user context has new facts
    const ctxModule = await import('../../src/modules/chat/user-context.js')
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).userId
    const ctx = ctxModule.getUserContext(userId)
    expect(ctx.facts.all().some((f: any) => f.sourceType === 'sidecar')).toBe(true)
  })
})
