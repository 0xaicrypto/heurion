/**
 * M1 论断核对评测（C2）：用 eval/claims.jsonl 评估平台的论断核对。
 *   pnpm --filter @heurion2/platform eval:claims [--limit N] [--article PMCxxxx] [--model deepseek-flash] [--prompt v1|v2] [--report-only]
 *
 * 流程（每篇文章一份文档）：建文档 → 登记所引文献（store.upsertCitation，同 insert_citation 落库）→ 每条论断写成一段，
 * 句末带 [@c:id] → ClaimService.evidence 抽论断、按引用取 PubMed 摘要（平台的真实路径，带缓存）→ 用与 verifyPrompt
 * 相同的判定标准让模型逐条判断（DeepSeek，温度 0，JSON 输出，一页 8 条一次调用，同产品翻页）→ 与标签比对。
 * 不走完整的 dsh 回合（结果可复现、成本低）；判定标准与产品一致，模型同为 deepseek-flash（src/config.ts 的默认 DSH_MODEL）。
 * 缓存：摘要在 data/eval/eval.db（平台 Store 的摘要缓存），判断在 data/eval/verdicts.json（按论断、模型、提示版本）——
 * 重跑只补没判过的，可随时中断续跑（按文章落盘）。报告写到 eval/report.md；报告里 <!-- notes:start --> … <!-- notes:end -->
 * 之间的手写解读重新生成时保留。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaimService, type ClaimEvidence } from '../src/claims/service.ts'
import { PubMedClient } from '../src/literature/pubmed.ts'
import { assignIds } from '../src/model/ids.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { Store } from '../src/store/db.ts'
import { CLAIMS, type EvalClaim } from './eval-build.ts'
import { MANIFEST, type CorpusEntry } from './eval-fetch.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATA = join(ROOT, 'data', 'eval')
const VERDICTS = join(DATA, 'verdicts.json')
const REPORT = fileURLToPath(new URL('../eval/report.md', import.meta.url))
const ABSTRACT_MAX = 1800 // 同 ClaimService：模型看到的摘要长度

type Verdict = 'supported' | 'unsupported' | 'unclear'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const LIMIT = Number(arg('--limit') ?? Infinity)
const ONLY = arg('--article')
const MODEL = arg('--model') ?? process.env.DSH_MODEL ?? 'deepseek-flash'
const PROMPT = arg('--prompt') ?? 'v1'
const REPORT_ONLY = process.argv.includes('--report-only')
const KEY = process.env.DEEPSEEK_API_KEY ?? ''

/** v1：判定标准与 verifyPrompt（src/claims/service.ts）第 2 步一致。 */
const V1 = `你在核对医学文稿里带引用的论断。逐条对照所引文献的摘要判断：
- supported：摘要支持该句的说法与数字；
- unsupported：摘要与该句矛盾，或数字、结论、人群对不上；
- unclear：摘要信息不足以判断（例如摘要没提到该句的数字或结论，或没有摘要）。
只依据给出的摘要，不要凭记忆补充。reason 用一两句话写明依据（引用摘要里的关键数字或结论）。
只输出 JSON：{"results":[{"claim_id":"…","verdict":"supported|unsupported|unclear","reason":"…"}]}`

/**
 * v2（评测试验，产品未采用）：先逐项比对再下结论——把句子拆成「数字 / 方向 / 人群 / 干预与对照」逐项对照摘要；
 * 任何一项与摘要明确不符即 unsupported（即使其它部分摘要没提到）；只有摘要完全没涉及该句要点时才 unclear。
 */
const V2 = `你在核对医学文稿里带引用的论断。逐条对照所引文献的摘要判断。
先把句子拆成要点，逐项对照摘要：①数字（效应量、百分比、样本量、P 值）②效应方向（降低 / 升高、优于 / 劣于、有 / 无关联）③人群（疾病、分型、年龄、性别）④干预与对照（药物名、剂量、比较对象）。
- unsupported：任何一项与摘要明确不符（例如摘要写降低、句子写升高；摘要是 HFrEF、句子是 HFpEF；摘要的药物或数字与句子不同）。只要有一项明确矛盾就判 unsupported，即使句子其它部分摘要没有提到。
- supported：句子的要点在摘要里都有依据，且没有任何一项矛盾。
- unclear：没有明确矛盾，但摘要没有涉及该句的主要说法（或没有摘要）。
只依据给出的摘要，不要凭记忆补充。reason 用一两句话写明依据：矛盾时指出是哪一项、摘要原文怎么说。
只输出 JSON：{"results":[{"claim_id":"…","verdict":"supported|unsupported|unclear","reason":"…"}]}`

const PROMPTS: Record<string, string> = { v1: V1, v2: V2 }

async function judge(batch: ClaimEvidence[], system: string): Promise<Map<string, { verdict: Verdict; reason: string }>> {
  const user = batch.map(c => ({
    claim_id: c.claim_id,
    sentence: c.sentence,
    citations: c.citations.map(x => ({ number: x.number, reference: x.reference, abstract: x.abstract ?? '（无摘要）' })),
  }))
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }] }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) throw new Error(`DeepSeek ${res.status}`)
      const body = await res.json() as { choices: Array<{ message: { content: string } }> }
      const parsed = JSON.parse(body.choices[0]!.message.content) as { results: Array<{ claim_id: string; verdict: string; reason: string }> }
      const out = new Map<string, { verdict: Verdict; reason: string }>()
      for (const r of parsed.results ?? []) {
        const v = (['supported', 'unsupported', 'unclear'].includes(r.verdict) ? r.verdict : 'unclear') as Verdict
        out.set(r.claim_id, { verdict: v, reason: String(r.reason ?? '') })
      }
      return out
    } catch (err) {
      console.log(`  判断失败（第 ${attempt + 1} 次）：${(err as Error).message}`)
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)))
    }
  }
  return new Map()
}

/** markdown 里会被当成格式的字符转义。 */
const escapeMd = (s: string) => s.replace(/([\\*_`[\]<>#|])/g, '\\$1')

interface Cached {
  verdict: Verdict
  reason: string
  has_abstract: boolean
  /** 所引文献数 / 取到摘要的数。 */
  n_cites: number
  n_abstracts: number
  /** 平台把这一段切成了几条论断（>1 时按最严重的结论合并）。 */
  pieces: number
  /** 这条论断所在页：取证据（含 PubMed 取摘要）与模型判断的耗时、页大小。 */
  page_evidence_ms: number
  page_judge_ms: number
  page_size: number
}

interface Row { claim: EvalClaim; v: Cached; covered: boolean }

const SEVERITY: Record<Verdict, number> = { supported: 0, unclear: 1, unsupported: 2 }

/** 文献在评测文档里登记的键（DOI，没有 DOI 时用 pmid:xxx）。 */
const citeKey = (r: EvalClaim['cited'][number]) => r.doi ?? `pmid:${r.pmid}`

async function main(): Promise<void> {
  if (!PROMPTS[PROMPT]) throw new Error(`未知提示版本 ${PROMPT}`)
  if (!KEY && !REPORT_ONLY) throw new Error('需要 DEEPSEEK_API_KEY（../../.env）')
  mkdirSync(DATA, { recursive: true })
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as CorpusEntry[]
  const all = readFileSync(CLAIMS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as EvalClaim)
  const cache: Record<string, Cached> = existsSync(VERDICTS) ? JSON.parse(readFileSync(VERDICTS, 'utf8')) : {}
  const key = (c: EvalClaim, version = PROMPT) => `${c.id}|${MODEL}|${version}`
  const store = new Store(join(DATA, 'eval.db'))
  const docs = new Documents(store)
  const service = new ClaimService(docs, new PubMedClient(fetch, process.env.NCBI_API_KEY ?? '', process.env.CONTACT_EMAIL ?? ''))
  let budget = REPORT_ONLY ? 0 : LIMIT

  for (const article of manifest) {
    if (ONLY && article.pmcid !== ONLY) continue
    const claims = all.filter(c => c.pmcid === article.pmcid)
    const todo = claims.filter(c => !cache[key(c)])
    if (todo.length === 0 || budget <= 0) continue
    const batch = todo.slice(0, Math.max(0, budget))
    budget -= batch.length
    console.log(`${article.pmcid}：核对 ${batch.length} 条（已缓存 ${claims.length - todo.length}）`)
    // 一篇一份文档：每条论断一段，句末带引用标记
    const row = docs.create({ owner: 'eval', title: `${article.pmcid} 评测` })
    const paragraphs: string[] = []
    for (const c of batch) {
      const markers = c.cited.map(r => {
        const doi = citeKey(r)
        return `[@c:${store.upsertCitation({ doc_id: row.id, doi, pmid: r.pmid, formatted: `${doi}${r.pmid ? ` PMID ${r.pmid}` : ''}`, url: null }).id}]`
      }).join('')
      paragraphs.push(escapeMd(c.sentence).replace(/([.!?])$/, `${markers}$1`))
    }
    // parseBlocks 不分配块 id（由调用方负责），而论断抽取会跳过没有 id 的块——不补 id 就一条论断也抽不到
    // （第一版评测「已评论断 0 条」的原因）。
    docs.commit(row.id, assignIds(schema.node('doc', null, parseBlocks(paragraphs.join('\n\n'))), new Set()), { actor: 'user', turnId: null, ops: [] })
    // 段落顺序 = 论断顺序（node id → 评测论断）
    const nodeToClaim = new Map<string, EvalClaim>()
    docs.get(row.id).forEach((n, _o, i) => { if (batch[i]) nodeToClaim.set(n.attrs.id as string, batch[i]!) })
    // 平台可能把一段切成多句：每条评测论断收集它的全部片段
    type Part = { ev: ClaimEvidence; verdict: { verdict: Verdict; reason: string } | null; ems: number; jms: number; size: number }
    const parts = new Map<string, Part[]>()
    let cursor: number | null = 0
    while (cursor !== null) {
      const t0 = performance.now()
      const page = await service.evidence(row.id, cursor)
      const t1 = performance.now()
      const verdicts = await judge(page.claims, PROMPTS[PROMPT]!)
      const t2 = performance.now()
      for (const ev of page.claims) {
        const c = nodeToClaim.get(ev.node_id)
        if (!c) continue
        const list = parts.get(c.id) ?? []
        list.push({ ev, verdict: verdicts.get(ev.claim_id) ?? null, ems: t1 - t0, jms: t2 - t1, size: page.claims.length })
        parts.set(c.id, list)
      }
      cursor = page.next_cursor
    }
    let missing = 0
    for (const c of batch) {
      const list = parts.get(c.id)
      // 平台没抽到这条，或模型漏判了某个片段：不缓存，下次重跑再判
      if (!list || list.some(p => !p.verdict)) { missing++; continue }
      const worst = list.reduce((a, b) => SEVERITY[b.verdict!.verdict] > SEVERITY[a.verdict!.verdict] ? b : a)
      const cites = list.flatMap(p => p.ev.citations)
      cache[key(c)] = {
        verdict: worst.verdict!.verdict,
        reason: worst.verdict!.reason,
        has_abstract: cites.some(x => !!x.abstract),
        n_cites: new Set(cites.map(x => x.cite_id)).size,
        n_abstracts: new Set(cites.filter(x => !!x.abstract).map(x => x.cite_id)).size,
        pieces: list.length,
        page_evidence_ms: Math.round(worst.ems),
        page_judge_ms: Math.round(worst.jms),
        page_size: worst.size,
      }
    }
    if (missing) console.log(`  ${missing} 条没拿到判断（未缓存，重跑补上）`)
    writeFileSync(VERDICTS, JSON.stringify(cache, null, 1))
  }

  const rowsFor = (version: string): Row[] => all
    .filter(c => !ONLY || c.pmcid === ONLY)
    .flatMap(c => {
      const v = cache[key(c, version)]
      return v ? [{ claim: c, v, covered: covered(c, store) }] : []
    })
  const versions = Object.keys(PROMPTS).filter(ver => rowsFor(ver).length > 0)
  const prev = existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : ''
  const notes = /<!-- notes:start -->[\s\S]*?<!-- notes:end -->/.exec(prev)?.[0] ?? '<!-- notes:start -->\n（手写解读待补）\n<!-- notes:end -->'
  writeFileSync(REPORT, report(rowsFor('v1'), versions.map(ver => [ver, rowsFor(ver)] as const), manifest, notes))
  console.log(`已评 ${versions.map(ver => `${ver} ${rowsFor(ver).length} 条`).join('、') || '0 条'} → ${REPORT}`)
}

// —— 摘要覆盖（与模型判断无关的启发式）——

const STOP = new Set('about above after again also among and are been before being both but can could did does during each even from further had has have having here into its itself just like many more most much must not only other over same should since some such than that their them then there these they this those through thus under until very was were what when where which while who whom will with within without would study studies patients participants trial trials data showed shown found reported results compared group groups treatment'.split(' '))
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(w => !STOP.has(w)).map(w => w.slice(0, 6)))
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).filter(n => !/^(19|20)\d\d$/.test(n))

/** 反例还原成改动前的原句（判断摘要是否覆盖「原来的说法」）。 */
const original = (c: EvalClaim) => c.change ? c.sentence.replace(c.change.to, c.change.from) : c.sentence

/**
 * 「摘要覆盖」：原句的数字全部出现在所引摘要里（模型看到的前 1800 字），且原句实词（取前 6 个字母，去停用词）
 * 至少一半出现在摘要里。不满足即「摘要覆盖不足」——这时连正例也很难被判为支持。
 */
function covered(c: EvalClaim, store: Store): boolean {
  const text = c.cited.map(r => store.getAbstract(citeKey(r))?.abstract?.slice(0, ABSTRACT_MAX) ?? '').join('\n')
  if (!text.trim()) return false
  const s = original(c)
  const absWords = words(text)
  const sw = [...words(s)]
  const recall = sw.length ? sw.filter(w => absWords.has(w)).length / sw.length : 0
  const absNums = new Set(numbers(text))
  return recall >= 0.5 && numbers(s).every(n => absNums.has(n))
}

// —— 统计 ——

/** 严格：只有 unsupported 算检出；宽松：unsupported + unclear 都算（产品对两者都挂评论、提示人工看）。 */
function prf(rows: Row[], lenient = false) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const x of rows) {
    const pred = x.v.verdict === 'unsupported' || (lenient && x.v.verdict === 'unclear')
    const gold = x.claim.label === 'unsupported'
    if (pred && gold) tp++
    else if (pred && !gold) fp++
    else if (!pred && gold) fn++
    else tn++
  }
  const p = tp + fp ? tp / (tp + fp) : NaN
  const r = tp + fn ? tp / (tp + fn) : NaN
  return { n: rows.length, tp, fp, fn, p, r, f1: p + r ? 2 * p * r / (p + r) : NaN, fpr: fp + tn ? fp / (fp + tn) : NaN }
}

const pct = (x: number) => Number.isNaN(x) ? '—' : `${(x * 100).toFixed(1)}%`
const count = (rows: Row[], v: Verdict) => rows.filter(x => x.v.verdict === v).length
const dist = (rows: Row[]) => {
  const n = rows.length || 1
  return `${count(rows, 'supported')} / ${count(rows, 'unsupported')} / ${count(rows, 'unclear')}（${pct(count(rows, 'supported') / n)} / ${pct(count(rows, 'unsupported') / n)} / ${pct(count(rows, 'unclear') / n)}）`
}
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}
const sec = (ms: number) => Number.isNaN(ms) ? '—' : `${(ms / 1000).toFixed(1)} s`
/** 报告里的摘录：不超过 n 个词。 */
const excerpt = (s: string, n = 12) => { const w = s.split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')} …` : s }

const KINDS: Array<[string, string]> = [['number', '数字'], ['direction', '方向反转'], ['population', '人群'], ['drug', '药物 / 对照']]

function prfTable(lines: string[], groups: Array<[string, Row[]]>): void {
  lines.push('| 范围 | 条数（正 / 反） | 精确率 | 召回率 | F1 | 正例误报率 | 宽松：精确率 | 宽松：召回率 | 宽松：F1 | 宽松：正例误报率 |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const [name, rows] of groups) {
    const s = prf(rows)
    const l = prf(rows, true)
    const npos = rows.filter(x => x.claim.label === 'supported').length
    lines.push(`| ${name} | ${rows.length}（${npos} / ${rows.length - npos}） | ${pct(s.p)} | ${pct(s.r)} | ${pct(s.f1)} | ${pct(s.fpr)} | ${pct(l.p)} | ${pct(l.r)} | ${pct(l.f1)} | ${pct(l.fpr)} |`)
  }
}

function report(rows: Row[], versions: ReadonlyArray<readonly [string, Row[]]>, manifest: CorpusEntry[], notes: string): string {
  const pos = rows.filter(x => x.claim.label === 'supported')
  const neg = rows.filter(x => x.claim.label === 'unsupported')
  const cov = rows.filter(x => x.covered)
  const unc = rows.filter(x => !x.covered)
  const lines: string[] = []
  lines.push('# M1 论断核对评测（C2）', '')
  lines.push(`模型 ${MODEL}（温度 0，JSON 输出）· 主结果为提示 v1（判定标准同 verifyPrompt）· 证据：平台 ClaimService.evidence（PubMed 摘要，截断 ${ABSTRACT_MAX} 字，一页 8 条）`, '')
  lines.push('## 数据', '')
  const cites = rows.reduce((a, x) => a + x.v.n_cites, 0)
  const abs = rows.reduce((a, x) => a + x.v.n_abstracts, 0)
  lines.push(`- 语料 ${manifest.length} 篇（PubMed Central 开放获取，CC-BY / CC0，署名见 eval/corpus.json）；已评论断 ${rows.length} 条：正例（原句 + 原引用，**假定**被支持）${pos.length}、反例（规则改动后与原文矛盾）${neg.length}。`)
  lines.push(`- 所引文献 ${cites} 条次，取到 PubMed 摘要 ${abs} 条次（${pct(abs / (cites || 1))}）；至少一条引用有摘要的论断 ${rows.filter(x => x.v.has_abstract).length} 条。`)
  lines.push(`- 平台把评测句切成多条论断的 ${rows.filter(x => x.v.pieces > 1).length} 条（按最严重的结论合并）。`)
  lines.push(`- 「摘要覆盖」（启发式，与模型判断无关）：原句（反例取改动前）的数字全部出现在所引摘要里、且实词至少一半出现在摘要里。覆盖 ${cov.length} 条，覆盖不足 ${unc.length} 条（其中正例 ${unc.filter(x => x.claim.label === 'supported').length} 条）。`, '')
  lines.push('## 「不支持」检测（反例为阳性）', '')
  lines.push('严格口径：只有判为 unsupported 才算检出。宽松口径：unsupported 或 unclear 都算检出——产品对这两种结论都会在句子上挂 AI 评论、请用户复核，所以宽松口径对应「用户会被提醒」。正例误报率 = 正例被判为（严格：不支持；宽松：不支持或无法判断）的比例。', '')
  prfTable(lines, [['全部', rows], ['摘要覆盖', cov], ['摘要覆盖不足', unc]])
  lines.push('', '## 按改动类型（反例召回）', '')
  lines.push('| 改动 | 条数 | 判为不支持（严格召回） | 判为无法判断 | 判为支持（漏检） | 摘要覆盖的条数 | 摘要覆盖时严格召回 |', '|---|---|---|---|---|---|---|')
  for (const [k, name] of KINDS) {
    const xs = neg.filter(x => x.claim.perturbation === k)
    const n = xs.length || 1
    const xc = xs.filter(x => x.covered)
    lines.push(`| ${name} | ${xs.length} | ${pct(count(xs, 'unsupported') / n)} | ${pct(count(xs, 'unclear') / n)} | ${pct(count(xs, 'supported') / n)} | ${xc.length} | ${xc.length ? pct(count(xc, 'unsupported') / xc.length) : '—'} |`)
  }
  lines.push('', '## 判定分布（支持 / 不支持 / 无法判断）', '')
  lines.push(`- 正例：${dist(pos)}`)
  lines.push(`- 正例 · 摘要覆盖：${dist(pos.filter(x => x.covered))}`)
  lines.push(`- 正例 · 摘要覆盖不足：${dist(pos.filter(x => !x.covered))}`)
  lines.push(`- 反例：${dist(neg)}`)
  lines.push(`- 反例 · 摘要覆盖：${dist(neg.filter(x => x.covered))}`)
  lines.push(`- 反例 · 摘要覆盖不足：${dist(neg.filter(x => !x.covered))}`, '')

  lines.push('## 延迟', '')
  lines.push('每页（≤8 条论断）一次 evidence + 一次模型调用，同产品翻页。取证据的耗时含 PubMed 取摘要（首次；之后走缓存）。每条论断的均摊 = 页耗时 ÷ 页大小。不含完整 dsh 回合的额外开销（工具往返、claim_report 写评论）。', '')
  lines.push('| 提示 | 页数 | 取证据 p50 / p90 | 模型判断 p50 / p90 | 每条均摊 p50 / p90 |', '|---|---|---|---|---|')
  for (const [ver, rs] of versions) {
    const pages = new Map<string, Cached>()
    for (const x of rs) if (x.v.page_size) pages.set(`${x.claim.pmcid}|${x.v.page_evidence_ms}|${x.v.page_judge_ms}`, x.v)
    const ps = [...pages.values()]
    const per = rs.filter(x => x.v.page_size).map(x => (x.v.page_evidence_ms + x.v.page_judge_ms) / x.v.page_size)
    const e = ps.map(p => p.page_evidence_ms)
    const j = ps.map(p => p.page_judge_ms)
    lines.push(`| ${ver} | ${ps.length} | ${sec(quantile(e, 0.5))} / ${sec(quantile(e, 0.9))} | ${sec(quantile(j, 0.5))} / ${sec(quantile(j, 0.9))} | ${sec(quantile(per, 0.5))} / ${sec(quantile(per, 0.9))} |`)
  }

  if (versions.length > 1) {
    lines.push('', '## 提示 v1 与 v2 对比（同一批论断、同一证据）', '')
    lines.push('v2 是评测里的试验提示（逐项比对数字 / 方向 / 人群 / 干预后下结论，任一项明确矛盾即判不支持），**产品的 verifyPrompt 没有改**。', '')
    const ids = versions.map(([, rs]) => new Set(rs.map(x => x.claim.id))).reduce((a, b) => new Set([...a].filter(i => b.has(i))))
    lines.push(`共同评过的论断 ${ids.size} 条。`, '')
    prfTable(lines, versions.flatMap(([ver, rs]) => {
      const xs = rs.filter(x => ids.has(x.claim.id))
      return [[`${ver} · 全部`, xs], [`${ver} · 摘要覆盖`, xs.filter(x => x.covered)], [`${ver} · 摘要覆盖不足`, xs.filter(x => !x.covered)]] as Array<[string, Row[]]>
    }))
    lines.push('', '| 改动 | ' + versions.map(([v]) => `${v} 严格召回`).join(' | ') + ' |', '|---|' + versions.map(() => '---|').join(''))
    for (const [k, name] of KINDS) {
      lines.push(`| ${name} | ` + versions.map(([, rs]) => {
        const xs = rs.filter(x => ids.has(x.claim.id) && x.claim.perturbation === k)
        return `${pct(count(xs, 'unsupported') / (xs.length || 1))}（${count(xs, 'unsupported')}/${xs.length}）`
      }).join(' | ') + ' |')
    }
  }

  lines.push('', '## 按文章（v1）', '')
  lines.push('| PMCID | 主题 | 条数 | 摘要覆盖 | 精确率 | 召回率 | 正例被判不支持 | 正例被判无法判断 |', '|---|---|---|---|---|---|---|---|')
  for (const m of manifest) {
    const xs = rows.filter(x => x.claim.pmcid === m.pmcid)
    if (xs.length === 0) continue
    const s = prf(xs)
    const p = xs.filter(x => x.claim.label === 'supported')
    lines.push(`| ${m.pmcid} | ${m.topic} | ${xs.length} | ${xs.filter(x => x.covered).length} | ${pct(s.p)} | ${pct(s.r)} | ${count(p, 'unsupported')} | ${count(p, 'unclear')} |`)
  }

  lines.push('', '## 解读与典型错误', '', notes, '')
  lines.push('## 错误清单（自动节选，v1；原文摘录 ≤12 词）', '')
  lines.push('正例被判「不支持」：')
  for (const x of pos.filter(x => x.v.verdict === 'unsupported')) lines.push(`- ${x.claim.pmcid} ${x.claim.id}${x.covered ? '' : '（覆盖不足）'}：“${excerpt(x.claim.sentence)}” —— ${excerpt(x.v.reason, 30)}`)
  lines.push('', '反例被判「支持」（漏检）：')
  for (const x of neg.filter(x => x.v.verdict === 'supported')) lines.push(`- ${x.claim.pmcid} ${x.claim.id} [${x.claim.perturbation}：${x.claim.change?.from} → ${x.claim.change?.to}]${x.covered ? '' : '（覆盖不足）'} —— ${excerpt(x.v.reason, 30)}`)
  lines.push('', '## 局限', '')
  lines.push('- 正例的「支持」是假定（作者原文的引用），没有逐条人工核实；综述句常引用正文细节或多篇文献的综合，摘要里不一定有——正例被判「无法判断」/「不支持」里有相当一部分其实是标签噪声或证据不足，不全是模型错误。')
  lines.push('- 反例由规则改动生成，个别改动可能不构成真正的矛盾（例如改了与所引文献无关的半句、或改后的说法恰好也成立）。')
  lines.push('- 「摘要覆盖」是词面启发式（数字 + 实词重合），会把改写较多但实际有依据的句子算成覆盖不足，反之亦然。')
  lines.push('- 评测直接调模型判断，不经完整的 dsh 回合（工具调用、翻页由平台代码完成）；判定标准与产品提示一致。样本量小（每类改动十几到二十几条），百分比的置信区间很宽。')
  return lines.join('\n') + '\n'
}

await main()
