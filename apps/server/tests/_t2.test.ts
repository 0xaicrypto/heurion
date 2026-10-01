import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { it } from 'vitest'
import { ensureDocxParaIds } from '../src/docs/office.ts'

it('dbg: ensure 保留 commentRangeStart 上下文', () => {
  const r = ensureDocxParaIds(new Uint8Array(readFileSync('/tmp/with-comment.docx')))
  const xml = strFromU8(unzipSync(r.bytes)['word/document.xml']!)
  const at = xml.indexOf('commentRangeStart')
  console.log('保留 paraId check:', xml.slice(Math.max(0, at - 220), at).includes('paraId'), '| stats:', JSON.stringify(r.stats))
})
