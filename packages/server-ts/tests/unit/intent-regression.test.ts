/**
 * #559 — sidecar 意图判定回归锚点测试集（真值矩阵）。
 *
 * 意图判定在 #557 后依赖"强否决规则 + LLM 裁决"，LLM 漂移不可见——这份矩阵是
 * 唯一的质量闸门：任何 prompt 变更 / 模型切换 / 路由改动都必须先跑本文件。
 *
 * 结构：
 * - VETO_CASES：命中否决正则 → 必须 false，且断言不调用 LLM（零成本路径）
 * - LLM_CASES：交 LLM 裁决 → 用 fake classifier 驱动 generate/discuss/uncertain，
 *   断言 resolveSidecarIntent 的输出与 classifer 收到的输入一致
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { resolveSidecarIntent, clearSidecarCache, type SidecarClassifier, type SidecarHistoryEntry } from '../../src/retrieval/intent-router.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

/** 编辑/润色/讨论类——否决命中，零 LLM（真值矩阵 v1，取自 #549-#558 全部误判场景） */
const VETO_CASES: Array<{ input: string; why: string }> = [
  // 讨论类（#549）
  { input: '这个表格的数字怎么来的', why: '#549 讨论句' },
  { input: '帮我做一下脑电图的分析', why: '#549 讨论句（"做"不是生成）' },
  { input: '上次那个 PPT 讲了什么', why: '#549 讨论已有内容' },
  { input: '这个图怎么解读', why: '#549 图解读' },
  { input: '分析一下 KM 曲线', why: '#549 分析句' },
  { input: '为什么这条曲线这么陡', why: '#549 为什么' },
  { input: '这个病人最近怎么样', why: '#549 问病情（保守否决）' },
  // 编辑/润色类（#551/#552/#558）
  { input: '帮我润色修改一下这篇论文', why: '#552 润色' },
  { input: '改一下这份病例总结', why: '#552 修改' },
  { input: 'polish this manuscript', why: '#552 英文润色' },
  { input: '帮我完善那份出院小结', why: '#552 完善' },
  { input: '把论文的结论部分重写一遍', why: '#551 改写（正则盲区）' },
  { input: '把这篇论文排版成 Word 发我', why: '#557 排版（正则盲区）' },
  { input: '帮我把 PPT 里第三页的图表改一下', why: '#552 修改已有文档' },
  { input: '帮我整体润色一遍再发我', why: '#552 润色变体' },
]

/** 生成/对话/模糊类——交 LLM 裁决（fake classifier 驱动） */
const GENERATE_CASES: Array<{ input: string; history?: SidecarHistoryEntry[]; why: string }> = [
  { input: '帮我生成一份出院小结 docx', why: '#549 明确生成' },
  { input: '把表格导出为 PDF', why: '#549 导出' },
  { input: '生成一份病例总结', why: '#549 文档名' },
  { input: '请给我做一个 PPT 汇报这个病例', why: '#549 制作 PPT' },
  { input: '用 docx 把这份病历整理成文档', why: '#557 正则盲区（LLM 应识别）' },
  { input: '帮我做个肺癌的幻灯片汇报', why: '#557 口语化生成' },
  { input: '做好了发我', why: '#558 历史指代', history: [{ role: 'user', content: '帮我做个 PPT' }] },
]

const DISCUSS_CASES: Array<{ input: string; history?: SidecarHistoryEntry[]; why: string }> = [
  { input: '给我总结一下这个病人的治疗经过', why: '#558-issue 兼类词（口头总结）' },
  { input: 'give me a summary of the treatment', why: '#558-issue 英文兼类词' },
  { input: '上次说的 km curve 数据准确吗', why: '#549 讨论已有内容' },
]

const UNCERTAIN_CASES: Array<{ input: string; why: string }> = [
  { input: '先讨论一下这个表格，然后导出成 PDF', why: '#557 混合意图' },
  { input: '你觉得这个图怎么样，顺便存个档', why: '#557 混合/模糊' },
]

describe('#559 sidecar 意图真值矩阵（回归锚点）', () => {
  beforeEach(() => {
    clearSidecarCache()
    vi.clearAllMocks()
  })

  const fake = (decision: 'generate' | 'discuss' | 'uncertain'): SidecarClassifier => ({
    classify: vi.fn().mockResolvedValue(decision),
  })

  describe('否决类：编辑/讨论 → 不生成，且零 LLM 调用', () => {
    test.each(VETO_CASES)('$why → "$input"', async ({ input }) => {
      const cl = fake('generate') // 即使 LLM 说 generate，否决也必须赢
      const r = await resolveSidecarIntent('u1', input, { classifier: cl })
      expect(r).toBe(false)
      expect(cl.classify).not.toHaveBeenCalled()
    })
  })

  describe('生成类：LLM 裁决 generate → 放行，history 正确注入', () => {
    test.each(GENERATE_CASES)('$why → "$input"', async ({ input, history }) => {
      const cl = fake('generate')
      const r = await resolveSidecarIntent('u1', input, { classifier: cl, history })
      expect(r).toBe(true)
      expect(cl.classify).toHaveBeenCalledWith(input, history)
    })
  })

  describe('讨论类：LLM 裁决 discuss → 不生成', () => {
    test.each(DISCUSS_CASES)('$why → "$input"', async ({ input, history }) => {
      const cl = fake('discuss')
      const r = await resolveSidecarIntent('u1', input, { classifier: cl, history })
      expect(r).toBe(false)
    })
  })

  describe('模糊类：LLM 裁决 uncertain → 不生成（保守默认）', () => {
    test.each(UNCERTAIN_CASES)('$why → "$input"', async ({ input }) => {
      const cl = fake('uncertain')
      const r = await resolveSidecarIntent('u1', input, { classifier: cl })
      expect(r).toBe(false)
    })
  })

  describe('粘贴长文本场景', () => {
    const longPaper = `${'这是一篇关于免疫治疗的论文正文，综述了多项临床研究的结果，详细讨论了入组人群的基线特征。'.repeat(30)}我们生成了一张图表用于总结。`

    test('粘贴全文 + 生成字样 → 不走任何直通，LLM 保守时降级对话', async () => {
      const cl = fake('uncertain')
      const r = await resolveSidecarIntent('u1', longPaper, { classifier: cl })
      expect(r).toBe(false)
      expect(cl.classify).toHaveBeenCalled()
    })

    test('粘贴全文 + 润色请求 → 否决命中，零 LLM', async () => {
      const cl = fake('generate')
      const r = await resolveSidecarIntent('u1', `${longPaper}\n请帮我润色一下这篇论文`, { classifier: cl })
      expect(r).toBe(false)
      expect(cl.classify).not.toHaveBeenCalled()
    })
  })
})
