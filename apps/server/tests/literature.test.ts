import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { auditCitations, extractOfficeText } from '../src/literature/audit.ts'
import { formatAma, normalizeDoi } from '../src/literature/format.ts'
import { PubMedClient } from '../src/literature/pubmed.ts'
import { signDocToken, verifyDocToken } from '../src/literature/token.ts'

describe('format', () => {
  it('normalizes DOI prefixes and case', () => {
    expect(normalizeDoi('https://doi.org/10.1056/NEJMoa2034577')).toBe('10.1056/nejmoa2034577')
    expect(normalizeDoi('doi: 10.1/ABC')).toBe('10.1/abc')
  })

  it('formats AMA with et al after six authors', () => {
    const s = formatAma({
      pmid: '1', doi: '10.1/x', title: 'A trial.', authors: ['A B', 'C D', 'E F', 'G H', 'I J', 'K L', 'M N'],
      journal: 'N Engl J Med', year: '2020', volume: '383', issue: '27', pages: '2603-2615',
    })
    expect(s).toBe('A B, C D, E F, et al. A trial. N Engl J Med. 2020;383(27):2603-2615. doi:10.1/x')
  })
})

describe('citation audit', () => {
  const docx = (body: string) => zipSync({
    'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`),
    'word/comments.xml': strToU8('<w:comments>doi:10.9999/ignored</w:comments>'),
  })

  it('extracts body text only', () => {
    const text = extractOfficeText(docx('Hello &amp; doi:10.1000/abc'))
    expect(text).toContain('Hello & doi:10.1000/abc')
    expect(text).not.toContain('ignored')
  })

  it('flags DOIs that were never registered', () => {
    const text = 'See doi:10.1000/ABC. and https://doi.org/10.2000/xyz).'
    expect(auditCitations(text, ['10.1000/abc'])).toEqual({ ok: false, unregisteredDois: ['10.2000/xyz'] })
    expect(auditCitations(text, ['10.1000/abc', '10.2000/XYZ']).ok).toBe(true)
  })
})

describe('PubMedClient', () => {
  it('chains esearch → esummary and maps fields', async () => {
    const calls: string[] = []
    const fake = async (url: string) => {
      calls.push(url)
      const body = url.includes('esearch')
        ? { esearchresult: { idlist: ['123'] } }
        : { result: { uids: ['123'], 123: {
            uid: '123', title: 'T', source: 'Lancet', pubdate: '2021 Mar', volume: '1', pages: '2-3',
            authors: [{ name: 'Smith J' }], articleids: [{ idtype: 'doi', value: '10.1/ABC' }],
          } } }
      return new Response(JSON.stringify(body))
    }
    const out = await new PubMedClient(fake, 'k').search('asthma', 5)
    expect(out).toEqual([{ pmid: '123', doi: '10.1/abc', title: 'T', authors: ['Smith J'], journal: 'Lancet', year: '2021', volume: '1', pages: '2-3' }])
    expect(calls[0]).toContain('term=asthma')
    expect(calls[0]).toContain('api_key=k')
  })
})

describe('doc token', () => {
  it('round-trips and rejects tampering', () => {
    const t = signDocToken('s', 'doc-1')
    expect(verifyDocToken('s', t)).toBe('doc-1')
    expect(verifyDocToken('other', t)).toBeNull()
    expect(verifyDocToken('s', t.replace('doc-1', 'doc-2'))).toBeNull()
  })
})
