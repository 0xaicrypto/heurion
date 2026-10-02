import { describe, expect, it } from 'vitest'
import { decodeXmlText, PubMedClient } from '../src/literature/pubmed.ts'

describe('PubMed 摘要文本解码', () => {
  it('解码数字字符引用与预定义实体，且不二次解码', () => {
    expect(decodeXmlText('HR 0&#xb7;74 (95% CI 0&#xb7;65&#x2013;0&#xb7;85), p&#x2009;&lt;&#x2009;0&#xb7;001')).toBe('HR 0·74 (95% CI 0·65–0·85), p < 0·001')
    expect(decodeXmlText('age &#x2265;65 &amp; BMI &#8805;30')).toBe('age ≥65 & BMI ≥30')
    expect(decodeXmlText('&amp;#xb7; stays literal')).toBe('&#xb7; stays literal')
  })

  it('abstract() 返回解码后的结构化摘要', async () => {
    const xml = '<PubmedArticle><Abstract><AbstractText Label="RESULTS">Weight fell by 14&#xb7;9% (<i>p</i>&#x2009;&lt;&#x2009;0&#xb7;001).</AbstractText></Abstract></PubmedArticle>'
    const client = new PubMedClient(async () => new Response(xml, { status: 200 }))
    expect(await client.abstract('1')).toBe('RESULTS: Weight fell by 14·9% (p < 0·001).')
  })
})
