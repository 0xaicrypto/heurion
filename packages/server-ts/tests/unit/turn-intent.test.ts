/**
 * TURN_INTENT_DESIGN.md §3/§4/§6 — 场景感知的 TurnIntent 解码测试集（TDD 红线）。
 *
 * 覆盖：
 * - resolveTargetCandidates / pickTarget：目标候选与消歧（例 A/B/C）
 * - decodeTurnIntent 的五类 action（answer/edit/generate/retrieve/command）可达
 * - 强否决先于语义层/LLM（投入零 LLM 调用）
 * - LLM 失败/uncertain → 保守 answer（永不生成）
 * - buildTurnIntentPrompt：含 scene/候选目标/硬规则/历史
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import type { SemanticVerdict } from '../../src/retrieval/semantic-intent-router.js'
import {
  decodeTurnIntent,
  resolveTargetCandidates,
  pickTarget,
  isGenerateRequest,
  buildTurnIntentPrompt,
  type TurnContext,
  type TurnLlms,
} from '../../src/modules/chat/turn-intent.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

const baseCtx = (over: Partial<TurnContext> = {}): TurnContext => ({
  scene: 'general',
  text: '',
  sessionId: 'session_abc',
  hasAttachment: false,
  patientHash: null,
  history: undefined,
  ...over,
})

/** fake LLM 裁决器：注入期望的三态结果 */
const fakeClassifier = (decision: string): TurnLlms['classifier'] => ({
  classify: vi.fn().mockResolvedValue(decision),
})

/** fake 语义路由器：可注入 generate/veto/uncertain 三态 */
const fakeSemantic = (verdict: SemanticVerdict): TurnLlms['semantic'] => ({
  classify: vi.fn().mockResolvedValue(verdict),
})

describe('resolveTargetCandidates — 目标候选（§3/§6）', () => {
  test('general 无附件 → 无候选', () => {
    expect(resolveTargetCandidates(baseCtx())).toEqual([])
  })

  test('general 有附件 → attachment', () => {
    expect(resolveTargetCandidates(baseCtx({ hasAttachment: true }))).toEqual(['attachment'])
  })

  test('document(doc-{id}) 无附件 → current_doc', () => {
    expect(resolveTargetCandidates(baseCtx({ scene: 'document', sessionId: 'doc-123' }))).toEqual(['current_doc'])
  })

  test('document + 附件 → 附件优先于 current_doc', () => {
    expect(resolveTargetCandidates(baseCtx({ scene: 'document', sessionId: 'doc-123', hasAttachment: true }))).toEqual([
      'attachment', 'current_doc',
    ])
  })

  test('patient + patientHash → patient', () => {
    expect(resolveTargetCandidates(baseCtx({ scene: 'patient', patientHash: 'p1' }))).toEqual(['patient'])
  })

  test('patient 无 patientHash → 无候选（#546 场景已降级）', () => {
    expect(resolveTargetCandidates(baseCtx({ scene: 'patient' }))).toEqual([])
  })
})

describe('pickTarget — 目标消歧（§6 例 A/B/C）', () => {
  test('例 A：general + 附件 + 润色 → attachment，单一候选不澄清', () => {
    const res = pickTarget(baseCtx({ hasAttachment: true, text: '帮我润色一下' }), ['attachment'])
    expect(res.target).toBe('attachment')
    expect(res.needsClarify).toBe(false)
  })

  test('例 B：document + 润色草稿 → current_doc，单一候选不澄清', () => {
    const res = pickTarget(baseCtx({ scene: 'document', sessionId: 'doc-9', text: '帮我润色一下' }), ['current_doc'])
    expect(res.target).toBe('current_doc')
    expect(res.needsClarify).toBe(false)
  })

  test('例 C：document + 附件 + 明确指代"这个文件" → attachment 且澄清（双候选）', () => {
    const candidates = ['attachment', 'current_doc']
    const res = pickTarget(baseCtx({ scene: 'document', sessionId: 'doc-9', hasAttachment: true, text: '润色这个文件' }), candidates)
    expect(res.target).toBe('attachment')
    expect(res.needsClarify).toBe(true)
    expect(res.options).toEqual(['attachment', 'current_doc'])
  })

  test('例 C2：document + 附件 + 无明确指代 → 默认 current_doc 且澄清', () => {
    const candidates = ['attachment', 'current_doc']
    const res = pickTarget(baseCtx({ scene: 'document', sessionId: 'doc-9', hasAttachment: true, text: '帮我润色一下' }), candidates)
    expect(res.target).toBe('attachment')
    expect(res.needsClarify).toBe(true)
  })

  test('无候选 → none，不澄清', () => {
    const res = pickTarget(baseCtx(), [])
    expect(res.target).toBe('none')
    expect(res.needsClarify).toBe(false)
  })
})

describe('decodeTurnIntent — 五类 action 可达（§4/§9.5）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('command：显式知识库命令 → action=command, 0 LLM', async () => {
    const llms = { classifier: fakeClassifier('uncertain') }
    const r = await decodeTurnIntent(baseCtx({ text: '知识库搜索 肺癌' }), llms)
    expect(r.intent.action).toBe('command')
    expect(r.intent.target).toBe('none')
    expect(r.intent.source).toBe('rule')
    expect(r.llmCalls).toBe(0)
    expect(llms.classifier.classify).not.toHaveBeenCalled()
  })

  test('retrieve：人口学查询 → action=retrieve, 0 LLM', async () => {
    const llms = { classifier: fakeClassifier('uncertain') }
    const r = await decodeTurnIntent(baseCtx({ text: '这个病人的年龄是多少' }), llms)
    expect(r.intent.action).toBe('retrieve')
    expect(r.intent.source).toBe('rule')
    expect(r.llmCalls).toBe(0)
  })

  test('edit（强否决）：润色句 → action=edit, 0 LLM，语义层/LLM 不得覆盖', async () => {
    const llms: TurnLlms = { classifier: fakeClassifier('generate'), semantic: fakeSemantic('generate') }
    const r = await decodeTurnIntent(baseCtx({ text: '帮我润色修改一下这篇论文' }), llms)
    expect(r.intent.action).toBe('edit')
    expect(r.intent.source).toBe('veto')
    expect(r.llmCalls).toBe(0)
    expect(llms.classifier.classify).not.toHaveBeenCalled()
    expect(llms.semantic!.classify).not.toHaveBeenCalled()
  })

  test('answer（强否决）：讨论句 → action=answer, 0 LLM', async () => {
    const llms = { classifier: fakeClassifier('uncertain') }
    const r = await decodeTurnIntent(baseCtx({ text: '这个表格的数字怎么来的' }), llms)
    expect(r.intent.action).toBe('answer')
    expect(r.intent.source).toBe('veto')
    expect(r.llmCalls).toBe(0)
  })

  test('answer（规则）：总结句无生成信号 → action=answer(口头总结，非生成), 0 LLM', async () => {
    const llms = { classifier: fakeClassifier('generate') }
    const r = await decodeTurnIntent(baseCtx({ text: '给我总结一下这个病人的治疗经过' }), llms)
    expect(r.intent.action).toBe('answer')
    expect(r.intent.source).toBe('rule')
    expect(r.llmCalls).toBe(0)
    expect(r.vetoed).toBe(false)
  })

  test('generate（LLM）：明确生成请求 → action=generate, 1 次 LLM', async () => {
    const llms = { classifier: fakeClassifier('generate') }
    const r = await decodeTurnIntent(baseCtx({ text: '帮我生成一份出院小结 docx' }), llms)
    expect(r.intent.action).toBe('generate')
    expect(r.intent.target).toBe('none')
    expect(r.intent.source).toBe('llm')
    expect(r.llmCalls).toBe(1)
  })

  test('answer（LLM）：兼类词由裁决确认 → action=answer, 1 次 LLM', async () => {
    const llms = { classifier: fakeClassifier('discuss') }
    const r = await decodeTurnIntent(baseCtx({ text: '这个表格的数字怎么来的' }), llms)
    // 注意：本用例走讨论标记否决，不会到 LLM；改成无标记文本测 LLM discuss 分支
    expect(r.llmCalls).toBe(0)
  })

  test('answer（LLM）：无标记文本 + 裁决 discuss → action=answer', async () => {
    const llms = { classifier: fakeClassifier('discuss') }
    const r = await decodeTurnIntent(baseCtx({ text: '帮我把这三个病人的生存数据排列一下' }), llms)
    expect(r.intent.action).toBe('answer')
    expect(r.intent.source).toBe('llm')
    expect(r.llmCalls).toBe(1)
  })

  test('uncertain（LLM）：混合意图 → needsClarify=true，保守 answer，绝不生成', async () => {
    const llms = { classifier: fakeClassifier('uncertain') }
    const r = await decodeTurnIntent(baseCtx({ text: '先讨论一下这个表格，然后导出成 PDF' }), llms)
    expect(r.intent.needsClarify).toBe(true)
    expect(r.intent.action).toBe('answer')
    expect(r.intent.source).toBe('llm')
    expect(isGenerateRequest(r.intent)).toBe(false)
    expect(r.llmCalls).toBe(1)
  })

  test('LLM 失败 → 保守 answer，不澄清', async () => {
    const llms = { classifier: { classify: vi.fn().mockRejectedValue(new Error('llm down')) } }
    const r = await decodeTurnIntent(baseCtx({ text: '帮我看看这些数据' }), llms)
    expect(r.intent.action).toBe('answer')
    expect(r.intent.needsClarify).toBe(false)
    expect(r.llmCalls).toBe(1)
  })

  test('语义层 generate 高置信 → 跳过 LLM（source=semantic, 0 LLM）', async () => {
    const llms: TurnLlms = { classifier: fakeClassifier('uncertain'), semantic: fakeSemantic('generate') }
    const r = await decodeTurnIntent(baseCtx({ text: '把这份数据做成 PPT 汇报' }), llms)
    expect(r.intent.action).toBe('generate')
    expect(r.intent.source).toBe('semantic')
    expect(r.llmCalls).toBe(0)
  })

  test('语义层 veto 高置信 → 不过 LLM 直接 answer', async () => {
    const llms: TurnLlms = { classifier: fakeClassifier('uncertain'), semantic: fakeSemantic('veto') }
    const r = await decodeTurnIntent(baseCtx({ text: '看看这张图的结论' }), llms)
    expect(r.intent.action).toBe('answer')
    expect(r.llmCalls).toBe(0)
  })
})

describe('decodeTurnIntent — 端到端（§6 例 A-D, target 落定）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('例 A：general + 附件 + 润色 → edit/attachment，不触插件', async () => {
    const r = await decodeTurnIntent(
      baseCtx({ scene: 'general', hasAttachment: true, text: '帮我润色一下' }),
      { classifier: fakeClassifier('generate') },
    )
    expect(r.intent.action).toBe('edit')
    expect(r.intent.target).toBe('attachment')
    expect(r.intent.needsClarify).toBe(false)
    expect(r.llmCalls).toBe(0)
  })

  test('例 B：document + 润色草稿 → edit/current_doc，payload 带 editDocumentId', async () => {
    const r = await decodeTurnIntent(
      baseCtx({ scene: 'document', sessionId: 'doc-42', text: '帮我润色一下' }),
      { classifier: fakeClassifier('generate') },
    )
    expect(r.intent.action).toBe('edit')
    expect(r.intent.target).toBe('current_doc')
    expect(r.intent.payload.editDocumentId).toBe('42')
    expect(r.llmCalls).toBe(0)
  })

  test('例 C：document + 附件 + 润色这个文件 → edit + 消歧澄清', async () => {
    const r = await decodeTurnIntent(
      baseCtx({ scene: 'document', sessionId: 'doc-42', hasAttachment: true, text: '润色这个文件' }),
      { classifier: fakeClassifier('generate') },
    )
    expect(r.intent.action).toBe('edit')
    expect(r.intent.target).toBe('attachment')
    expect(r.intent.needsClarify).toBe(true)
    expect(r.intent.clarifyOptions).toEqual(['attachment', 'current_doc'])
  })

  test('例 D：general + 总结治疗经过 → answer，绝不生成', async () => {
    const r = await decodeTurnIntent(
      baseCtx({ scene: 'general', text: '给我总结一下这个病人的治疗经过' }),
      { classifier: fakeClassifier('generate') },
    )
    expect(r.intent.action).toBe('answer')
    expect(isGenerateRequest(r.intent)).toBe(false)
    expect(r.llmCalls).toBe(0)
  })

  test('patient 场景 + 讨论 → answer/patient', async () => {
    const r = await decodeTurnIntent(
      baseCtx({ scene: 'patient', patientHash: 'p1', text: '这个方案有没有文献支持' }),
      { classifier: fakeClassifier('discuss') },
    )
    expect(r.intent.action).toBe('answer')
    expect(r.intent.target).toBe('patient')
  })
})

describe('isGenerateRequest — 生成判定布尔化（向后兼容映射）', () => {
  test('action=generate 且未澄清 → true', () => {
    expect(isGenerateRequest({
      action: 'generate', target: 'none', source: 'llm', confidence: 0.8,
      needsClarify: false, clarifyOptions: [], payload: {},
    })).toBe(true)
  })

  test('action=generate 但 needsClarify → false（未确认不生成）', () => {
    expect(isGenerateRequest({
      action: 'generate', target: 'none', source: 'llm', confidence: 0.5,
      needsClarify: true, clarifyOptions: ['生成', '先讨论'], payload: {},
    })).toBe(false)
  })

  test('非 generate → false', () => {
    expect(isGenerateRequest({
      action: 'answer', target: 'none', source: 'veto', confidence: 1,
      needsClarify: false, clarifyOptions: [], payload: {},
    })).toBe(false)
  })
})

describe('buildTurnIntentPrompt — prompt 内容（含 scene/候选/硬规则/历史）', () => {
  test('包含场景、候选目标、总结硬规则与历史', () => {
    const history = [{ role: 'user' as const, content: '帮我做个 PPT' }]
    const prompt = buildTurnIntentPrompt(
      baseCtx({ scene: 'document', sessionId: 'doc-1', hasAttachment: true, text: '润色这个文件', history }),
      ['attachment', 'current_doc'],
    )
    expect(prompt).toContain('document')
    expect(prompt).toContain('attachment')
    expect(prompt).toContain('current_doc')
    expect(prompt).toContain('生成')
    expect(prompt).toContain('总结')
    expect(prompt).toContain('帮我做个 PPT')
  })
})