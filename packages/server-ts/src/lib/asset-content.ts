/**
 * Asset content builders (#789②) — pure markdown → contract content-model
 * conversion extracted from insert-asset-tool.ts. No prisma, no I/O.
 */
import { SCHEMA_VERSION, CITE_SHORTCODE_PATTERN } from '@heurion/contracts'

/** headers/rows → markdown 表格；单元格转义竖线与换行，短行补空。 */
export function buildMarkdownTable(headers: string[], rows: string[][]): string {
  const esc = (c: unknown) => String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
  const n = headers.length
  const line = (cells: string[]) => `| ${cells.map(esc).join(' | ')} |`
  const out = [line(headers), `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    const cells = Array.from({ length: n }, (_, i) => row[i] ?? '')
    out.push(line(cells))
  }
  return out.join('\n')
}

/**
 * #767 — markdown 草稿 → 契约 document 内容模型（docx/pdf 共用）。
 * `#`/`##`/`###` 起始新 section（heading）；连续正文行逐行成 paragraph
 * （`-`/`*` 前缀 → bullet）。契约上限：30 sections / 100 段落 / 20000 字，
 * 超限折叠进末尾并注明（导出从不因超长静默丢内容之外的失败）。
 */
export function buildDocumentContent(body: string, title: string): { schemaVersion: number; title: string; sections: Array<{ heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> } {
  const sections: Array<{ heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> = []
  let current: { heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> } | null = null
  let docTitle = title
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1].length === 1 && !current && sections.length === 0) {
        docTitle = h[2].slice(0, 500)
        continue
      }
      current = { heading: h[2].slice(0, 500), paragraphs: [] }
      sections.push(current)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const block = bullet
      ? { type: 'paragraph' as const, text: bullet[1].slice(0, 20000), style: 'bullet' as const }
      : { type: 'paragraph' as const, text: line.replace(/^#+\s*/, '').slice(0, 20000) }
    if (!current) {
      current = { heading: '概述', paragraphs: [] }
      sections.push(current)
    }
    if (current.paragraphs.length < 100) current.paragraphs.push(block)
    else if (current.paragraphs.length === 100) current.paragraphs.push({ type: 'paragraph', text: '（内容过长，其余段落已省略）' })
  }
  if (sections.length > 30) sections.length = 30
  // #966 契约要求每节 ≥1 段（documentSectionSchema.paragraphs.min(1)）：空标题节
  // （大纲骨架/文末悬空标题）补注明式占位段（惯例同 :52 超长折叠），结构与内容都不丢；
  // pptx 派生路径（slides content 同样 min(1)）随之满足。
  for (const s of sections) {
    if (s.paragraphs.length === 0) s.paragraphs.push({ type: 'paragraph', text: '（本节暂无内容）' })
  }
  return { schemaVersion: SCHEMA_VERSION, title: docTitle.slice(0, 500), sections }
}

/** #767 — markdown 草稿 → 契约 presentation 内容模型（`##` → slide）。 */
export function buildPresentationContent(body: string, title: string): { schemaVersion: number; title: string; slides: Array<{ title: string; content: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> } {
  const doc = buildDocumentContent(body, title)
  const slides = doc.sections.slice(0, 30).map((s) => ({
    title: s.heading,
    content: s.paragraphs.slice(0, 50),
  }))
  return { schemaVersion: SCHEMA_VERSION, title: doc.title, slides }
}

/**
 * #772 — 正文摘要（标题层级 + 每段首句，有界 ~1200 字）。
 * organize 两段协议第一段用：模型未见正文时第一次调用 organize=true
 * 不带 slides，工具返回摘要引导第二次调用直供 slides。
 */
export function digestBody(body: string): string {
  const out: string[] = []
  let total = 0
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const isHeading = /^#{1,6}\s/.test(line)
    let piece: string
    if (isHeading) {
      piece = line
    } else {
      const m = /^(.*?[。！？.!?]|.{1,60})/s.exec(line)
      piece = `- ${m ? m[1].trim() : line.slice(0, 60)}`
    }
    if (total + piece.length > 1200) {
      out.push('…（正文过长，摘要已截断）')
      break
    }
    out.push(piece)
    total += piece.length
  }
  return out.join('\n')
}

/** #789: deck JSON 容错解析 — 损坏时交 null(清空),由调用方判定语义。 */
export function safeParseDeckJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === undefined) return undefined as unknown as Record<string, unknown>
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * #1078 — 手写/遗留 References 节识别：`## References` / `## 参考文献`
 * / `# References`（大小写不敏感）或 `**References**` 加粗行。
 */
const LEGACY_REFERENCES_HEADING = /^(#{1,6}\s+|)\**\s*(references|参考文献)\s*\**\s*$/i

/** #1078: 复用 contracts 的 shortcode 形状做布尔判定 — 不在共享 /g 正则上
 *  直接 .test()（lastIndex 泄漏进后续 replace 的已知坑）。 */
export function hasCiteShortcode(text: string): boolean {
  return new RegExp(CITE_SHORTCODE_PATTERN.source).test(text)
}

/**
 * #1078: 从 markdown 正文中剥除「References / 参考文献」节 — 命中标题行
 * （`## References`、`# 参考文献`、`**References**` 等）起，到下一个
 * **同级或更高级**标题（heading 级别 ≤ 该标题级别）或文末为止。
 * 纯函数、零 I/O；未命中时原样返回（导出边界对无引用文档零开销直通）。
 */
export function stripLegacyReferencesSection(body: string): string {
  if (!body) return body
  const lines = body.split('\n')
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = LEGACY_REFERENCES_HEADING.exec(lines[i].trim())
    if (m) {
      start = i
      level = /^#{1,6}/.exec(lines[i].trim())?.[0]?.length || 7
      break
    }
  }
  if (start === -1) return body
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s+/.exec(lines[i].trim())
    if (h && h[1].length <= level) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}
