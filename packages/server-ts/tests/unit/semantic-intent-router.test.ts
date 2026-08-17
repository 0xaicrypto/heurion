/**
 * #562 — semantic intent router unit tests.
 *
 * Embedding is mocked with a deterministic synonym-cluster vectorizer so the
 * scoring/threshold logic is fully deterministic in CI. The real (bge-m3)
 * offline evaluation over the #559 truth matrix is a script, not a unit
 * test — it needs the local embedding service.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { SemanticIntentRouter } from '../../src/retrieval/semantic-intent-router.js'
import { SEMANTIC_GENERATE_SEEDS, SEMANTIC_VETO_SEEDS } from '../../src/retrieval/semantic-seeds.js'
import { fakeEmbed } from '../helpers/fake-embed.js'

function makeRouter(overrides: { threshold?: number; margin?: number } = {}) {
  return new SemanticIntentRouter({
    embed: fakeEmbed,
    generateSeeds: SEMANTIC_GENERATE_SEEDS,
    vetoSeeds: SEMANTIC_VETO_SEEDS,
    ...overrides,
  })
}

describe('#562 semantic intent router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('seed 语料覆盖：generate 类 ≥30 条、veto 类 ≥30 条（#562 要求 30-80/意图）', () => {
    expect(SEMANTIC_GENERATE_SEEDS.length).toBeGreaterThanOrEqual(30)
    expect(SEMANTIC_VETO_SEEDS.length).toBeGreaterThanOrEqual(30)
  })

  test('与 seed 词面高度重合的 query → 精确分类（确定性直通路径）', async () => {
    // 词面 mock 的分数分布低于真实 bge-m3（语义泛化弱），阈值调低仅用于
    // 验证"高置信直通"逻辑本身；产品默认 0.55 在下一测试验证边界。
    const r = makeRouter({ threshold: 0.45 })
    expect(await r.classify('帮我生成一份出院小结 docx')).toBe('generate')
    expect(await r.classify('帮我润色修改一下这篇论文')).toBe('veto')
    expect(await r.classify('这个表格的数字怎么来的')).toBe('veto')
    expect(await r.classify('帮我做一下脑电图的分析')).toBe('veto')
  })

  test('#562 安全属性：真值样本绝不被误判为另一类（低置信只回落，不武断）', async () => {
    const r = makeRouter()
    const generateSamples = ['把表格导出为 PDF', '帮我做一个 PPT', '生成一份病例总结', '把这份数据做成柱状图']
    const vetoSamples = ['上次那个 PPT 讲了什么', '这个图怎么解读', '分析一下 KM 曲线', '把论文的结论部分重写一遍', '帮我完善那份出院小结']
    for (const q of generateSamples) {
      expect(await r.classify(q), `generate 样本误判: ${q}`).not.toBe('veto')
    }
    for (const q of vetoSamples) {
      expect(await r.classify(q), `veto 样本误判: ${q}`).not.toBe('generate')
    }
  })

  test('与任一 seed 都不重合的 query → uncertain（回落 LLM，绝不武断）', async () => {
    const r = makeRouter()
    expect(await r.classify('今天天气怎么样')).toBe('uncertain')
    expect(await r.classify('请帮我预约明天的门诊')).toBe('uncertain')
  })

  test('#562 保守阈值：分数不足 threshold → uncertain（低置信不直接放行）', async () => {
    const r = makeRouter({ threshold: 0.99 })
    expect(await r.classify('帮我生成一份出院小结 docx')).toBe('uncertain')
  })

  test('#562 margin：两类分数接近（near-tie）→ uncertain（冲突不下结论）', async () => {
    // 构造 embed：两个类返回几乎相同向量 → 分数差 < margin
    const embed = vi.fn(async (texts: string[]) => texts.map(() => {
      const v = new Array(256).fill(0.01)
      v[0] = 1
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
      return v.map((x) => x / norm)
    }))
    const r = new SemanticIntentRouter({ embed, generateSeeds: ['生成一份 PPT'], vetoSeeds: ['分析这个表格'] })
    expect(await r.classify('任何文本')).toBe('uncertain')
  })

  test('embedding 服务不可用（embed 抛错）→ uncertain（回落 LLM 兜底）', async () => {
    const embed = vi.fn(async () => { throw new Error('embedding service down') })
    const r = new SemanticIntentRouter({ embed, generateSeeds: ['生成一份 PPT'], vetoSeeds: ['分析这个表格'] })
    expect(await r.classify('帮我生成一个 PPT')).toBe('uncertain')
  })

  test('seed 编码只在首次 classify 时支付（后续复用 centroid）', async () => {
    const embed = vi.fn(fakeEmbed)
    const r = new SemanticIntentRouter({
      embed,
      generateSeeds: ['生成一份 PPT'],
      vetoSeeds: ['分析这个表格'],
    })
    await r.classify('帮我生成一个 PPT')
    await r.classify('帮我生成一个 PPT 汇报')
    // 1 次 seed 批量编码 + 2 次 query 编码（seed 只付一次）
    expect(embed).toHaveBeenCalledTimes(3)
    expect(embed.mock.calls[0][0]).toHaveLength(2)
  })
})
