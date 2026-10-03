import { describe, expect, it } from 'vitest'
import { FullTextClient, relevantPassages } from '../src/literature/fulltext.ts'
import { Store } from '../src/store/db.ts'

const TEXT = `Title of the trial

Background paragraph about cardiovascular disease, obesity and the rationale for this randomized controlled trial in adults.

Results: dapagliflozin reduced plasma IL-1B at 12 months, but not IL-6 or TNF-alpha; hsCRP was unchanged (p = 0.41) in 62 participants.

Discussion paragraph discussing limitations of the small sample and the need for larger trials of SGLT2 inhibitors.

References

1. Some cited paper about IL-6 and TNF-alpha 12 months 62 participants.`

describe('开放获取全文', () => {
  it('片段：按数字与实词挑最相关的段落，跳过参考文献表', () => {
    const out = relevantPassages(TEXT, '达格列净 12 个月降低了 IL-6 与 TNF-alpha（62 例）')
    expect(out[0]).toContain('reduced plasma IL-1B at 12 months')
    expect(out.join(' ')).not.toContain('Some cited paper')
    expect(relevantPassages(TEXT, '无关的话')).toEqual([])
  })

  it('PMC：DOI → PMC id → 开放数据最新版本的纯文本；结果缓存，没有全文也缓存', async () => {
    const calls: string[] = []
    const fake = async (url: string) => {
      calls.push(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('idconv')) return json({ records: [{ pmcid: url.includes('10.1%2Fopen') ? 'PMC1' : undefined }] })
      if (url.endsWith('/metadata/PMC1.1.json')) return json({ is_pmc_openaccess: true, license_code: 'CC BY', text_url: 's3://pmc-oa-opendata/PMC1.1/PMC1.1.txt?md5=x' })
      if (url.endsWith('/metadata/PMC1.2.json')) return json({ is_pmc_openaccess: true, license_code: 'CC BY', text_url: 's3://pmc-oa-opendata/PMC1.2/PMC1.2.txt?md5=y' })
      if (url.includes('/metadata/')) return new Response('', { status: 404 })
      if (url.endsWith('/PMC1.2/PMC1.2.txt')) return new Response(TEXT)
      return new Response('', { status: 404 })
    }
    const store = new Store(':memory:')
    const ft = new FullTextClient(store, fake as never, '')
    const got = await ft.get('10.1/open')
    expect(got).toMatchObject({ source: 'pmc', license: 'CC BY', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/' })
    expect(got!.text).toContain('IL-1B')
    const n = calls.length
    await ft.get('10.1/open')
    expect(calls.length).toBe(n) // 缓存
    expect(await ft.get('10.1/closed')).toBeNull()
    const m = calls.length
    expect(await ft.get('10.1/closed')).toBeNull()
    expect(calls.length).toBe(m) // 没有全文也缓存
  })
})
