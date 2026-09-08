import { describe, test, expect, vi } from 'vitest'
import { recordFollowThrough } from '../../src/modules/skills/follow-through.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildSkillNode } from '../../src/memory/skill-node-factory.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #912 — follow-through 持久化:MemoryGraph 仅显式 commit 落盘,此前
 * taskCount/followRate/lifecycle 就地改内存对象、零 commit → 重启蒸发。
 * 回归锁:recordFollowThrough 后 graph state 已落盘(新实例重读可见)。
 */

function makeMemory(): { memory: MemoryService; baseDir: string } {
  const baseDir = path.join(os.tmpdir(), `ft-persist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  const memory = new MemoryService({
    eventLog: new EventLog(baseDir), baseDir,
    legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_ftp',
  })
  return { memory, baseDir }
}

function addSkill(memory: MemoryService, name = '文献写作流程') {
  const node = buildSkillNode('u_ftp', {
    name,
    description: '检索→核对→写入',
    steps: ['search_citation', '核对', '写入'],
    promptTemplate: 'TPL',
    taskKind: 'generate',
    triggers: [name],
    scope: 'personal',
    source: 'synthesis',
    evidence: { trajectoryIds: [], sessionIds: [], observationCount: 5, correctionRate: 0 },
    meta: { toolsSequence: ['edit_document', 'render_chart'] },
  } as any)
  memory.graph.addNode(node)
  return node
}

function follow(memory: MemoryService, name: string, toolsUsed: string[], docEdits: number) {
  return recordFollowThrough({
    memory, userId: 'u_ftp', activated: [{ name }],
    toolsUsed, docEdits, outcome: 'completed',
  })
}

describe('#912 recordFollowThrough 持久化', () => {
  test('回合处理后 graph.commit 落盘 — 新实例(模拟重启)重读可见 taskCount/followRate', async () => {
    const { memory, baseDir } = makeMemory()
    const node = addSkill(memory)

    await follow(memory, '文献写作流程', ['kb_search', 'edit_document', 'render_chart'], 1)
    expect(node.taskCount).toBe(1)
    expect(node.followRate).toBe(1)

    // 模拟重启:同一 baseDir 重建 MemoryService — 统计必须存活。
    const reloaded = new MemoryService({
      eventLog: new EventLog(baseDir), baseDir,
      legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_ftp',
    })
    const after: any = reloaded.graph.getLatestByStableId(node.stableId)
    expect(after).toBeTruthy()
    expect(after.taskCount).toBe(1)
    expect(after.followRate).toBe(1)
    expect(after.successCount).toBe(1)
  })

  test('无激活技能时零变更零 commit(不产生空写盘)', async () => {
    const { memory } = makeMemory()
    const commitSpy = vi.spyOn(memory.graph, 'commit')
    await recordFollowThrough({
      memory, userId: 'u_ftp', activated: [], toolsUsed: [], docEdits: 0, outcome: 'completed',
    })
    expect(commitSpy).not.toHaveBeenCalled()
    commitSpy.mockRestore()
  })

  test('auto-suspended 生命周期同样落盘(降级不蒸发)', async () => {
    const { memory, baseDir } = makeMemory()
    const node = addSkill(memory, 'SOAP 笔记流程')
    // WINDOW=10:先 9 次遵循,再连续忽略 → 触发 suspended。
    for (let i = 0; i < 9; i++) {
      await follow(memory, 'SOAP 笔记流程', ['kb_search', 'edit_document', 'render_chart'], 1)
    }
    for (let i = 0; i < 7; i++) {
      await follow(memory, 'SOAP 笔记流程', ['render_chart'], 0)
    }
    expect(node.lifecycle).toBe('suspended')

    const reloaded = new MemoryService({
      eventLog: new EventLog(baseDir), baseDir,
      legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_ftp',
    })
    const after: any = reloaded.graph.getLatestByStableId(node.stableId)
    expect(after.lifecycle).toBe('suspended')
    expect(after.followRate).toBeLessThan(0.4)
  })
})
