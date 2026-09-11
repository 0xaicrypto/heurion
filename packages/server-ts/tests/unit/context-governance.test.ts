import { describe, test, expect } from 'vitest'
import {
  selectProjectionInputs,
  shouldInjectPatientRoster,
  isResearchIntent,
  docSessionFactGraphView,
} from '../../src/modules/shared/chat-context.js'
import { detectUnbackedEditClaim, EDIT_CLAIM_RE } from '../../src/modules/chat/edit-reconciliation.js'

/**
 * #894 — 写作会话上下文注入治理(事故根因③,JD 隐私分心):
 * - roster 只在患者意图时注入;doc- 会话与 general 闲聊不再注入患者名单;
 * - doc- 会话(无患者上下文)过滤患者范围 facts(projection layer3 + 知识注入);
 * - study_context 仅在研究相关意图时注入。
 * #892 — 声明-执行对账纯函数(detectUnbackedEditClaim)锚点。
 */

const globalFact = { id: 'f1', content: '综述写作偏好:先大纲后成文', category: 'fact', importance: 3 }
const jdFact = { id: 'f2', content: 'JD 患者随访期间出现肝功能异常', category: 'fact', importance: 4, patientHash: 'p_jd' }
const otherPatientFact = { id: 'f3', content: '另一患者对青霉素过敏', category: 'fact', importance: 3, patientHash: 'p_other' }

function makeCtx(facts: any[]): any {
  return {
    facts: { all: () => facts },
    episodes: { all: () => [] },
    skills: { all: () => [] },
  }
}

describe('#894 患者名单(roster)注入门槛', () => {
  test('doc- 会话不含 Patient Roster 段 — 即使消息提到患者也不注入', () => {
    // 守卫为 false → conversation-turn 不构建 Patient Roster 块(含空名单占位)
    expect(shouldInjectPatientRoster({ sessionId: 'doc-abc123', patientHash: null, text: '帮我润色第三章' })).toBe(false)
    expect(shouldInjectPatientRoster({ sessionId: 'doc-abc123', patientHash: null, text: '把患者的随访数据整理进正文' })).toBe(false)
    expect(shouldInjectPatientRoster({ sessionId: 'doc-abc123', patientHash: null, text: '' })).toBe(false)
  })

  test('general 闲聊(无患者词)不再注入患者名单', () => {
    expect(shouldInjectPatientRoster({ sessionId: 'session_x1', patientHash: null, text: '今天天气怎么样' })).toBe(false)
  })

  test('患者意图仍注入 — patientHash 非空或患者类提问', () => {
    expect(shouldInjectPatientRoster({ sessionId: 'doc-abc123', patientHash: 'p_jd', text: '继续写' })).toBe(true)
    expect(shouldInjectPatientRoster({ sessionId: 'session_x1', patientHash: null, text: '列出所有患者' })).toBe(true)
    expect(shouldInjectPatientRoster({ sessionId: 'session_x1', patientHash: null, text: 'show me the patient roster' })).toBe(true)
  })
})

describe('#894 doc- 会话过滤患者范围 facts', () => {
  test('doc- 会话(无患者上下文)不注入患者范围 facts,全局 facts 保留', () => {
    const ctx = makeCtx([globalFact, jdFact, otherPatientFact])
    const out = selectProjectionInputs({ intent: 'mixed' } as any, ctx, null, 'doc-abc123')
    expect(out.facts.some((f: any) => f.id === 'f1')).toBe(true)
    expect(out.facts.some((f: any) => Boolean(f.patientHash))).toBe(false)
  })

  test('非 doc 会话行为不变 — 患者 facts 照常注入', () => {
    const ctx = makeCtx([globalFact, jdFact])
    const out = selectProjectionInputs({ intent: 'mixed' } as any, ctx, null, 'session_x1')
    expect(out.facts.some((f: any) => f.id === 'f2')).toBe(true)
  })

  test('vector 意图同样过滤;患者会话(patientHash 非空)不受影响', () => {
    const ctx = makeCtx([jdFact])
    const docTurn = selectProjectionInputs({ intent: 'vector' } as any, ctx, null, 'doc-abc123')
    expect(docTurn.facts).toHaveLength(0)
    const patientTurn = selectProjectionInputs({ intent: 'vector' } as any, ctx, 'p_jd', 'doc-abc123')
    expect(patientTurn.facts.some((f: any) => f.id === 'f2')).toBe(true)
  })
})

describe('#894 研究上下文(study_context)按需注入', () => {
  test('研究相关意图命中', () => {
    expect(isResearchIntent('把试验的入组标准整理成表')).toBe(true)
    expect(isResearchIntent('update the study protocol')).toBe(true)
    expect(isResearchIntent('安排下周随访')).toBe(true)
    expect(isResearchIntent('研究方案里这一段怎么改')).toBe(true)
  })

  test('写作/闲聊不命中 — 不注入研究清单', () => {
    expect(isResearchIntent('帮我润色第三章')).toBe(false)
    expect(isResearchIntent('这段摘要太长，压缩一下')).toBe(false)
    expect(isResearchIntent('谢谢！')).toBe(false)
  })
})

describe('#894 doc 会话知识注入的患者 facts 过滤视图', () => {
  test('fact 节点按 patientHash 过滤,summary/document 节点透传', () => {
    const graph = {
      getCurrentNodesByType: (type: string) => type === 'fact'
        ? [
            { stableId: 'f1', content: 'global', patientHash: undefined },
            { stableId: 'f2', content: 'jd private', patientHash: 'p_jd' },
          ]
        : [{ stableId: 's1', title: 'summary' }],
    }
    const view = docSessionFactGraphView(graph)
    expect(view).toBeDefined()
    const facts = view!.getCurrentNodesByType('fact')
    expect(facts).toHaveLength(1)
    expect(facts[0].stableId).toBe('f1')
    expect(view!.getCurrentNodesByType('summary')).toHaveLength(1)
  })

  test('graph 缺省时返回 undefined(保守回落,不过滤)', () => {
    expect(docSessionFactGraphView(null)).toBeUndefined()
    expect(docSessionFactGraphView(undefined)).toBeUndefined()
  })
})

describe('#892 声明-执行对账纯函数', () => {
  test('编辑完成声明命中', () => {
    expect(detectUnbackedEditClaim('已修改完成，正文已更新。')).toBe(true)
    expect(detectUnbackedEditClaim('已插入第三章内容')).toBe(true)
    expect(detectUnbackedEditClaim('格式已整理并重构完毕')).toBe(true)
    expect(EDIT_CLAIM_RE.test('已应用新格式')).toBe(true)
  })

  test('普通回复不误报', () => {
    expect(detectUnbackedEditClaim('文档未做任何修改。')).toBe(false)
    expect(detectUnbackedEditClaim('我先看看再答复你')).toBe(false)
  })
})
