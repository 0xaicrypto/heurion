import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { resolveSidecarIntent, clearSidecarCache, type SidecarClassifier } from '../../src/retrieval/intent-router.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

describe('#557 — sidecar 意图判定（强否决 + 一次 LLM 裁决）', () => {
  beforeEach(() => {
    clearSidecarCache()
    vi.clearAllMocks()
  })

  const classifier = (decision: string): SidecarClassifier => ({
    classify: vi.fn().mockResolvedValue(decision),
  })

test('普通问题：无否决词健康，LLM 裁决 discuss → 不生成', async () => {
    const cl = classifier('discuss')
    const r = await resolveSidecarIntent('u1', '这个治疗方案有没有文献支持', { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).toHaveBeenCalledWith('这个治疗方案有没有文献支持', undefined)
  })

  test('讨论句：规则否决 → 不生成，且不花 LLM 精裁调用', async () => {
    const cl = classifier('generate')
    const r = await resolveSidecarIntent('u1', '这个表格的数字怎么来的', { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).not.toHaveBeenCalled()
  })

  test('编辑/润色句：规则否决 → 不生成，且不花 LLM 精裁调用', async () => {
    const cl = classifier('generate')
    const r = await resolveSidecarIntent('u1', '帮我润色修改一下这篇论文', { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).not.toHaveBeenCalled()
  })

  test('生成请求：LLM 裁决 generate → 放行', async () => {
    const cl = classifier('generate')
    const r = await resolveSidecarIntent('u1', '帮我生成一份出院小结 docx', { classifier: cl })
    expect(r).toBe(true)
    expect(cl.classify).toHaveBeenCalled()
  })

  test('模糊请求：LLM 裁决 uncertain → 安全降级为正常对话', async () => {
    const cl = classifier('uncertain')
    const r = await resolveSidecarIntent('u1', '先讨论一下这个表格，然后导出成 PDF', { classifier: cl })
    expect(r).toBe(false)
  })

  test('LLM 精裁异常 → 安全降级为正常对话', async () => {
    const cl: SidecarClassifier = { classify: vi.fn().mockRejectedValue(new Error('llm down')) }
    const r = await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(r).toBe(false)
  })

  test('精裁结果按 用户+查询+历史指纹 缓存，相同输入不重复花费', async () => {
    const cl = classifier('generate')
    await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(cl.classify).toHaveBeenCalledTimes(1)
  })

  test('对话历史传递给分类器（承接指代语义）', async () => {
    const cl = classifier('generate')
    const history = [{ role: 'user' as const, content: '帮我做个 PPT' }]
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history })
    expect(cl.classify).toHaveBeenCalledWith('做好了发我', history)
  })

  test('#558 同一文本在不同历史下语义不同 → 缓存不串用', async () => {
    const cl = classifier('generate')
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history: [{ role: 'user' as const, content: '帮我做个 PPT' }] })
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history: [{ role: 'user' as const, content: '帮我改一下那份病例' }] })
    expect(cl.classify).toHaveBeenCalledTimes(2)
  })

  test('#558 相同文本+相同历史 → 缓存命中不重复花费', async () => {
    const cl = classifier('generate')
    const history = [{ role: 'user' as const, content: '帮我做个 PPT' }]
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history })
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history })
    expect(cl.classify).toHaveBeenCalledTimes(1)
  })

  test('#557 粘贴全文 + 润色 → 否决命中，零 LLM 成本', async () => {
    const cl = classifier('generate')
    const longText = `${'这是一段细胞治疗综述的正文内容，综述了多项临床研究的结果。'.repeat(30)}帮我润色一下这篇论文。`
    const r = await resolveSidecarIntent('u1', longText, { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).not.toHaveBeenCalled()
  })

  // ── #560/#561: 决策详情（onDecision）与缓存命中上报 ──

  test('#560 veto 命中 → onDecision 上报 vetoed，零 LLM', async () => {
    const cl = classifier('generate')
    const decisions: any[] = []
    await resolveSidecarIntent('u1', '帮我润色修改一下这篇论文', { classifier: cl, onDecision: (d) => decisions.push(d) })
    expect(decisions).toHaveLength(1)
    expect(decisions[0].verdict).toBe('vetoed')
    expect(decisions[0].vetoed).toBe(true)
    expect(decisions[0].llmCalls).toBe(0)
    expect(decisions[0].cacheHit).toBe(false)
  })

  test('#560 LLM 裁决 → onDecision 上报三态 verdict 与 llmCalls=1', async () => {
    const cl = classifier('uncertain')
    const decisions: any[] = []
    const r = await resolveSidecarIntent('u1', '先讨论一下这个表格，然后导出成 PDF', { classifier: cl, onDecision: (d) => decisions.push(d) })
    expect(r).toBe(false)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].verdict).toBe('uncertain')
    expect(decisions[0].vetoed).toBe(false)
    expect(decisions[0].llmCalls).toBe(1)
    expect(decisions[0].cacheHit).toBe(false)
  })

  test('#560 缓存命中 → onDecision 上报 cacheHit=true 且不重复 LLM', async () => {
    const cl = classifier('discuss')
    const decisions: any[] = []
    await resolveSidecarIntent('u1', '这个治疗方案有没有文献支持', { classifier: cl, onDecision: (d) => decisions.push(d) })
    await resolveSidecarIntent('u1', '这个治疗方案有没有文献支持', { classifier: cl, onDecision: (d) => decisions.push(d) })
    expect(cl.classify).toHaveBeenCalledTimes(1)
    expect(decisions).toHaveLength(2)
    expect(decisions[1].cacheHit).toBe(true)
    expect(decisions[1].verdict).toBe('discuss')
  })
})