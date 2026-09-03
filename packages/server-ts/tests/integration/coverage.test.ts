import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { computeScopeCoverage, buildCoverageDashboard, getPendingOccupiedFactIds } from '../../src/memory/coverage.js'

/**
 * #816 — facts→article 覆盖率:
 * - 患者隔离口径(global 只统计无 scope facts);
 * - pending article 提案占用即"覆盖在路上";
 * - 失效传播(supersede article)后覆盖率实时下降。
 */

let baseDir: string
let memory: any
let prisma: any

beforeEach(async () => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'))
  const { MemoryService } = await import('../../src/memory/memory.service.js')
  const { EventLog } = await import('../../src/core/event-log.js')
  const { FactsStore, KnowledgeStore } = await import('../../src/evolution/stores.js')
  memory = new MemoryService({
    eventLog: new EventLog(baseDir, 'user_cov'),
    baseDir, legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'user_cov',
  })
  prisma = (await import('../../src/common/prisma.js')).default
})

afterEach(async () => {
  fs.rmSync(baseDir, { recursive: true, force: true })
})

describe('#816 computeScopeCoverage — scope isolation', () => {
  test('global scope 只统计无 patientHash/studyId 的 facts(不混入患者碎片)', async () => {
    memory.addFact({ content: '全局事实 G1', category: 'fact', importance: 3, sourceType: 'general' }, 'system')
    memory.addFact({ content: '患者事实 A1', category: 'fact', importance: 3, patientHash: 'pa', sourceType: 'patient' }, 'system')
    const g = await computeScopeCoverage('user_cov', memory, {})
    expect(g.scope).toBe('global')
    expect(g.confirmedFacts).toBe(1)
    expect(g.coveredFacts).toBe(0)
    expect(g.ratio).toBe(0)
    expect(g.uncoveredSample).toContain('全局事实 G1')

    const p = await computeScopeCoverage('user_cov', memory, { patientHash: 'pa' })
    expect(p.confirmedFacts).toBe(1)
    expect(p.uncoveredSample).toContain('患者事实 A1')
  })

  test('article 覆盖后 ratio 上升;article supersede(失效传播)后实时回落', async () => {
    const f1 = memory.addFact({ content: '事实一', category: 'exam', importance: 4, sourceType: 'general' }, 'system')
    memory.addFact({ content: '事实二', category: 'exam', importance: 4, sourceType: 'general' }, 'system')
    const article = memory.addArticle({ title: 'T', content: 'C', sourceFactStableIds: [f1.stableId] }, 'system')

    const covered = await computeScopeCoverage('user_cov', memory, {})
    expect(covered.coveredFacts).toBe(1)
    expect(covered.ratio).toBe(0.5)

    // 失效传播路径:删除源 fact → article stale → 覆盖率回落
    memory.deleteFact(f1.staleId || f1.stableId, 'system')
    const after = await computeScopeCoverage('user_cov', memory, {})
    expect(after.ratio).toBeLessThan(covered.ratio)
    void article
  })

  test('pending article 提案占用 → 视为已覆盖(getPendingOccupiedFactIds)', async () => {
    const f = memory.addFact({ content: '待审占用事实', category: 'exam', importance: 4, sourceType: 'general' }, 'system')
    await prisma.memoryProposal.create({
      data: {
        userId: 'user_cov', scopeType: 'global', kind: 'article',
        content: '待审文章', importance: 3, confidence: 'medium',
        relatedFacts: JSON.stringify([f.stableId]),
        status: 'pending', createdAt: new Date().toISOString(),
      },
    })
    const occupied = await getPendingOccupiedFactIds('user_cov', {})
    expect(occupied.has(f.stableId)).toBe(true)

    const cov = await computeScopeCoverage('user_cov', memory, {})
    expect(cov.ratio).toBe(1)
  })

  test('空 scope(0 条 facts)→ ratio=1(无缺口)', async () => {
    const cov = await computeScopeCoverage('user_cov', memory, { patientHash: 'nobody' })
    expect(cov.confirmedFacts).toBe(0)
    expect(cov.ratio).toBe(1)
  })
})

describe('#816 buildCoverageDashboard', () => {
  test('global + 患者 scope 全量返回,患者按 ratio 升序', async () => {
    for (const h of ['pa', 'pb']) {
      for (let i = 0; i < 4; i++) {
        memory.addFact({ content: `${h}-fact-${i}`, category: 'fact', importance: 3, patientHash: h, sourceType: 'patient' }, 'system')
      }
    }
    // pa 覆盖 3/4,pb 覆盖 0/4
    const paFacts = (memory.graph.getCurrentNodesByType('fact') as any[]).filter((f) => f.patientHash === 'pa')
    memory.addArticle({ title: 'T', content: 'C', sourceFactStableIds: paFacts.slice(0, 3).map((f) => f.stableId) }, 'system')

    const dash = await buildCoverageDashboard('user_cov', memory)
    expect(dash.hintThreshold).toBe(0.6)
    expect(dash.global.scope).toBe('global')
    const pa = dash.patients.find((p) => p.patientHash === 'pa')!
    const pb = dash.patients.find((p) => p.patientHash === 'pb')!
    expect(pa.coveredFacts).toBe(3)
    expect(pb.coveredFacts).toBe(0)
    // 排序:低覆盖在前(缺口优先可见)
    expect(dash.patients[0].patientHash).toBe('pb')
  })
})
