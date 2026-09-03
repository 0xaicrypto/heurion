import { describe, test, expect } from 'vitest'
import { normalizeSynthesizedArticle } from '../../src/memory/article-contract.js'
import { articleSynthesisPrompt, ARTICLE_SYNTHESIS_PERSONA } from '../../src/memory/prompts.js'

/**
 * #813 — answer-ready 合成契约:结构化 JSON → 固定 markdown(首行=标题,
 * registry 提案落库按首行拆标题),factId 白名单过滤防编造,legacy 形态兜底。
 */

const ALLOWED = ['fact_aaa', 'fact_bbb', 'fact_ccc']

const STRUCTURED = {
  title: 'EGFR-TKI 一线选择',
  question: 'EGFR 突变阳性 NSCLC 的一线治疗如何选择?',
  conclusion: '三代 EGFR-TKI 一线治疗显著延长 PFS。',
  evidence: [
    { claim: '三代药物优于一代', factIds: ['fact_aaa', 'fact_bbb'], confidence: 'high' },
    { claim: '编造引用应被过滤', factIds: ['fact_zzz'], confidence: 'low' },
    { claim: '无引用论断应被丢弃', factIds: [], confidence: 'high' },
  ],
  caveats: ['T790M 状态未知时疗效不确定', '非 structured 字段'],
}

describe('#813 normalizeSynthesizedArticle — structured path', () => {
  test('builds markdown with title first line + 结论/依据/注意事项 sections', () => {
    const out = normalizeSynthesizedArticle(STRUCTURED, ALLOWED)!
    expect(out).not.toBeNull()
    expect(out.content.startsWith('EGFR-TKI 一线选择\n')).toBe(true)
    expect(out.content).toContain('> 回答的问题: EGFR 突变阳性 NSCLC 的一线治疗如何选择?')
    expect(out.content).toContain('### 结论')
    expect(out.content).toContain('### 依据')
    expect(out.content).toContain('### 注意事项')
    expect(out.content).toContain('（fact_aaa, fact_bbb｜置信度: 高）')
  })

  test('filters fabricated factIds and drops claims without valid citations', () => {
    const out = normalizeSynthesizedArticle(STRUCTURED, ALLOWED)!
    expect(out.citedFactIds).toEqual(['fact_aaa', 'fact_bbb'])
    expect(out.content).not.toContain('fact_zzz')
    expect(out.content).not.toContain('无引用论断应被丢弃')
  })

  test('legacy {title, content} passes through with title-first invariant intact', () => {
    const out = normalizeSynthesizedArticle({ title: 'T', content: '正文内容' }, ALLOWED)!
    expect(out.title).toBe('T')
    expect(out.content).toBe('T\n\n正文内容')
    expect(out.citedFactIds).toEqual([])
  })

  test('legacy content already starting with title is not double-prefixed', () => {
    const out = normalizeSynthesizedArticle({ title: 'T', content: 'T\n\n正文' }, ALLOWED)!
    expect(out.content).toBe('T\n\n正文')
  })

  test('missing title → null; missing conclusion without content → null', () => {
    expect(normalizeSynthesizedArticle({ conclusion: 'x' }, ALLOWED)).toBeNull()
    expect(normalizeSynthesizedArticle({ title: 'T' }, ALLOWED)).toBeNull()
  })

  test('non-object / null input → null', () => {
    expect(normalizeSynthesizedArticle(null, ALLOWED)).toBeNull()
    expect(normalizeSynthesizedArticle('str', ALLOWED)).toBeNull()
  })

  test('en lang renders English section headers and confidence labels', () => {
    const out = normalizeSynthesizedArticle(STRUCTURED, ALLOWED, { lang: 'en' })!
    expect(out.content).toContain('### Conclusion')
    expect(out.content).toContain('### Evidence')
    expect(out.content).toContain('### Caveats')
    expect(out.content).toContain('confidence: high')
  })

  test('caveats coerced from a single string', () => {
    const out = normalizeSynthesizedArticle({ ...STRUCTURED, caveats: '单一字符串 caveat' }, ALLOWED)!
    expect(out.content).toContain('- 单一字符串 caveat')
  })
})

describe('#813 articleSynthesisPrompt — contract instructions', () => {
  test('zh prompt lists facts with stableId prefixes and demands JSON contract', () => {
    const factList = '[fact_aaa] importance=4 source=patient: 患者确诊 NSCLC'
    const prompt = articleSynthesisPrompt(factList)
    expect(prompt).toContain('answer-ready')
    expect(prompt).toContain('[fact_aaa]')
    expect(prompt).toContain('"factIds"')
    expect(prompt).toContain('禁止编造 ID')
  })

  test('en persona prompt (regenerate path) demands the same contract in English', () => {
    const prompt = articleSynthesisPrompt('[fact_aaa] x', ARTICLE_SYNTHESIS_PERSONA.researcherEn)
    expect(prompt).toContain('never invent IDs')
    expect(prompt).toContain('"caveats"')
  })
})
