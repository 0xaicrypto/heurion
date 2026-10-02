/**
 * M1 论断核对评测（C2）：从语料构造带标签的论断集 eval/claims.jsonl（不需要人工标注）。
 *   pnpm --filter @heurion2/platform eval:build
 * - 正例：文章里带文献引用的原句 + 它所引的文献（PMID / DOI），假定「所引文献支持该句」（作者自己的引用，
 *   未逐条人工核实；摘要里不一定有证据——评测把这部分单独统计为「摘要覆盖不足」）。
 * - 反例：另一批原句做与原文矛盾的改动（记录改动类型）：改数字（效应量、百分比、样本量）、换人群、
 *   反转方向（降低 ↔ 升高）、换药物 / 对照；所引文献不变，应判为「不支持」。
 * 句子只取短摘录（CC-BY / CC0，署名见 eval/corpus.json）。
 */
import { DOMParser } from '@xmldom/xmldom'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_DIR, MANIFEST, type CorpusEntry } from './eval-fetch.ts'

export type Perturbation = 'number' | 'population' | 'direction' | 'drug'

export interface EvalClaim {
  id: string
  pmcid: string
  label: 'supported' | 'unsupported'
  perturbation: Perturbation | null
  sentence: string
  /** 反例：被改动的原文片段 → 改后的片段。 */
  change?: { from: string; to: string }
  cited: Array<{ pmid: string | null; doi: string | null }>
}

export const CLAIMS = fileURLToPath(new URL('../eval/claims.jsonl', import.meta.url))
const PER_ARTICLE = 11 // 每篇正例、反例各至多 11 条

type El = { nodeType: number; nodeName: string; childNodes: ArrayLike<El>; textContent: string | null; getAttribute(n: string): string | null; getElementsByTagName(n: string): ArrayLike<El> }

const text = (el: El | undefined | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const each = (list: ArrayLike<El>) => Array.from({ length: list.length }, (_, i) => list[i]!)

/** 参考文献 id → PMID / DOI。 */
function references(doc: El): Map<string, { pmid: string | null; doi: string | null }> {
  const out = new Map<string, { pmid: string | null; doi: string | null }>()
  for (const ref of each(doc.getElementsByTagName('ref'))) {
    const id = ref.getAttribute('id')
    if (!id) continue
    let pmid: string | null = null
    let doi: string | null = null
    for (const pid of each(ref.getElementsByTagName('pub-id'))) {
      const t = pid.getAttribute('pub-id-type')
      if (t === 'pmid') pmid = text(pid)
      if (t === 'doi') doi = text(pid).toLowerCase()
    }
    // 有的出版社（如 BMC / Springer）把 PMID / DOI 写在 ext-link 的 xlink:href 里
    for (const link of each(ref.getElementsByTagName('ext-link'))) {
      const t = link.getAttribute('ext-link-type')
      const href = (link.getAttribute('xlink:href') ?? '').trim()
      if (t === 'pmid' && !pmid && /^\d+$/.test(href)) pmid = href
      if (t === 'doi' && !doi && href) doi = href.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').toLowerCase()
    }
    if (!doi) doi = /\bdoi:?\s*(10\.\d{4,9}\/[^\s;,]+?)\.?(?:\s|$)/i.exec(text(ref))?.[1]?.toLowerCase() ?? null
    // 有的 DOI 写成落地页地址（10.1002/14651858.cd013757.pub3/full）：去掉页面后缀，否则 PubMed 查不到
    if (doi) doi = doi.replace(/\/(full|abstract|pdf|epdf)$/, '')
    if (pmid || doi) out.set(id, { pmid, doi })
  }
  return out
}

const MARK = '\u0001'

/** 段落文字，文献引用写成 \u0001rid\u0001。 */
function paragraphText(p: El): string {
  let s = ''
  const walk = (n: El) => {
    if (n.nodeType === 3) { s += n.textContent ?? ''; return }
    if (n.nodeName === 'xref' && n.getAttribute('ref-type') === 'bibr') {
      for (const rid of (n.getAttribute('rid') ?? '').split(/\s+/).filter(Boolean)) s += `${MARK}${rid}${MARK}`
      return
    }
    if (['table-wrap', 'fig', 'disp-formula', 'inline-formula'].includes(n.nodeName)) return
    for (const c of each(n.childNodes)) walk(c)
  }
  walk(p)
  return s.replace(/\s+/g, ' ')
}

/** 会被平台断句规则误断开的缩写（句点后跟空白）。 */
const ABBREV = /\b(e\.g|i\.e|vs|et al|Fig|Figs|approx|ca|No|Ref|Refs|Dr|resp|incl)\.\s/i

function candidates(article: El, refs: Map<string, { pmid: string | null; doi: string | null }>): Array<{ sentence: string; cited: EvalClaim['cited'] }> {
  const body = article.getElementsByTagName('body')[0]
  if (!body) return []
  const out: Array<{ sentence: string; cited: EvalClaim['cited'] }> = []
  for (const p of each(body.getElementsByTagName('p'))) {
    const para = paragraphText(p)
    for (const raw of para.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const rids = [...raw.matchAll(new RegExp(`${MARK}([^${MARK}]+)${MARK}`, 'g'))].map(m => m[1]!)
      const cited = [...new Set(rids)].map(r => refs.get(r)).filter((x): x is { pmid: string | null; doi: string | null } => !!x)
      if (cited.length === 0 || cited.length > 3 || cited.length < new Set(rids).size) continue
      let sentence = raw
        // 去掉引用标记及包着它们的括号、上标逗号与连接号
        .replace(new RegExp(`\\s*[\\[(]\\s*(?:${MARK}[^${MARK}]+${MARK}\\s*[,;–—-]?\\s*)+[\\])]`, 'g'), ' ')
        // 上标引用两侧可能没有空格（"France,[12] Australia"）：换成一个空格，不把前后词粘在一起
        .replace(new RegExp(`(?:${MARK}[^${MARK}]+${MARK}\\s*[,;–—-]?\\s*)+`, 'g'), ' ')
        .replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim()
      if (!/[.!?]$/.test(sentence)) sentence += '.'
      if (sentence.length < 60 || sentence.length > 320 || ABBREV.test(sentence) || /\[|\]|\bTable\b|\bFigure\b/.test(sentence)) continue
      // 断句后句中还有「. 大写」说明拆错了
      if (/\.\s+[A-Z]/.test(sentence.slice(0, -1))) continue
      // 正文里写成纯数字上标的引用（"pathologies.10 In"）：拆不准，跳过
      if (/[a-z)]\.?\d{1,3}(?:[,–-]\d{1,3})*\s+[A-Z]/.test(sentence) || /[a-z],[A-Z]/.test(sentence)) continue
      out.push({ sentence, cited })
    }
  }
  return out
}

/** 有数字 / 结论性说法的句子更适合核对，排前面。 */
function score(s: string): number {
  let n = 0
  if (/\d/.test(s)) n += 2
  if (/\b(HR|OR|RR|CI|%|p\s*[<=])/i.test(s)) n += 2
  if (/\b(reduc|increas|decreas|improv|lower|higher|associated|efficac|risk|effective)/i.test(s)) n += 1
  return n
}

// —— 反例改动 ——

const DIRECTION: Array<[RegExp, string]> = [
  [/\breduced\b/, 'increased'], [/\breduces\b/, 'increases'], [/\breduction\b/, 'increase'], [/\bdecreased\b/, 'increased'],
  [/\bdecreases\b/, 'increases'], [/\bincreased\b/, 'reduced'], [/\bincreases\b/, 'reduces'], [/\blower\b(?! (respiratory|limb|extremit|bound))/, 'higher'],
  [/\bhigher\b(?! (respiratory|limb|extremit))/, 'lower'], [/\bimproved\b/, 'worsened'], [/\bimproves\b/, 'worsens'], [/\bsuperior\b/, 'inferior'],
  [/\beffective\b/, 'ineffective'], [/\bbeneficial\b/, 'harmful'], [/\bwas associated with\b/, 'was not associated with'],
  [/\bwere associated with\b/, 'were not associated with'],
]

const POPULATION: Array<[RegExp, string]> = [
  [/\bwithout (type 2 )?diabetes\b/, 'with type 2 diabetes'], [/\btype 2 diabetes\b/, 'type 1 diabetes'],
  [/\binfants\b/, 'older adults'], [/\bolder adults\b/, 'infants'], [/\bchildren\b/, 'older adults'],
  [/\bpreterm\b/, 'term'], [/\bwomen\b/, 'men'], [/\bHFrEF\b/, 'HFpEF'], [/\bHFpEF\b/, 'HFrEF'],
  [/\breduced ejection fraction\b/i, 'preserved ejection fraction'], [/\bnon-small[- ]cell lung cancer\b/i, 'small-cell lung cancer'],
  [/\bNSCLC\b/, 'SCLC'], [/\bhepatocellular carcinoma\b/i, 'pancreatic cancer'], [/\bbiliary tract cancer\b/i, 'colorectal cancer'],
  [/\b(?<![A-Z]{2,} )obesity\b/, 'normal weight'], [/\b(?<![A-Z]{2,} )hypertension\b/, 'hypotension'], [/\bchronic kidney disease\b/, 'normal kidney function'],
]

const DRUG = /\b[A-Z]?[a-z]+(?:gliflozin|glutide|glipron|zepatide|mab|tinib|nib|vir|renone|sartan|pril|olol|statin|platin|taxel)\b/g

function perturbNumber(s: string): { from: string; to: string } | null {
  // 比值类效应量：0.xx ↔ >1（保护作用变成有害）
  const ratio = /\b(HR|OR|RR|hazard ratio|odds ratio|risk ratio)\b[^\d]{0,20}(\d\.\d{1,2})/i.exec(s)
  if (ratio) {
    const v = Number(ratio[2])
    const to = v < 1 ? (1 / v).toFixed(2) : (1 / v).toFixed(2)
    if (to !== ratio[2]) return { from: ratio[2]!, to }
  }
  // 百分比：不改区间里的数（"40–70%" 改一端会自相矛盾）
  const pct = /(?<![\d.][–-]|[–-])(?<!\d)(\d+(?:\.\d+)?)\s?%(?!\s*[–-]\s*\d)/.exec(s)
  if (pct) {
    const v = Number(pct[1])
    const next = v >= 20 ? Math.round(v / 2 * 10) / 10 : Math.round((v * 2.5 + 10) * 10) / 10
    return { from: pct[0], to: pct[0].replace(pct[1]!, String(next)) }
  }
  const n = /\b(\d{2,3}(?:,\d{3})+|\d{3,})\s+(patients|participants|adults|infants|children|subjects|individuals|women|men)\b/.exec(s)
  if (n) {
    const v = Number(n[1]!.replace(/,/g, ''))
    return { from: n[1]!, to: (v * 3).toLocaleString('en-US') }
  }
  return null
}

function perturb(s: string, kind: Perturbation, drugs: string[]): { sentence: string; change: { from: string; to: string } } | null {
  if (kind === 'number') {
    const c = perturbNumber(s)
    return c ? { sentence: s.replace(c.from, c.to), change: c } : null
  }
  const table = kind === 'direction' ? DIRECTION : kind === 'population' ? POPULATION : null
  if (table) {
    for (const [re, to] of table) {
      const m = re.exec(s)
      if (m) return { sentence: s.replace(re, to), change: { from: m[0], to } }
    }
    return null
  }
  const here = [...new Set([...s.matchAll(DRUG)].map(m => m[0]))]
  for (const d of here) {
    const other = drugs.find(x => x.toLowerCase() !== d.toLowerCase() && !here.some(h => h.toLowerCase() === x.toLowerCase()))
    if (other) {
      const to = /^[A-Z]/.test(d) ? other[0]!.toUpperCase() + other.slice(1) : other.toLowerCase()
      return { sentence: s.replace(d, to), change: { from: d, to } }
    }
  }
  return null
}

const id = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)

export function buildArticle(xml: string, pmcid: string): EvalClaim[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as El
  const refs = references(doc)
  const cands = candidates(doc, refs).map(c => ({ ...c, score: score(c.sentence) })).sort((a, b) => b.score - a.score)
  const drugs = [...new Set(cands.flatMap(c => [...c.sentence.matchAll(DRUG)].map(m => m[0].toLowerCase())))]
  const kinds: Perturbation[] = ['number', 'direction', 'population', 'drug']
  const negatives: EvalClaim[] = []
  const positives: EvalClaim[] = []
  const used = new Set<string>()
  // 反例：从轮到的改动类型开始依次尝试，取第一个能用的（保证各类都有，又不会因某类用不了而卡住）
  let k = 0
  for (const c of cands) {
    if (negatives.length >= PER_ARTICLE) break
    for (let j = 0; j < kinds.length; j++) {
      const kind = kinds[(k + j) % kinds.length]!
      const p = perturb(c.sentence, kind, drugs)
      if (!p) continue
      k = (k + j + 1) % kinds.length
      used.add(c.sentence)
      negatives.push({ id: `n${id(pmcid + p.sentence)}`, pmcid, label: 'unsupported', perturbation: kind, sentence: p.sentence, change: p.change, cited: c.cited })
      break
    }
  }
  for (const c of cands) {
    if (positives.length >= Math.max(negatives.length, 6) || used.has(c.sentence)) continue
    used.add(c.sentence)
    positives.push({ id: `p${id(pmcid + c.sentence)}`, pmcid, label: 'supported', perturbation: null, sentence: c.sentence, cited: c.cited })
  }
  return [...positives, ...negatives]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const entries = JSON.parse(readFileSync(MANIFEST, 'utf8')) as CorpusEntry[]
  const all: EvalClaim[] = []
  for (const e of entries) {
    const file = join(CORPUS_DIR, `${e.pmcid}.xml`)
    if (!existsSync(file)) { console.log(`- 跳过 ${e.pmcid}：没有全文（先跑 eval:fetch）`); continue }
    const claims = buildArticle(readFileSync(file, 'utf8'), e.pmcid)
    const by = (k: string) => claims.filter(c => (c.perturbation ?? 'positive') === k).length
    console.log(`${e.pmcid} 正例 ${by('positive')} · 反例 数字 ${by('number')} / 方向 ${by('direction')} / 人群 ${by('population')} / 药物 ${by('drug')}`)
    all.push(...claims)
  }
  writeFileSync(CLAIMS, all.map(c => JSON.stringify(c)).join('\n') + '\n')
  console.log(`共 ${all.length} 条 → ${CLAIMS}`)
}
