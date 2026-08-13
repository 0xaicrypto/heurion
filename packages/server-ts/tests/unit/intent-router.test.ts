import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { resolveSidecarIntent, clearSidecarCache, type SidecarClassifier } from '../../src/retrieval/intent-router.js'
import { matchIntent } from '../../src/modules/plugins/plugin-capability.service.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
vi.mock('../../src/modules/plugins/plugin-capability.service.js', () => ({
  matchIntent: vi.fn(),
}))

const mockMatch = vi.mocked(matchIntent)

describe('#549 — sidecar 意图精裁（规则粗筛 → LLM 裁决）', () => {
  beforeEach(() => {
    clearSidecarCache()
    vi.clearAllMocks()
    mockMatch.mockResolvedValue(null)
  })

  const classifier = (decision: string): SidecarClassifier => ({
    classify: vi.fn().mockResolvedValue(decision),
  })

  test('普通问题（无候选）不触发文件生成，且不花 LLM 精裁调用', async () => {
    const cl = classifier('generate')
    const r = await resolveSidecarIntent('u1', '这个病人最近怎么样', { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).not.toHaveBeenCalled()
  })

  test('讨论句：插件候选命中但 LLM 裁决 discuss → 不生成文件', async () => {
    mockMatch.mockResolvedValue({ pluginId: 'heurion/table', toolName: 'render_table', intent: 'table', confidence: 0.3 })
    const cl = classifier('discuss')
    const r = await resolveSidecarIntent('u1', '这个表格的数字怎么来的', { classifier: cl })
    expect(r).toBe(false)
    expect(cl.classify).toHaveBeenCalledWith('这个表格的数字怎么来的', undefined)
  })

  test('弱候选 + LLM 裁决 generate → 触发文件生成', async () => {
    const cl = classifier('generate')
    const r = await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(r).toBe(true)
    expect(cl.classify).toHaveBeenCalled()
  })

  test('LLM 裁决 uncertain → 安全降级为正常对话', async () => {
    const cl = classifier('uncertain')
    const r = await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(r).toBe(false)
  })

  test('LLM 精裁异常 → 安全降级为正常对话', async () => {
    const cl: SidecarClassifier = { classify: vi.fn().mockRejectedValue(new Error('llm down')) }
    const r = await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(r).toBe(false)
  })

  test('强生成信号（动词+格式词）直接放行，不花 LLM 调用', async () => {
    const cl = classifier('discuss')
    const r = await resolveSidecarIntent('u1', '帮我生成一份出院小结 docx', { classifier: cl })
    expect(r).toBe(true)
    expect(cl.classify).not.toHaveBeenCalled()
  })

  test('精裁结果按 用户+查询 缓存，重复提问不重复花 LLM 调用', async () => {
    const cl = classifier('generate')
    await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    await resolveSidecarIntent('u1', '帮我看看病例总结', { classifier: cl })
    expect(cl.classify).toHaveBeenCalledTimes(1)
  })

  test('对话历史传递给分类器（承接指代语义）', async () => {
    mockMatch.mockResolvedValue({ pluginId: 'heurion/pptx', toolName: 'generate_pptx', intent: 'pptx', confidence: 0.3 })
    const cl = classifier('generate')
    const history = [{ role: 'user' as const, content: '帮我做个 PPT' }]
    await resolveSidecarIntent('u1', '做好了发我', { classifier: cl, history })
    expect(cl.classify).toHaveBeenCalledWith('做好了发我', history)
  })
})