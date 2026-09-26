import { describe, test, expect } from 'vitest'
import { SearchEncounterTool } from '../../src/tools/clinical-graph-tools.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'
import type { Event } from '../../src/core/event-log.js'

/**
 * P1 修复 — search_encounter 的患者归属过滤曾把 && 写成 ||：
 * 关键词命中会把**其他患者**的就诊事件混进结果（跨患者串数据）。
 * 患者归属与关键词必须同时满足。
 */
function ev(partial: Partial<Event> & { content: string; patientHash?: string }): Event {
  const { patientHash, ...rest } = partial
  return {
    idx: rest.idx ?? 1,
    timestamp: rest.timestamp ?? 1,
    eventType: rest.eventType ?? 'chat',
    content: rest.content,
    metadata: { ...(rest.metadata ?? {}), ...(patientHash ? { patientHash } : {}) },
    agentId: rest.agentId ?? 'u1',
    sessionId: rest.sessionId ?? 's1',
  }
}

function ctxWith(events: Event[]): ToolContext {
  return {
    userId: 'u1',
    eventLog: { query: () => events, append: () => {}, count: () => events.length },
  } as unknown as ToolContext
}

describe('P1 search_encounter 患者隔离', () => {
  test('关键词命中的他人事件不进入结果；只返回目标患者的事件', async () => {
    const events = [
      ev({ idx: 1, content: '患者咳嗽加重，考虑肺炎', patientHash: 'patient-A', sessionId: 'sa' }),
      ev({ idx: 2, content: '患者咳嗽，复查 CT', patientHash: 'patient-B', sessionId: 'sb' }),
      ev({ idx: 3, content: '无关随访记录', patientHash: 'patient-A', sessionId: 'sa' }),
      // 无 patientHash 的事件不得凭关键词混入
      ev({ idx: 4, content: '患者咳嗽的讨论（全局）', sessionId: 'sx' }),
    ]
    const tool = new SearchEncounterTool(ctxWith(events))
    const res = await tool.execute({ patient_hash: 'patient-A', query: '咳嗽', top_k: 10 })
    expect(res.success).toBe(true)
    const parsed = JSON.parse(String(res.output)) as { encounters: Array<{ encounter_id: string }> }
    const ids = parsed.encounters.map((e) => e.encounter_id)
    expect(ids).toContain('sa')
    expect(ids).not.toContain('sb')
    expect(ids).not.toContain('sx')
  })

  test('目标患者内关键词过滤仍生效（不返回该患者无关事件）', async () => {
    const events = [
      ev({ idx: 1, content: '咳嗽加重', patientHash: 'patient-A', sessionId: 'sa' }),
      ev({ idx: 2, content: '血糖控制良好', patientHash: 'patient-A', sessionId: 'sa2' }),
    ]
    const tool = new SearchEncounterTool(ctxWith(events))
    const res = await tool.execute({ patient_hash: 'patient-A', query: '咳嗽', top_k: 10 })
    const parsed = JSON.parse(String(res.output)) as { encounters: Array<{ encounter_id: string }> }
    expect(parsed.encounters.map((e) => e.encounter_id)).toEqual(['sa'])
  })
})
