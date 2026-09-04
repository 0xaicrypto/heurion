import { describe, test, expect } from 'vitest'
import { sequenceContains, judgeFollowed, recordFollowThrough } from '../../src/modules/skills/follow-through.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildSkillNode } from '../../src/memory/skill-node-factory.js'
import prisma from '../../src/common/prisma.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #841 环⑤ — 遵循度度量 + 自动降级:
 * 子序列判定 / D5 产出物判定 / 滑动窗口 followRate / followRate<0.4 自动 suspended(不删除)。
 */

function makeMemory() {
  const baseDir = path.join(os.tmpdir(), `follow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  return new MemoryService({
    eventLog: new EventLog(baseDir), baseDir,
    legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_ft',
  })
}

function addSkill(memory: MemoryService, over: Record<string, unknown> = {}) {
  const node = buildSkillNode('u_ft', {
    name: '文献写作流程',
    description: '检索→核对→写入',
    steps: ['search_citation', '核对', '写入'],
    promptTemplate: 'TPL',
    taskKind: 'generate',
    triggers: ['references'],
    scope: 'personal',
    source: 'synthesis',
    evidence: { trajectoryIds: [], sessionIds: [], observationCount: 5, correctionRate: 0 },
    meta: { toolsSequence: ['edit_document', 'render_chart'] },
    ...over,
  } as any)
  memory.graph.addNode(node)
  return node
}

describe('遵循判定(零 LLM)', () => {
  test('子序列包含即遵循(顺序敏感,不必连续)', () => {
    expect(sequenceContains(['kb_search', 'edit_document', 'x', 'render_chart'], ['edit_document', 'render_chart'])).toBe(true)
    expect(sequenceContains(['render_chart', 'edit_document'], ['edit_document', 'render_chart'])).toBe(false)
    expect(sequenceContains(['edit_document'], ['edit_document', 'render_chart'])).toBe(false)
  })

  test('有声明序列 → 序列比对;无声明(capture)→ D5 产出物判定', () => {
    const declared = { meta: { toolsSequence: ['edit_document'] } } as any
    expect(judgeFollowed(declared, { toolsUsed: ['a', 'edit_document'], docEdits: 0 })).toBe(true)
    expect(judgeFollowed(declared, { toolsUsed: ['render_chart'], docEdits: 3 })).toBe(false)
    const capture = { meta: {} } as any
    expect(judgeFollowed(capture, { toolsUsed: [], docEdits: 1 })).toBe(true)
    expect(judgeFollowed(capture, { toolsUsed: [], docEdits: 0 })).toBe(false)
  })
})

describe('recordFollowThrough — 窗口维护与自动降级', () => {
  test('激活→统计更新→followRate 滑动窗口;连续低遵循自动 suspended', async () => {
    await (prisma as any).telemetryEvent?.deleteMany?.({}).catch?.(() => {})
    const memory = makeMemory()
    const node = addSkill(memory)

    // 前 9 次:全部遵循(子序列命中)→ followRate 1.0
    for (let i = 0; i < 9; i++) {
      await recordFollowThrough({
        memory, userId: 'u_ft', activated: [{ name: '文献写作流程' }],
        toolsUsed: ['kb_search', 'edit_document', 'render_chart'], docEdits: 1, outcome: 'completed',
      })
    }
    expect(node.taskCount).toBe(9)
    expect(node.followRate).toBe(1)

    // 第 10 次:忽略(实际序列不含声明序列)→ 窗口 9/10=0.9,不降级
    await recordFollowThrough({
      memory, userId: 'u_ft', activated: [{ name: '文献写作流程' }],
      toolsUsed: ['render_chart'], docEdits: 0, outcome: 'completed',
    })
    expect(node.followRate).toBe(0.9)
    expect(node.lifecycle).toBe('active')

    // 再来 7 次忽略 → 窗口内 9 忽略 / 1 遵循 = 0.1 < 0.4 → 自动 suspended(不删除)
    for (let i = 0; i < 7; i++) {
      await recordFollowThrough({
        memory, userId: 'u_ft', activated: [{ name: '文献写作流程' }],
        toolsUsed: ['render_chart'], docEdits: 0, outcome: 'completed',
      })
    }
    expect(node.lifecycle).toBe('suspended')
    expect(node.followRate).toBeLessThan(0.4)

    // 降级不删除:节点仍在 graph,load/激活均排除但可重审恢复
    expect(memory.graph.getCurrentNodesByType('skill').some((n: any) => n.name === '文献写作流程')).toBe(true)
  })

  test('未激活的 skill 不记遵循', async () => {
    const memory = makeMemory()
    const a = addSkill(memory, { name: 'A' })
    const b = addSkill(memory, { name: 'B' })
    await recordFollowThrough({
      memory, userId: 'u_ft', activated: [{ name: 'A' }],
      toolsUsed: ['edit_document', 'render_chart'], docEdits: 1, outcome: 'completed',
    })
    expect(a.taskCount).toBe(1)
    expect(b.taskCount).toBe(0)
  })
})
