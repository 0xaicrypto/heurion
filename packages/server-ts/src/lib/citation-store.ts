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
import { isValidDoi, resolveCitationShortcodes, assignCitationNumbers } from '@heurion/contracts'
import { makeLogger } from '../common/logger.js'
import { stripLegacyReferencesSection } from './asset-content.js'

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
  const ids = [...assignCitationNumbers(body).keys()]
  if (ids.length === 0) return []
  const rows = await prisma.docCitation.findMany({ where: { docId, id: { in: ids } } })
  const known = new Set(rows.map((r) => r.id))
  return ids.filter((id) => !known.has(id))
}

/**
 * #1081（复审 #8 修复）— 悬挂引用统一诊断入口：正文 + deck 内容合并扫描。
 * citations.router 的 /dangling 端点消费（deck 内悬挂引用在 UI 健康检查
 * 同样可见，不再只等导出时 [?] + warn 暴露）；deck 文本抽取与
 * resolveDeckContentCitations 的消费面同口径（title/bullets/paragraph）。
 */
export function deckCitationText(deckJson: string | null | undefined): string {
  if (!deckJson) return ''
  try {
    const deck = JSON.parse(deckJson) as { slides?: Array<{ title?: string; bullets?: unknown[]; content?: unknown }> }
    const parts: string[] = []
    for (const slide of deck.slides ?? []) {
      if (typeof slide?.title === 'string') parts.push(slide.title)
      if (Array.isArray(slide?.bullets)) for (const b of slide.bullets) if (typeof b === 'string') parts.push(b)
      if (Array.isArray(slide?.content)) {
        for (const block of slide.content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'paragraph' && typeof (block as { text?: unknown }).text === 'string') {
            parts.push((block as { text: string }).text)
          }
        }
      }
    }
    return parts.join('\n')
  } catch {
    return '' // deck 损坏 → 不参与悬挂扫描（导出路径已有降级语义）
  }
}

/**
 * 复审 #3 修复 — deck JSON 内全部文本字段（title/bullets/paragraph.text，
 * 与 deckCitationText 消费面同口径）的悬挂标记移除（字符串语义，零 RegExp）。
 * 返回序列化后的 deck JSON 字符串；deck 损坏时原样返回（导出路径已有降级）。
 */
export function stripDeckCitationMarkers(deckJson: string, citationId: string): string {
  // 与 stripCitationMarkers 同一边界语义（独占一行的标记不留空行）
  const stripText = (t: string) => stripCitationMarkers(t, citationId)
  try {
    const deck = JSON.parse(deckJson) as { slides?: Array<{ title?: string; bullets?: unknown[]; content?: unknown }> }
    for (const slide of deck.slides ?? []) {
      if (typeof slide?.title === 'string') slide.title = stripText(slide.title)
      if (Array.isArray(slide?.bullets)) {
        slide.bullets = slide.bullets.map((b) => (typeof b === 'string' ? stripText(b) : b))
      }
      if (Array.isArray(slide?.content)) {
        for (const block of slide.content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'paragraph' && typeof (block as { text?: unknown }).text === 'string') {
            ;(block as { text: string }).text = stripText((block as { text: string }).text)
          }
        }
      }
    }
    return JSON.stringify(deck)
  } catch {
    return deckJson
  }
}

/**
 * 复审轮 4（P2 修复）— 悬挂标记移除（单一实现，router 与 deck 侧共用）。
 *
 * 边界语义与旧正则 `\s*\[cite:id\]`（吸收任意前置空白**含换行**）逐位等价：
 * - 行中标记：吸收紧邻前置空白（空格/制表符）→ "A [cite:x] B" → "A B"
 * - 独占一行标记：吸收前置换行，不留空行 — "A\n[cite:x]\nB" → "A\nB"
 * - 行首标记（无前置空白）：仅移除标记本身 — "[cite:x] 开头" → " 开头"
 * - 相邻连续标记：逐位吸收各自前置空白 — "A [cite:x][cite:x] B" → "A B"
 * （实现：split 后逐边界 trimEnd 全部空白（含换行）再拼接 — 与全局正则
 * 替换的吸收行为一致；split 语义保持零 RegExp 构造，白名单 id 前提下
 * 正则注入攻击面仍为零。）
 */
export function stripCitationMarkers(text: string, citationId: string): string {
  const marker = `[cite:${citationId}]`
  const parts = text.split(marker)
  if (parts.length === 1) return text
  let out = parts[0]
  for (let i = 1; i < parts.length; i++) {
    // 每个被移除标记的前置空白（含换行）吸收 — 等价旧正则 \s* 前缀
    out = out.replace(/[ \t\n]+$/, '') + parts[i]
  }
  return out
}

/** 悬挂引用完整诊断 — 正文 + deck 文本合并扫描（单一实现，端点直接复用）。 */
export async function findDanglingCitations(docId: string, body: string, deckJson?: string | null): Promise<Array<{ id: string; occurrences: number }>> {
  const combined = deckJson ? `${body}\n${deckCitationText(deckJson)}` : body
  const ids = [...assignCitationNumbers(combined).keys()]
  if (ids.length === 0) return []
  const rows = await prisma.docCitation.findMany({ where: { docId, id: { in: ids } } })
  const known = new Set(rows.map((r) => r.id))
  return ids
    .filter((id) => !known.has(id))
    .map((id) => ({ id, occurrences: combined.split(`[cite:${id}]`).length - 1 }))
}

/**
 * #1078（复审 #1 修复）— 导出正文合成：单一可测入口。
 *
 * 顺序关键不变量（此前 insert-asset-export 内联实现把 hasCiteShortcode 判定
 * 放在 resolveBodyCitations **之后**，body 已被改写为 [n]/[?]，条件恒 false —
 * References 列表永远不会追加）：
 *   1. 先在【解析前原文】上算编号（与正文首现顺序一致）并捕获 hasMarkers；
 *   2. 再解析 shortcode（[n]/[?] 占位）；
 *   3. 有标记时：strip 遗留手写 References 区 + 追加 store 生成的列表
 *      （无标记的存量文档原样直通 — 不剥遗留内容）。
 */
export async function composeExportBody(docId: string, body: string): Promise<string> {
  const citationNumbers = assignCitationNumbers(body)
  const resolved = await resolveBodyCitations(docId, body)
  if (citationNumbers.size === 0) return resolved
  const citations = await listDocCitations(docId)
  const references = buildReferencesSection(citations.map(serializeDocCitation), citationNumbers)
  if (!references) return resolved
  return `${stripLegacyReferencesSection(resolved).replace(/\s+$/, '')}\n\n${references}\n`
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
      // #1090 复审 #10 修复: bullets 分支此前漏调 warnDangling（title/content
      // 分支都有）— deck 内容占比最大的 bullets 场景悬挂告警观测性补齐。
      slide.bullets = slide.bullets.map((b) => {
        if (typeof b !== 'string' || !b.includes('[cite:')) return b
        const { text, dangling } = resolveCitationShortcodes(b, known)
        warnDangling(docId, dangling)
        return text
      })
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
