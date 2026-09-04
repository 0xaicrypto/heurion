import { describe, test, expect } from 'vitest'
import { EventLog } from '../../src/core/event-log.js'
import {
  recordTaskTrajectory,
  shouldRecordTurn,
  TaskTrajectoryProjection,
  TRAJECTORY_EVENT,
} from '../../src/evolution/trajectory.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #843 环① — TaskTrajectory 轨迹采集(D1:eventLog 投影,零正文)。
 * 验收:answer 回合零记录 / 零 LLM 零外呼(纯结构化) / 投影重建一致性。
 */

function makeEventLog(): { log: EventLog; dir: string } {
  const dir = path.join(os.tmpdir(), `trj-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { log: new EventLog(dir, 'u_trj'), dir }
}

function appendUserTurn(log: EventLog, sessionId: string, offsetSec = 0): void {
  log.append({
    timestamp: Date.now() / 1000 - offsetSec,
    eventType: 'user_message',
    content: '（正文不入轨迹 — 测试桩）',
    metadata: {},
    agentId: 'u_trj',
    sessionId,
  })
}

describe('shouldRecordTurn — answer 零记录(验收)', () => {
  test('answer 不记,任务型动作全记', () => {
    expect(shouldRecordTurn('answer')).toBe(false)
    expect(shouldRecordTurn('edit')).toBe(true)
    expect(shouldRecordTurn('generate')).toBe(true)
    expect(shouldRecordTurn('retrieve')).toBe(true)
    expect(shouldRecordTurn('command')).toBe(true)
  })

  test('recordTaskTrajectory 对 answer 是 no-op', () => {
    const { log } = makeEventLog()
    recordTaskTrajectory(log, {
      userId: 'u_trj', sessionId: 's1', action: 'answer', scene: 'general',
      toolsUsed: [], docEdits: 0,
    })
    expect(log.query({ eventType: TRAJECTORY_EVENT })).toEqual([])
  })
})

describe('projection — schema 零正文 + 派生字段', () => {
  test('轨迹只含操作元数据,正文不落任何字段', () => {
    const { log } = makeEventLog()
    appendUserTurn(log, 's1', 30)
    recordTaskTrajectory(log, {
      userId: 'u_trj', sessionId: 's1', action: 'edit', scene: 'document',
      toolsUsed: ['edit_document', 'render_chart'], docEdits: 2, outcome: 'completed',
    })
    const events = log.query({ eventType: TRAJECTORY_EVENT })
    expect(events.length).toBe(1)
    // 事件 content 仅动作标签,metadata 零正文
    expect(events[0].content).toBe('task:edit')
    expect(JSON.stringify(events[0].metadata)).not.toContain('正文')

    const p = new TaskTrajectoryProjection(log)
    const list = p.query()
    expect(list.length).toBe(1)
    expect(list[0].action).toBe('edit')
    expect(list[0].scene).toBe('document')
    expect(list[0].toolsUsed).toEqual(['edit_document', 'render_chart'])
    expect(list[0].docEdits).toBe(2)
    expect(list[0].durationMs).toBeGreaterThan(25000) // 距 user_message 30s
    expect(list[0].outcome).toBe('completed')
  })

  test('userCorrection 派生:同会话同动作 10 分钟内重做 → 前者标 corrected', () => {
    const { log } = makeEventLog()
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's1', action: 'edit', scene: 'document', toolsUsed: [], docEdits: 1 })
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's1', action: 'edit', scene: 'document', toolsUsed: [], docEdits: 1 })
    const p = new TaskTrajectoryProjection(log)
    const list = p.query()
    expect(list[0].userCorrection).toBe(true)
    expect(list[1].userCorrection).toBe(false)
  })

  test('taskKind/时间窗/session 过滤 + stats 基线', () => {
    const { log } = makeEventLog()
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's1', action: 'edit', scene: 'document', toolsUsed: [], docEdits: 1 })
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's2', action: 'retrieve', scene: 'patient', toolsUsed: [], docEdits: 0 })
    const p = new TaskTrajectoryProjection(log)
    expect(p.query({ taskKind: 'edit' }).length).toBe(1)
    expect(p.query({ sessionId: 's2' }).length).toBe(1)
    expect(p.query({ since: Date.now() + 1000 }).length).toBe(0)
    const s = p.stats()
    expect(s.total).toBe(2)
    expect(s.byTaskKind.edit).toBe(1)
    expect(s.byTaskKind.retrieve).toBe(1)
  })
})

describe('可重建性 — 投影删除后从 eventLog 全量重建,diff 为空(验收)', () => {
  test('rebuild 前后一致;跨 EventLog 实例(同目录)重建一致', async () => {
    const { log, dir } = makeEventLog()
    appendUserTurn(log, 's1', 10)
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's1', action: 'generate', scene: 'general', toolsUsed: ['t1'], docEdits: 0 })
    appendUserTurn(log, 's1', 5)
    recordTaskTrajectory(log, { userId: 'u_trj', sessionId: 's1', action: 'edit', scene: 'document', toolsUsed: ['t2'], docEdits: 1 })

    const p = new TaskTrajectoryProjection(log)
    const before = p.query()

    // 同进程:清缓存重建
    const rebuilt = p.rebuild()
    expect(rebuilt).toEqual(before)

    // 跨实例:投影完全删除后,新 EventLog 实例从磁盘重放 → 投影一致
    // (写入是异步队列 — 先 flush 确保落盘)
    await log.flush()
    const log2 = new EventLog(dir, 'u_trj')
    const p2 = new TaskTrajectoryProjection(log2)
    expect(p2.query()).toEqual(before)
  })
})
