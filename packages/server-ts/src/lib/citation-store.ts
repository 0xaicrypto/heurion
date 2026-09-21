/**
 * #1083/#1084（epic）— 正式参考文献（DocCitation）的唯一读写入口。
 *
 * 语义（epic 目标）：
 *   - 正式引用必须带 DOI（contracts isValidDoi 强校验，写入路径双锁）；
 *   - 同一 doc 内同一 DOI 幂等（唯一约束 [docId, doi] + 冲突读回）；
 *   - 序号不落库 — 渲染/导出按正文 [cite:id] 首现顺序动态计算；
 *   - 参考材料池（DocReference/ReferenceItem）永远进不了本表 — 本模块
 *     只接受结构化 CitationRecord 输入（检索来源 pubmed/crossref）。
 */
import { createHash } from 'crypto'
import prisma from '../common/prisma.js'
import { isValidDoi, resolveCitationShortcodes } from '@heurion/contracts'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('citations')

export type DocCitationSource = 'pubmed' | 'crossref'

export interface DocCitationInput {
  docId: string
  doi: string
  pmid?: string | null
  title: string
  authors: string[]
  journal?: string | null
  year?: number | null
  url?: string | null
  source: DocCitationSource
}

export interface DocCitationRow {
  id: string
  docId: string
  doi: string
  pmid: string | null
  title: string
  authors: string
  journal: string | null
  year: number | null
  url: string | null
  source: string
  createdAt: string
  updatedAt: string
}

function sha16(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

/** 确定性 ID（docId+doi 哈希）— 重复插入天然幂等。 */
export function docCitationId(docId: string, doi: string): string {
  return `cite_${sha16(`${docId}|${doi.trim().toLowerCase()}`)}`
}

/**
 * 新增/复用 DocCitation（DOI 必填强校验 + 唯一冲突读回，幂等）。
 * doi 非法（无 `10.` 前缀等）直接抛错 — 调用方（insert_citation 工具、
 * 迁移脚本）不得绕过。
 */
export async function resolveOrCreateDocCitation(input: DocCitationInput): Promise<DocCitationRow> {
  const doi = String(input.doi || '').trim()
  if (!doi || !isValidDoi(doi)) {
    throw new Error(`invalid doi: "${input.doi}" — 正式引用必须携带合法 DOI（^10\\.\\d{4,9}/\\S+$）`)
  }
  const id = docCitationId(input.docId, doi)
  const existing = (await prisma.docCitation.findUnique({ where: { id } })) as DocCitationRow | null
  if (existing) return existing
  const now = new Date().toISOString()
  const data = {
    id,
    docId: input.docId,
    doi,
    pmid: input.pmid?.trim() || null,
    title: input.title,
    authors: JSON.stringify(input.authors ?? []),
    journal: input.journal?.trim() || null,
    year: input.year ?? null,
    url: input.url?.trim() || null,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  }
  try {
    return (await prisma.docCitation.create({ data })) as DocCitationRow
  } catch (err) {
    // 唯一约束冲突（并发/重复）— 读回已有行（幂等语义，issue #1083 用例 3）；
    // 其他错误（FK 违反等）原样抛出，不得吞成误导性的 "invalid doi"。
    const code = (err as { code?: string })?.code
    if (code === 'P2002') {
      const row = (await prisma.docCitation.findUnique({ where: { id } })) as DocCitationRow | null
      if (row) return row
    }
    throw err
  }
}

export async function listDocCitations(docId: string): Promise<DocCitationRow[]> {
  return (await prisma.docCitation.findMany({ where: { docId }, orderBy: { createdAt: 'asc' } })) as DocCitationRow[]
}

export async function getDocCitation(docId: string, citationId: string): Promise<DocCitationRow | null> {
  return (await prisma.docCitation.findFirst({ where: { id: citationId, docId } })) as DocCitationRow | null
}

export async function deleteDocCitation(docId: string, citationId: string): Promise<boolean> {
  const row = await prisma.docCitation.findFirst({ where: { id: citationId, docId } })
  if (!row) return false
  await prisma.docCitation.delete({ where: { id: citationId } })
  return true
}

/** 正文里出现的 [cite:id] 集合中，哪些找不到 DocCitation 记录（悬挂引用，#1081）。 */
export async function findDanglingCitationIds(docId: string, body: string): Promise<string[]> {
  const { assignCitationNumbers } = await import('@heurion/contracts')
  const ids = [...assignCitationNumbers(body).keys()]
  if (ids.length === 0) return []
  const rows = await prisma.docCitation.findMany({ where: { docId, id: { in: ids } } })
  const known = new Set(rows.map((r) => r.id))
  return ids.filter((id) => !known.has(id))
}

/** 序列化为 API 形状（authors 反序列化为数组）。 */
export function serializeDocCitation(row: DocCitationRow) {
  let authors: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.authors || '[]')
    if (Array.isArray(parsed)) authors = parsed.map(String)
  } catch {
    // 容错：坏 JSON 视为空作者列表
  }
  return {
    id: row.id,
    docId: row.docId,
    doi: row.doi,
    pmid: row.pmid,
    title: row.title,
    authors,
    journal: row.journal,
    year: row.year,
    url: row.url,
    source: row.source,
    createdAt: row.createdAt,
  }
}

/* ── #1078: 导出边界自动生成 References 列表 ──────────────────────── */

/** #1078: buildReferencesSection 的入参形状（serializeDocCitation 输出的子集）。 */
export interface CitationReferenceEntry {
  id: string
  authors: string[]
  title: string
  journal?: string | null
  year?: number | null
  doi: string
}

/**
 * #1078: 把已序列化的 DocCitation 行组装成 `## References` markdown 段 —
 * 编号以调用方传入的 contracts.assignCitationNumbers 结果为准（正文
 * [cite:id] 首现顺序的单一实现，与正文 [n] 编号严格一致）；未被正文
 * 引用的行（无编号）不出现。每条格式：`N. Authors. Title. Journal. Year. doi: X`；
 * 作者 >3 人按仓库 AMA 约定取前三 + et al.。
 * 纯函数、零 I/O — 与 stripLegacyReferencesSection（asset-content）配套单测。
 */
export function buildReferencesSection(
  citations: ReadonlyArray<CitationReferenceEntry>,
  numbers: ReadonlyMap<string, number>,
): string {
  const cited = citations
    .filter((c) => numbers.has(c.id))
    .sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0))
  if (cited.length === 0) return ''
  const lines = cited.map((c) => {
    const authors = c.authors ?? []
    const authorText = authors.length === 0
      ? ''
      : authors.length <= 3
        ? `${authors.join(', ')}.`
        : `${authors.slice(0, 3).join(', ')}, et al.`
    const head = [
      authorText,
      c.title ? `${c.title}.` : '',
      c.journal ? `${c.journal}.` : '',
      c.year ? `${c.year}.` : '',
    ].filter(Boolean).join(' ')
    return `${numbers.get(c.id)}. ${head} doi: ${c.doi}`
  })
  return `## References\n\n${lines.join('\n')}`
}

/* ── #1099: 导出边界的引用 shortcode 解析 ────────────────────────── */

async function citationIdSet(docId: string): Promise<Set<string>> {
  const rows = await prisma.docCitation.findMany({ where: { docId }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

function warnDangling(docId: string, dangling: string[]): void {
  if (dangling.length === 0) return
  log.warn('[export] dangling citations — 正文引用 shortcode 找不到 DocCitation 记录，导出为 [?] 占位', {
    docId,
    dangling,
  })
}

/**
 * #1099: 把 markdown 正文中的 `[cite:id]` 解析为 `[n]` 编号（编号与 web
 * 在线渲染 #1077、References 列表 #1079 共用 contracts 同一算法）。
 * 悬挂引用 → `[?]` 占位（不静默丢弃、不原样保留内部 ID）+ warn 日志。
 * 文档无任何 shortcode 时零开销直通。
 */
export async function resolveBodyCitations(docId: string, text: string): Promise<string> {
  if (!text.includes('[cite:')) return text
  const known = await citationIdSet(docId)
  const { text: resolved, dangling } = resolveCitationShortcodes(text, known)
  warnDangling(docId, dangling)
  return resolved
}

/**
 * #1099: deck 导出（organize 路径 Doc.deck / AI 直供 slides）— 逐页解析
 * title 与 paragraph/bullet 文本中的 shortcode。就地修改传入对象并返回。
 */
export async function resolveDeckContentCitations(docId: string, slides: Array<Record<string, any>>): Promise<Array<Record<string, any>>> {
  if (!slides.some((s) => JSON.stringify(s ?? {}).includes('[cite:'))) return slides
  const known = await citationIdSet(docId)
  for (const slide of slides) {
    if (typeof slide?.title === 'string') {
      const { text, dangling } = resolveCitationShortcodes(slide.title, known)
      slide.title = text
      warnDangling(docId, dangling)
    }
    if (Array.isArray(slide?.bullets)) {
      slide.bullets = slide.bullets.map((b) =>
        typeof b === 'string' && b.includes('[cite:')
          ? resolveCitationShortcodes(b, known).text
          : b,
      )
    }
    if (Array.isArray(slide?.content)) {
      for (const block of slide.content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'paragraph' && typeof (block as { text?: unknown }).text === 'string' && (block as { text: string }).text.includes('[cite:')) {
          const { text, dangling } = resolveCitationShortcodes((block as { text: string }).text, known)
          ;(block as { text: string }).text = text
          warnDangling(docId, dangling)
        }
      }
    }
  }
  return slides
}
