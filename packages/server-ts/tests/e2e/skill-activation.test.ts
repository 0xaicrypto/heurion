import { describe, test, expect } from 'vitest'
import { matchSkillsForTurn } from '../../src/modules/skills/activation.js'
import { MemoryProjection } from '../../src/retrieval/memory-projection.js'
import { LoadSkillTool } from '../../src/tools/skill-tools.js'
import { SkillsStore } from '../../src/evolution/stores.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #841 环④ — Layer 4 按需激活:
 * trigger 匹配(零 LLM)/ answer·uncertain 不激活 / 降级不激活 /
 * 剧本卡摘要注入 / load_skill 双源(graph 优先)。
 */

const skill = (over: Record<string, unknown> = {}) => ({
  name: '文献写作流程',
  taskKind: 'generate',
  description: '检索→核对→写入 References',
  followRate: 0.7,
  triggers: ['references', '文献'],
  lifecycle: 'active',
  ...over,
})

describe('matchSkillsForTurn — 零 LLM 激活匹配', () => {
  test('taskKind 相等 + trigger 命中 → 激活剧本卡', () => {
    const out = matchSkillsForTurn({ skills: [skill()], taskKind: 'generate', queryText: '帮我把这篇论文的 references 整理一下 document' })
    expect(out.length).toBe(1)
    expect(out[0].name).toBe('文献写作流程')
    expect(out[0].followRate).toBe(0.7)
  })

  test('answer 回合不激活(纯对话零注入)', () => {
    expect(matchSkillsForTurn({ skills: [skill()], taskKind: '', queryText: 'references' })).toEqual([])
  })

  test('uncertain(needsClarify)不激活 — 宁缺勿错注', () => {
    expect(matchSkillsForTurn({ skills: [skill()], taskKind: 'generate', queryText: 'references', uncertain: true })).toEqual([])
  })

  test('taskKind 不匹配 / trigger 无命中 → 不激活', () => {
    expect(matchSkillsForTurn({ skills: [skill()], taskKind: 'edit', queryText: 'references' })).toEqual([])
    expect(matchSkillsForTurn({ skills: [skill()], taskKind: 'generate', queryText: '写份出院小结' })).toEqual([])
  })

  test('suspended/deprecated 不激活(降级不删除但停止激活)', () => {
    expect(matchSkillsForTurn({ skills: [skill({ lifecycle: 'suspended' })], taskKind: 'generate', queryText: 'references' })).toEqual([])
    expect(matchSkillsForTurn({ skills: [skill({ lifecycle: 'deprecated' })], taskKind: 'generate', queryText: 'references' })).toEqual([])
  })

  test('无 triggers 的 legacy skill 回落 name 匹配;上限 ≤3', () => {
    const legacy = skill({ triggers: undefined, followRate: undefined, successCount: 8, taskCount: 10, description: undefined, bestStrategy: '旧策略文本' })
    const out = matchSkillsForTurn({
      skills: [skill({ name: 'A 技能' }), skill({ name: 'B 技能' }), skill({ name: 'C 技能' }), skill({ name: 'D 技能' }), legacy],
      taskKind: 'generate',
      queryText: '用 A 技能处理 references',
    })
    expect(out.length).toBeLessThanOrEqual(3)
    const legacyOut = matchSkillsForTurn({ skills: [legacy], taskKind: 'generate', queryText: '关于文献写作流程的事' })
    expect(legacyOut.length).toBe(1)
    expect(legacyOut[0].followRate).toBeCloseTo(0.8)
    expect(legacyOut[0].description).toBe('旧策略文本')
  })
})

describe('Layer 4 剧本卡渲染 + load_skill 双源', () => {
  function makeMemory() {
    const baseDir = path.join(os.tmpdir(), `skill-act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const memory = new MemoryService({
      eventLog: new EventLog(baseDir), baseDir,
      legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_act',
    })
    return memory
  }

  test('projection 渲染剧本卡摘要(description + 遵循率 + load_skill 提示)', async () => {
    const p = new MemoryProjection()
    const projected = await p.project({
      userId: 'u_act', patientHash: null, persona: 'P', facts: [], episodes: [],
      skills: [{ name: '文献写作流程', taskKind: 'generate', description: '检索→核对→写入', followRate: 0.7 }] as any,
    })
    expect(projected.systemPrompt).toContain('文献写作流程')
    expect(projected.systemPrompt).toContain('遵循率 70%')
    expect(projected.systemPrompt).toContain('load_skill')
  })

  test('load_skill 从 graph 返回完整剧本;suspended 拒绝;legacy 回落', async () => {
    const memory = makeMemory()
    const baseDir = path.join(os.tmpdir(), `skill-act2-${Date.now()}`)
    fs.mkdirSync(baseDir, { recursive: true })
    memory.graph.addNode({
      id: 'skill_t@v1', stableId: 'skill_t', type: 'skill', ownerId: 'u_act', status: 'current',
      content: 't', contentHash: 'h', version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      createdBy: 'system', provenance: {}, meta: {},
      name: '文献写作流程', description: 'desc', steps: ['s1', 's2'], promptTemplate: 'TPL',
      taskKind: 'generate', triggers: ['references'], scope: 'personal',
      evidence: { trajectoryIds: [], sessionIds: [], observationCount: 5, correctionRate: 0 },
      source: 'synthesis', taskCount: 10, successCount: 7, failureCount: 3, followRate: 0.7,
      lifecycle: 'active',
    } as any)
    memory.graph.addNode({
      id: 'skill_s@v1', stableId: 'skill_s', type: 'skill', ownerId: 'u_act', status: 'current',
      content: 's', contentHash: 'h', version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      createdBy: 'system', provenance: {}, meta: {},
      name: '已停用技能', description: 'd', steps: [], promptTemplate: '',
      taskKind: 'generate', triggers: [], scope: 'personal',
      evidence: { trajectoryIds: [], sessionIds: [], observationCount: 0, correctionRate: 0 },
      source: 'capture', taskCount: 0, successCount: 0, failureCount: 0, followRate: 0,
      lifecycle: 'suspended',
    } as any)

    const tool = new LoadSkillTool({ skills: new SkillsStore(baseDir), memory })
    const full = await tool.execute({ name: '文献写作流程' })
    expect(full.success).toBe(true)
    const body = JSON.parse(String(full.output))
    expect(body.steps).toEqual(['s1', 's2'])
    expect(body.prompt_template).toBe('TPL')
    expect(body.stats.follow_rate).toBe(0.7)

    const suspended = await tool.execute({ name: '已停用技能' })
    expect(suspended.success).toBe(false)
    expect(String(suspended.error)).toContain('暂停')

    const legacy = await tool.execute({ name: '不存在的技能' })
    expect(legacy.success).toBe(false)
  })
})
