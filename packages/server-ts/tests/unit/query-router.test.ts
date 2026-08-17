import { describe, test, expect, beforeEach, vi } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { deepseekChat } from '../../src/common/llm.js'
import {
  classifyQuery,
  classifyQueryLLM,
  isSidecarVetoed,
  clearRouteCache,
  defaultLLMClassifier,
  parseKnowledgeCommand,
  routeQuery,
  router,
  type LLMClassifier,
} from '../../src/retrieval/query-router'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

describe('P3 — Query Router', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
  })
  describe('classifyQuery — rule layer', () => {
    test('patient age/name query → sql', () => {
      expect(classifyQuery('ZL 的年龄是多少？')).toBe('sql')
      expect(classifyQuery('患者的性别是什么')).toBe('sql')
      expect(classifyQuery('What is the patient name')).toBe('sql')
    })

    test('patient list → sql', () => {
      expect(classifyQuery('我有几个患者')).toBe('sql')
      expect(classifyQuery('list all my patients')).toBe('sql')
    })

    test('file reference → file', () => {
      expect(classifyQuery('#文件 CT报告')).toBe('file')
      expect(classifyQuery('查看上传的CT报告')).toBe('file')
    })

    test('semantic/clinical question → vector', () => {
      expect(classifyQuery('NSCLC 免疫治疗有什么进展')).toBe('vector')
      expect(classifyQuery('EGFR突变的管理策略')).toBe('vector')
      expect(classifyQuery('what are the latest immunotherapy options')).toBe('vector')
    })

    test('knowledge commands → knowledge_command', () => {
      expect(classifyQuery('搜索我的知识库关于 NSCLC')).toBe('knowledge_command')
      expect(classifyQuery('记住：ZQ 对 osimertinib 不耐受')).toBe('knowledge_command')
      expect(classifyQuery('根据我的知识库总结 EGFR 经验')).toBe('knowledge_command')
      expect(classifyQuery('查看我的未解问题')).toBe('knowledge_command')
      expect(classifyQuery('kb search NSCLC')).toBe('knowledge_command')
      expect(classifyQuery('save this to my kb: test fact')).toBe('knowledge_command')
    })

    test('default → mixed', () => {
      expect(classifyQuery('帮我总结一下 ZL 的情况')).toBe('mixed')
    })
  })

  describe('classifyQuery — fallback', () => {
    test('empty string → mixed', () => {
      expect(classifyQuery('')).toBe('mixed')
    })
  })

  describe('isSidecarVetoed — #557 确定性否决（只说不，永不说是）', () => {
    test('讨论句 → 否决（不生成，零 LLM）', () => {
      expect(isSidecarVetoed('这个表格的数字怎么来的')).toBe(true)
      expect(isSidecarVetoed('帮我做一下脑电图的分析')).toBe(true)
      expect(isSidecarVetoed('上次那个 PPT 讲了什么')).toBe(true)
      expect(isSidecarVetoed('这个图怎么解读')).toBe(true)
      expect(isSidecarVetoed('分析一下 KM 曲线')).toBe(true)
      expect(isSidecarVetoed('这个病人最近怎么样')).toBe(true)
    })

    test('编辑/润色句 → 否决', () => {
      expect(isSidecarVetoed('帮我润色修改一下这篇论文')).toBe(true)
      expect(isSidecarVetoed('改一下这份病例总结')).toBe(true)
      expect(isSidecarVetoed('polish this manuscript')).toBe(true)
      expect(isSidecarVetoed('帮我完善那份出院小结')).toBe(true)
      expect(isSidecarVetoed('把这篇论文排版成 Word 发我')).toBe(true)
      expect(isSidecarVetoed('把论文的结论部分重写一遍')).toBe(true)
    })

    test('明确的生成请求 → 不否决（交由 LLM 裁决）', () => {
      expect(isSidecarVetoed('帮我生成一份出院小结 docx')).toBe(false)
      expect(isSidecarVetoed('把表格导出为 PDF')).toBe(false)
      expect(isSidecarVetoed('生成一份病例总结')).toBe(false)
    })

    test('#558-issue 兼类词口头请求 → 不否决（交由 LLM 裁决，不再 strong 直通）', () => {
      expect(isSidecarVetoed('给我总结一下这个病人的治疗经过')).toBe(false)
      expect(isSidecarVetoed('帮我补一份近期随访报告')).toBe(false)
      expect(isSidecarVetoed('给我整理一个月度总结')).toBe(false)
    })

    test('普通问题 / 空串 → 不否决', () => {
      expect(isSidecarVetoed('这个治疗方案有没有文献支持')).toBe(false)
      expect(isSidecarVetoed('')).toBe(false)
    })

    test('#557 粘贴的长文本：正文含讨论/编辑词时被否决，否则交 LLM', () => {
      const longPaper = `${'这是一篇关于免疫治疗的论文正文，综述了多项临床研究的结果。'.repeat(30)}我们生成了一份图表来展示主要数据。`
      expect(longPaper.length).toBeGreaterThan(200)
      expect(isSidecarVetoed(longPaper)).toBe(false)
      expect(isSidecarVetoed(`${longPaper}\n请帮我润色这篇论文。`)).toBe(true)
    })
  })

  describe('parseKnowledgeCommand', () => {
    test.each([
      ['搜索我的知识库关于 NSCLC', 'kb_search', 'NSCLC'],
      ['搜索一下知识库关于 NSCLC', 'kb_search', 'NSCLC'],
      ['知识库搜索 NSCLC', 'kb_search', 'NSCLC'],
      ['kb search NSCLC', 'kb_search', 'NSCLC'],
      ['search my knowledge base for EGFR', 'kb_search', 'EGFR'],
      ['记住：ZQ 对 osimertinib 不耐受', 'kb_remember', 'ZQ 对 osimertinib 不耐受'],
      ['记住 ZQ 对 osimertinib 不耐受', 'kb_remember', 'ZQ 对 osimertinib 不耐受'],
      ['kb remember: test fact', 'kb_remember', 'test fact'],
      ['remember that ZQ has fatigue', 'kb_remember', 'ZQ has fatigue'],
      ['保存到知识库：测试事实', 'kb_remember', '测试事实'],
      ['save this to my kb: test fact', 'kb_remember', 'test fact'],
      ['根据我的知识库总结 EGFR 治疗经验', 'kb_summarize', 'EGFR 治疗经验'],
      ['总结一下知识库关于 NSCLC', 'kb_summarize', 'NSCLC'],
      ['kb summarize NSCLC', 'kb_summarize', 'NSCLC'],
      ['summarize my knowledge base about EGFR', 'kb_summarize', 'EGFR'],
      ['查看我的未解问题', 'kb_gaps', ''],
      ['我的 knowledge gaps', 'kb_gaps', ''],
      ['kb gaps', 'kb_gaps', ''],
      ['回答这个未解问题：中位 PFS 14.2 个月', 'kb_resolve_gap', '中位 PFS 14.2 个月'],
      ['kb resolve-gap: answer here', 'kb_resolve_gap', 'answer here'],
    ])('"%s" → command=%s, payload=%j', (q, cmd, payload) => {
      const result = parseKnowledgeCommand(q)
      expect(result.command).toBe(cmd)
      expect(result.payload).toBe(payload)
    })

    test('non-command query → unknown', () => {
      const result = parseKnowledgeCommand('ZL 的 CT 结果怎么样')
      expect(result.command).toBe('unknown')
      expect(result.payload).toBe('')
    })

    test('empty string → unknown', () => {
      const result = parseKnowledgeCommand('')
      expect(result.command).toBe('unknown')
      expect(result.payload).toBe('')
    })
  })

  describe('routeQuery shape', () => {
    test('returns routes array per intent', () => {
      const r1 = routeQuery('ZL的年龄', 'sql')
      expect(r1).toContain('sql')
      expect(r1).not.toContain('vector')

      const r2 = routeQuery('免疫治疗进展', 'vector')
      expect(r2).toContain('vector')
      expect(r2).not.toContain('sql')

      const r3 = routeQuery('总结ZL情况', 'mixed')
      expect(r3).toContain('sql')
      expect(r3).toContain('vector')

      const r4 = routeQuery('搜索知识库', 'knowledge_command')
      expect(r4).toEqual(['knowledge_command'])
    })
  })

  describe('router() — full pipeline', () => {
    test('rule hit returns no LLM cost', async () => {
      const result = await router('ZL 的年龄')
      expect(result.intent).toBe('sql')
      expect(result.routes).toEqual(['sql'])
      expect(result.ruleHit).toBe(true)
      expect(result.llmFallback).toBe(false)
      expect(result.cost.llmCalls).toBe(0)
    })

    test('knowledge command returns no LLM cost', async () => {
      const result = await router('搜索我的知识库关于 NSCLC')
      expect(result.intent).toBe('knowledge_command')
      expect(result.routes).toEqual(['knowledge_command'])
      expect(result.ruleHit).toBe(true)
      expect(result.llmFallback).toBe(false)
      expect(result.cost.llmCalls).toBe(0)
    })

    test('mixed without classifier stays mixed with no LLM cost', async () => {
      const result = await router('帮我看看那个病人最近咋样')
      expect(result.intent).toBe('mixed')
      expect(result.llmFallback).toBe(false)
      expect(result.cost.llmCalls).toBe(0)
    })

    test('LLM-misclassified knowledge_command without a parseable command degrades to mixed', async () => {
      vi.mocked(deepseekChat).mockResolvedValueOnce('knowledge_command')
      const result = await router('我想了解一下你学习到了那些东西？', { llmClassifier: defaultLLMClassifier })
      expect(result.intent).toBe('mixed')
      expect(result.llmFallback).toBe(true)
      expect(result.routes).toEqual(['sql', 'vector'])
    })

    test('default LLM classifier can be passed explicitly', async () => {
      vi.mocked(deepseekChat).mockResolvedValueOnce('vector')
      const result = await router('帮我看看那个病人最近咋样', { llmClassifier: defaultLLMClassifier })
      expect(result.intent).toBe('vector')
      expect(result.llmFallback).toBe(true)
      expect(result.cost.llmCalls).toBe(1)
    })

    test('caches LLM classification results for repeated queries', async () => {
      vi.mocked(deepseekChat).mockResolvedValueOnce('sql')
      const q = '那个患者最近咋样'
      const r1 = await router(q, { llmClassifier: defaultLLMClassifier })
      const r2 = await router(q, { llmClassifier: defaultLLMClassifier })
      expect(r1.intent).toBe('sql')
      expect(r2.intent).toBe('sql')
      expect(deepseekChat).toHaveBeenCalledTimes(1)
    })

    test('mixed with classifier invokes LLM fallback', async () => {
      const classifier: LLMClassifier = {
        classify: vi.fn().mockResolvedValue('sql'),
      }
      const result = await router('那个患者最近咋样', { llmClassifier: classifier })
      expect(classifier.classify).toHaveBeenCalledWith('那个患者最近咋样')
      expect(result.intent).toBe('sql')
      expect(result.ruleHit).toBe(false)
      expect(result.llmFallback).toBe(true)
      expect(result.cost.llmCalls).toBe(1)
    })

    test('classifier returning invalid intent is coerced to mixed', async () => {
      const classifier: LLMClassifier = {
        classify: vi.fn().mockResolvedValue('invalid' as any),
      }
      const result = await router('something weird', { llmClassifier: classifier })
      expect(result.intent).toBe('mixed')
      expect(result.llmFallback).toBe(true)
      expect(result.cost.llmCalls).toBe(1)
    })

    test('classifier throwing is handled gracefully', async () => {
      const classifier: LLMClassifier = {
        classify: vi.fn().mockRejectedValue(new Error('LLM down')),
      }
      const result = await router('something weird', { llmClassifier: classifier })
      expect(result.intent).toBe('mixed')
      expect(result.llmFallback).toBe(true)
      expect(result.cost.llmCalls).toBe(1)
    })
  })

  describe('regression — existing queries', () => {
    test('patient demographic queries still route to sql', () => {
      expect(classifyQuery('ZL 的年龄是多少？')).toBe('sql')
      expect(classifyQuery('What is the patient name')).toBe('sql')
    })

    test('file references still route to file', () => {
      expect(classifyQuery('#文件 CT报告')).toBe('file')
    })

    test('clinical questions still route to vector', () => {
      expect(classifyQuery('NSCLC 免疫治疗有什么进展')).toBe('vector')
    })

    test('summary queries still route to mixed', () => {
      expect(classifyQuery('帮我总结一下 ZL 的情况')).toBe('mixed')
    })
  })

  describe('cost observability', () => {
    test('rule layer should handle 80%+ of common queries', () => {
      const samples = [
        'ZL 的年龄',
        '患者列表',
        '#文件 CT报告',
        '查看上传的CT报告',
        'NSCLC 免疫治疗有什么进展',
        'EGFR突变的管理策略',
        '搜索我的知识库关于 NSCLC',
        '记住：ZQ 对 osimertinib 不耐受',
        '根据我的知识库总结 EGFR 经验',
        '查看我的未解问题',
        'what are the latest immunotherapy options',
        'list all my patients',
        'kb search NSCLC',
      ]
      const ruleHits = samples.filter(q => classifyQuery(q) !== 'mixed').length
      expect(ruleHits / samples.length).toBeGreaterThanOrEqual(0.8)
    })
  })

  describe('classifyQueryLLM', () => {
    test('without classifier returns mixed', async () => {
      const result = await classifyQueryLLM('any query')
      expect(result).toBe('mixed')
    })

    test('uses classifier when provided', async () => {
      const classifier: LLMClassifier = {
        classify: vi.fn().mockResolvedValue('vector'),
      }
      const result = await classifyQueryLLM('any query', classifier)
      expect(result).toBe('vector')
    })

    test('invalid classifier output is coerced to mixed', async () => {
      const classifier: LLMClassifier = {
        classify: vi.fn().mockResolvedValue('banana' as any),
      }
      const result = await classifyQueryLLM('any query', classifier)
      expect(result).toBe('mixed')
    })
  })
})

describe('§5.6 routeCache bounds (#199)', () => {
  beforeEach(() => { clearRouteCache() })

  test('cache is bounded — evicts oldest beyond the cap', async () => {
    const { router } = await import('../../src/retrieval/query-router')
    // 600 distinct queries exceeds ROUTE_CACHE_MAX (500).
    for (let i = 0; i < 600; i++) {
      await router(`distinct query number ${i}`)
    }
    const { routeCache } = await import('../../src/retrieval/query-router') as any
    const size = routeCache ? routeCache.size : 0
    expect(size).toBeLessThanOrEqual(500)
    // The most recent query is still cached.
    const r = await router('distinct query number 599')
    expect(r.intent).toBeDefined()
  })
})
