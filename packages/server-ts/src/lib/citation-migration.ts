/**
 * #1080/#1084（epic）— 存量文档参考文献迁移（best-effort）。
 *
 * 输入：正文含手写 `## References` 区（编号条目 [1]…/1.…）+ 正文 `[n]` 引用标记。
 * 输出：条目解析为结构化 DocCitation（DOI 必填），正文对应 `[n]` 替换为
 * `[cite:id]` 标记；无法解析的条目**保留原文本**并打「⚠ 待复核」标记（不静默
 * 丢弃）。全部条目解析成功时移除手写 References 区（派生列表接管，#1078）；
 * 部分成功时保留仅含待复核条目的区段（数据零丢失）。
 *
 * 解析优先级（issue 定案）：
 *   1. 条目已含 DOI 文本 → 直接使用（crossrefResolveDoi 校验存在性可选，直接信任文本 DOI）
 *   2. 仅含 PMID → PubMed esummary 反查
 *   3. 仅含标题/作者 → Crossref 题名检索，标题相似度阈值不足不强匹配（归待复核）
 *
 * 幂等：重复执行不重复建行（确定性 id）不重复替换（已替换处检测）；
 * dry-run 只输出变更计划不落库/不写正文。
 *
 * 外部检索依赖可注入（LookupDeps）— 测试 mock 用，CLI 默认接真实客户端。
 */
import prisma from '../common/prisma.js'
import { resolveOrCreateDocCitation, type DocCitationInput } from './citation-store.js'
import { crossrefResolveDoi, crossrefSearchBibliographic } from '../tools/crossref.client.js'
import { eutilsJson } from '../tools/search-citation-tool.js'
import { CITE_SHORTCODE_PATTERN } from '@heurion/contracts'

export interface LookupDeps {
  /** DOI 直解（默认 Crossref）— 返回规范记录或 null（不存在/形式错）。 */
  resolveByDoi?: (doi: string) => Promise<{ title: string; authors: string[]; journal?: string; year?: string; pmid?: string; url?: string } | null>
  /** PMID 反查（默认 PubMed esummary）。 */
  lookupPmid?: (pmid: string) => Promise<{ title: string; authors: string[]; journal?: string; year?: string; doi?: string } | null>
  /** 标题检索（默认 Crossref bibliographic）。 */
  searchTitle?: (title: string) => Promise<Array<{ title: string; doi: string; authors: string[]; journal?: string; year?: string; url?: string }>>
}

/** 标题相似度阈值 — 低于它不强配（issue：命中不够高不强行匹配）。 */
const TITLE_SIMILARITY_THRESHOLD = 0.6

export interface MigrationPlan {
  docId: string
  /** 解析成功：entry 序号 → (citation id, doi) */
  resolved: Array<{ n: number; citationId: string; doi: string; title: string; via: 'doi' | 'pmid' | 'title' }>
  /** 待复核：条目文本原样保留（未删除） */
  pending: Array<{ n: number; reason: string; entry: string }>
  /** 正文替换的 [n] 标记数 */
  replacements: number
  /** 手写 References 区是否整体移除（全部条目解析成功时） */
  removedSection: boolean
  dryRun: boolean
}

/** 解析 References 区条目（[n] / n. 前缀），返回 1-based 序号 → 条目文本。 */
export function parseReferencesEntries(section: string): Map<number, string> {
  const entries = new Map<number, string>()
  const lines = section.split('\n')
  let currentN: number | null = null
  let currentText = ''
  const flush = () => {
    if (currentN !== null && currentText.trim()) entries.set(currentN, currentText.trim())
    currentN = null
    currentText = ''
  }
  for (const line of lines) {
    const m = /^\s*(?:\[?(\d{1,3})\]?|[•*-])\s+(.*)$/.exec(line)
    if (m && m[1]) {
      flush()
      currentN = Number(m[1])
      currentText = m[2]
    } else if (currentN !== null && line.trim()) {
      currentText += ` ${line.trim()}` // 折行归并
    } else if (!line.trim()) {
      flush()
    }
  }
  flush()
  return entries
}

/** 定位手写 References 区（标题 + 区间）。与 asset-content.stripLegacyReferencesSection 同口径的标题变体。 */
export function locateReferencesSection(body: string): { start: number; end: number; content: string } | null {
  const headingRe = /^#{1,3}\s*(?:\*\*)?(?:references|参考文献)(?:\*\*)?\s*$/i
  const lines = body.split('\n')
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) {
      startLine = i
      break
    }
  }
  if (startLine === -1) return null
  // 区段终点：下一个同级或更高级 heading，或 EOF
  let endLine = lines.length
  for (let j = startLine + 1; j < lines.length; j++) {
    if (/^#{1,3}\s/.test(lines[j].trim())) {
      endLine = j
      break
    }
  }
  const content = lines.slice(startLine + 1, endLine).join('\n')
  const start = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0)
  const end = lines.slice(0, endLine).join('\n').length + (endLine < lines.length ? 1 : 0)
  return { start, end, content }
}

/** 从条目文本提取 DOI / PMID（含常见 doi:/DOI:/https://doi.org/ 变体）。 */
export function extractEntryIdentifiers(entry: string): { doi?: string; pmid?: string } {
  const doiM = /(?:doi[:\s]*|https?:\/\/doi\.org\/)(10\.\d{4,9}\/\S+)/i.exec(entry)
  const pmidM = /(?:pmid[:\s]*|pmid[:\s]*)(\d{5,9})/i.exec(entry) || /(?:pubmed[:\s]*)(\d{5,9})/i.exec(entry)
  return {
    doi: doiM ? doiM[1].replace(/[.,;)]+$/, '') : undefined,
    pmid: pmidM ? pmidM[1] : undefined,
  }
}

/** 归一化标题相似度（token 集合 Jaccard，阈值判定用）。 */
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1))
  const A = norm(a)
  const B = norm(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

const defaultLookup: Required<LookupDeps> = {
  resolveByDoi: async (doi) => {
    const rec = await crossrefResolveDoi(doi)
    if (!rec) return null
    return { title: rec.title, authors: rec.authors, journal: rec.journal, year: rec.year, pmid: rec.pmid || undefined, url: rec.url }
  },
  lookupPmid: async (pmid) => {
    const summary = await eutilsJson('esummary.fcgi', { db: 'pubmed', id: pmid, retmode: 'json' })
    const d = (summary as { result?: Record<string, unknown> })?.result?.[pmid]
    if (!d) return null
    const rec = d as { title?: string; authors?: Array<{ name?: string }>; fulljournalname?: string; pubdate?: string; summaryids?: Array<{ idtype: string; value: string }> }
    return {
      title: String(rec.title || '').replace(/\.$/, ''),
      authors: Array.isArray(rec.authors) ? rec.authors.map((a) => String(a.name || '')).filter(Boolean) : [],
      journal: String(rec.fulljournalname || ''),
      year: String(rec.pubdate || '').slice(0, 4),
      doi: Array.isArray(rec.summaryids) ? rec.summaryids.find((x) => x.idtype === 'doi')?.value : undefined,
    }
  },
  searchTitle: async (title) => {
    const items = await crossrefSearchBibliographic(title, 5)
    return items.filter((r) => r.doi).map((r) => ({ title: r.title, doi: r.doi!, authors: r.authors, journal: r.journal, year: r.year, url: r.url }))
  },
}

export interface MigrationResult {
  plan: MigrationPlan
  newBody: string
}

/**
 * 迁移单篇文档（dryRun=true 只出计划）。幂等：已迁移的条目/标记不再处理。
 */
export async function migrateDocCitations(docId: string, opts: { dryRun?: boolean; lookup?: LookupDeps } = {}): Promise<MigrationResult> {
  const lookup = { ...defaultLookup, ...opts.lookup }
  const doc = await prisma.doc.findUnique({ where: { id: docId } })
  if (!doc) throw new Error(`doc not found: ${docId}`)
  const body = String(doc.body || '')

  const plan: MigrationPlan = { docId, resolved: [], pending: [], replacements: 0, removedSection: false, dryRun: !!opts.dryRun }
  const section = locateReferencesSection(body)
  let newBody = body

  if (section) {
    const entries = parseReferencesEntries(section.content)
    const resolvedRows: Array<{ n: number; input: DocCitationInput }> = []

    for (const [n, entryText] of [...entries.entries()].sort((a, b) => a[0] - b[0])) {
      const { doi, pmid } = extractEntryIdentifiers(entryText)
      let hit: { title: string; authors: string[]; journal?: string; year?: string; doi: string; pmid?: string; url?: string } | null = null
      let via: MigrationPlan['resolved'][number]['via'] = 'doi'
      let reason = ''

      if (doi) {
        via = 'doi'
        const rec = await lookup.resolveByDoi(doi)
        if (rec) hit = { ...rec, doi }
        else reason = 'DOI 反查未命中'
      } else if (pmid) {
        via = 'pmid'
        const rec = await lookup.lookupPmid(pmid)
        if (rec?.doi) hit = { ...rec, doi: rec.doi }
        else reason = rec ? 'PMID 反查记录无 DOI' : 'PMID 反查未命中'
      } else {
        via = 'title'
        const cands = await lookup.searchTitle(entryText.slice(0, 300))
        const best = cands
          .map((c) => ({ c, sim: titleSimilarity(entryText, c.title) }))
          .sort((a, b) => b.sim - a.sim)[0]
        if (best && best.sim >= TITLE_SIMILARITY_THRESHOLD) hit = { ...best.c, doi: best.c.doi }
        else reason = best ? `标题相似度不足（${best.sim.toFixed(2)} < ${TITLE_SIMILARITY_THRESHOLD}）` : '标题检索无命中'
      }

      if (hit) {
        resolvedRows.push({
          n,
          input: {
            docId,
            doi: hit.doi,
            pmid: hit.pmid,
            title: hit.title,
            authors: hit.authors,
            journal: hit.journal,
            year: hit.year ? Number(hit.year) || null : null,
            url: hit.url,
            source: pmid && !doi ? 'pubmed' : 'crossref',
          },
        })
        plan.resolved.push({ n, citationId: '', doi: hit.doi, title: hit.title, via })
      } else {
        plan.pending.push({ n, reason, entry: entryText })
      }
    }

    // 落库 + 正文标记替换（dryRun 只记账）
    const numbersForText = new Map<number, string>()
    if (!opts.dryRun) {
      for (const row of resolvedRows) {
        const created = await resolveOrCreateDocCitation(row.input)
        numbersForText.set(row.n, created.id)
      }
    } else {
      for (const row of resolvedRows) {
        // dry-run 用确定性 id 展示（与 citation-store.docCitationId 同规则）
        const { docCitationId } = await import('./citation-store.js')
        numbersForText.set(row.n, docCitationId(docId, row.input.doi))
      }
    }

    // 正文 [n] → [cite:id]（仅替换 References 区**之外**的引用式 [n] —
    // 区内条目前缀不是正文引用；`[12]` 合写引用样式 [4,5] 暂不支持）。
    const byNumber = (n: number) => numbersForText.get(n)
    const replaceNums = (text: string) => text.replace(/(^|[^[\w])\[(\d{1,3})\]/g, (full, pre: string, numStr: string) => {
      const id = byNumber(Number(numStr))
      if (!id) return full
      plan.replacements++
      return `${pre}[cite:${id}]`
    })
    if (section) {
      // 幂等护栏：标记替换不重复（第二次运行时正文已无对应裸 [n] 引用标记）。
      newBody = replaceNums(body.slice(0, section.start)) + body.slice(section.start, section.end) + replaceNums(body.slice(section.end))
    } else {
      newBody = replaceNums(body)
    }

    // References 区处置：全部条目解析成功 → 移除手写区（派生列表接管）；
    // 有待复核 → 区内**只保留待复核条目**（已解析的编号条目删除；上一轮
    // 已打 ⚠ 标记的行原样保留 — 数据零丢失，重复执行幂等）。
    const lines = newBody.split('\n')
    const headingRe = /^\s*#{1,3}\s*(?:\*\*)?(?:references|参考文献)(?:\*\*)?\s*$/i
    const startLine = lines.findIndex((l) => headingRe.test(l.trim()))
    if (startLine !== -1) {
      let endLine = lines.length
      for (let j = startLine + 1; j < lines.length; j++) {
        if (/^#{1,3}\s/.test(lines[j].trim())) { endLine = j; break }
      }
      if (plan.pending.length === 0) {
        plan.removedSection = true
        lines.splice(startLine, endLine - startLine)
        newBody = lines.join('\n').replace(/\n{3,}$/, '\n\n')
      } else {
        const kept: string[] = []
        for (const line of lines.slice(startLine + 1, endLine)) {
          const m = /^\s*\[?(\d{1,3})\]?\s+/.exec(line)
          const n = m ? Number(m[1]) : null
          if (n !== null && numbersForText.has(n)) continue // 已解析条目 → 移除
          if (n !== null && plan.pending.some((p) => p.n === n)) {
            kept.push(line.startsWith('⚠ 待复核') ? line : `⚠ 待复核：${line.trim()}`)
            continue
          }
          kept.push(line) // 已标记/空行/无法归属行原样保留
        }
        lines.splice(startLine + 1, endLine - startLine - 1, ...kept)
        newBody = lines.join('\n')
      }
    }
  }

  return { plan, newBody }
}

/** 应用迁移（非 dry-run）：落 DocCitation + 写回正文。 */
export async function applyDocCitationMigration(docId: string, opts: { lookup?: LookupDeps } = {}): Promise<MigrationPlan> {
  const { plan, newBody } = await migrateDocCitations(docId, { lookup: opts.lookup })
  if (newBody !== null) {
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    if (doc && String(doc.body || '') !== newBody) {
      await prisma.doc.update({ where: { id: docId }, data: { body: newBody, updatedAt: new Date().toISOString() } })
    }
  }
  return plan
}

/** CITE_SHORTCODE_PATTERN 已有 [cite:] 标记检测（迁移幂等前置检查用）。 */
export function bodyHasCiteShortcodes(body: string): boolean {
  CITE_SHORTCODE_PATTERN.lastIndex = 0
  return CITE_SHORTCODE_PATTERN.test(body)
}
