/**
 * 平台 e2e（真实 dsh + 模型）：对运行中的平台跑一组任务，统计耗时、工具调用与断言结果。
 *   pnpm --filter @heurion2/platform e2e [baseUrl]
 * 需要 server 在跑且配置了 DEEPSEEK_API_KEY。会在平台里新建测试文档。
 */
import { strToU8, zipSync } from 'fflate'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.HEURION_DEV_TOKEN || 'dev'
const H = { Authorization: `Bearer ${TOKEN}` }

interface Turn { ms: number; events: Array<Record<string, any>>; calls: string[]; errors: string[] }

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>
}

async function turn(path: string, body: unknown): Promise<Turn> {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  const events = text.split('\n\n').map(f => f.split('\n').find(l => l.startsWith('data:'))).filter(Boolean).map(l => JSON.parse(l!.slice(5)))
  return {
    ms: Date.now() - t0,
    events,
    calls: events.filter(e => e.type === 'tool_call').map(e => String(e.name).replace(/^mcp__heurion__/, '')),
    errors: events.filter(e => e.type === 'tool_result' && e.isError).map(e => e.code ?? 'error'),
  }
}

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const summary = (t: Turn) => `${(t.ms / 1000).toFixed(1)}s · 工具 ${t.calls.length}（${[...new Set(t.calls)].join(', ')}）· 工具报错 ${t.errors.length}${t.errors.length ? `：${t.errors.join(', ')}` : ''}`
const shell = (t: Turn) => t.calls.some(c => !['doc_outline', 'doc_read', 'doc_search', 'doc_edit', 'doc_history', 'doc_diff', 'doc_list', 'doc_create', 'comments_list', 'comment_reply', 'comment_resolve', 'pubmed_search', 'doi_lookup', 'insert_citation', 'list_citations', 'asset_upload'].includes(c))

// —— 1. 起草：带引用的证据段 ——
const doc = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 司美格鲁肽', markdown: '# 引言\n\n司美格鲁肽是 GLP-1 受体激动剂。\n\n# 证据\n\n待补充。' }) })
const t1 = await turn(`/api/docs/${doc.id}/chat`, { message: '把「证据」下的「待补充」改写成一段 SUSTAIN-6 与 SELECT 的证据综述（各给出 MACE 的 HR 与 95% CI），并按规范引用两项试验的原始文献。' })
const d1 = await api(`/api/docs/${doc.id}`)
const md1 = await api<string>(`/api/docs/${doc.id}/export.md`)
check('起草：文档被修改', t1.events.some(e => e.type === 'doc_updated'), summary(t1))
check('起草：引用 ≥ 2 条且都在文中使用', d1.citations.filter((c: any) => c.number).length >= 2)
check('起草：正文无 DOI、参考文献表由平台生成', !/10\.\d{4,9}\//.test(md1.split('## 参考文献')[0]!) && md1.includes('## 参考文献'))
check('起草：未修改「引言」', md1.includes('司美格鲁肽是 GLP-1 受体激动剂。'))
check('起草：只用平台工具改文档', !shell(t1), t1.calls.join(' '))
check('起草：回合结束落版本', t1.events.some(e => e.type === 'version'))

// —— 2. 评论驱动 ——
const html = (await api(`/api/docs/${doc.id}/html`)).html as string
const introId = /<p data-id="([a-z0-9]+)">司美格鲁肽是/.exec(html)?.[1]
const comment = await api(`/api/docs/${doc.id}/comments`, { method: 'POST', body: JSON.stringify({ node_id: introId, snippet: 'GLP-1 受体激动剂', text: '补充一句给药方式（每周一次皮下注射/口服）' }) })
const t2 = await turn(`/api/docs/${doc.id}/comments/${comment.id}/ask`, {})
const d2 = await api(`/api/docs/${doc.id}`)
const c2 = d2.comments.find((c: any) => c.id === comment.id)
check('评论：AI 修改了锚定块', t2.calls.includes('doc_edit') && /皮下|口服/.test(c2.anchor.text + (await api(`/api/docs/${doc.id}/export.md`))), summary(t2))
check('评论：AI 在线程里回复', c2.replies.some((r: any) => r.role === 'ai'))
check('评论：改过内容的线程留给用户关闭', c2.status === 'open')
check('评论：锚点仍可定位', c2.anchor.located)

// —— 3. 追问（同一会话多轮） ——
const t3 = await turn(`/api/docs/${doc.id}/chat`, { message: '把刚才写的证据段压缩到 120 字以内，保留两个 HR 和引用。' })
const md3 = await api<string>(`/api/docs/${doc.id}/export.md`)
const evidence = md3.split('# 证据')[1]?.split('## 参考文献')[0] ?? ''
check('追问：证据段压缩且保留引用', evidence.replace(/\s/g, '').length < 220 && (evidence.match(/\[\d\]/g) ?? []).length >= 2, `${summary(t3)} · 证据段 ${evidence.replace(/\s/g, '').length} 字`)

// —— 4. 导入 docx → 局部修改 → 导出 ——
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (t: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const body = [para('研究背景', 'Heading1'), para('2 型糖尿病患病率持续上升，其慢性血管并发症是致残和致死的主要原因，寻找能够改善硬终点的降糖策略因此成为临床研究的重点，相关研究近年来数量很多。'), para('早期 RCT 提示强化血糖控制可降低微血管并发症风险。')].join('')
const file = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
})
const form = new FormData()
form.append('file', new Blob([file]), 'e2e 导入.docx')
const imported = await api('/api/docs', { method: 'POST', body: form })
const t4 = await turn(`/api/docs/${imported.id}/chat`, { message: '把第一段正文改得更简洁（不超过 40 字），其他内容不要动。' })
const res = await fetch(`${BASE}/api/docs/${imported.id}/export.docx`, { headers: H })
const exported = new Uint8Array(await res.arrayBuffer())
const { unzipSync, strFromU8 } = await import('fflate')
const xml = strFromU8(unzipSync(exported)['word/document.xml']!)
check('导入：AI 只改了第一段', t4.calls.includes('doc_edit') && !xml.includes('相关研究近年来数量很多'), summary(t4))
check('导出：未改动的块原样写回', xml.includes(para('研究背景', 'Heading1')) && xml.includes(para('早期 RCT 提示强化血糖控制可降低微血管并发症风险。')))

const passed = results.filter(r => r.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)
