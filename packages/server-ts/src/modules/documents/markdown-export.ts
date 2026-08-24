/**
 * Markdown → docx/pdf export for documents (#fix: export 曾只支持 docx、
 * 表格/图片以原始 markdown 文本导出 — 现支持 docx+pdf 双格式,表格结构化,
 * 内嵌图(document 托管的 /api/v1/files/download 图片)嵌入导出文件)。
 *
 * Shared block parser feeds two renderers: docx (via `docx` lib) and pdf
 * (via pdfkit). Inline markdown (bold/italic/code) is handled by both;
 * images are read from the uploads dir and embedded (webp/gif/bmp 经 sharp
 * 转 png 后嵌入 — docx/pdfkit 不支持 webp)。
 */
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table as DocxTable, TableRow as DocxTableRow, TableCell as DocxTableCell, WidthType, ImageRun } from 'docx'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

export type ExportBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'blank' }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }

export type ExportFormat = 'docx' | 'pdf'

export function isExportFormat(v: string | undefined): v is ExportFormat {
  return v === 'docx' || v === 'pdf'
}

// ── Block parser ─────────────────────────────────────────────────────────

export function parseMarkdownBlocks(body: string): ExportBlock[] {
  const blocks: ExportBlock[] = []
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push({ kind: 'code', lines: codeLines })
      continue
    }

    // Markdown table (| a | b | …)
    if (line.trimStart().startsWith('|') && line.includes('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      const parsed = parseTableBlock(tableLines)
      if (parsed) {
        blocks.push(parsed)
      } else {
        blocks.push({ kind: 'paragraph', text: tableLines.join('\n') })
      }
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ kind: 'heading', level: headingMatch[1].length, text: headingMatch[2] })
      i++
      continue
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ''))
        i++
      }
      blocks.push({ kind: 'bullet', items })
      continue
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s/, ''))
        i++
      }
      blocks.push({ kind: 'ordered', items })
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    // Image: ![alt](/api/v1/files/download/<fileId>?token=…)
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/)
    if (imageMatch) {
      blocks.push({ kind: 'image', url: imageMatch[2], alt: imageMatch[1] })
      i++
      continue
    }

    if (!line.trim()) {
      blocks.push({ kind: 'blank' })
      i++
      continue
    }

    blocks.push({ kind: 'paragraph', text: line })
    i++
  }
  return blocks
}

function parseTableBlock(lines: string[]): ExportBlock | null {
  const cells = (l: string) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  if (lines.length < 2) return null
  const header = cells(lines[0])
  // Separator row: every cell is dashes (+ optional colons)
  const sep = cells(lines[1])
  if (!sep.every((c) => /^:?-{2,}:?$/.test(c))) return null
  const rows = lines.slice(2).map(cells)
  return { kind: 'table', headers: header, rows }
}

// ── Inline markdown → docx runs ──────────────────────────────────────────

export function parseInlineMarkdown(text: string): any[] {
  const runs: any[] = []
  let remaining = text
  // Bold **text** or __text__
  const boldRegex = /\*\*(.+?)\*\*|__(.+?)__/g
  // Italic *text* or _text_
  const italicRegex = /\*(.+?)\*|_(.+?)_/g
  // Inline code `text`
  const codeRegex = /`([^`]+)`/g

  type Token = { type: 'bold' | 'italic' | 'code'; text: string; start: number; end: number }
  const tokens: Token[] = []

  for (const match of remaining.matchAll(boldRegex)) {
    tokens.push({ type: 'bold', text: match[1] || match[2], start: match.index!, end: match.index! + match[0].length })
  }
  for (const match of remaining.matchAll(codeRegex)) {
    tokens.push({ type: 'code', text: match[1], start: match.index!, end: match.index! + match[0].length })
  }
  for (const match of remaining.matchAll(italicRegex)) {
    if (!tokens.some(t => t.start <= match.index! && t.end >= match.index! + match[0].length)) {
      tokens.push({ type: 'italic', text: match[1] || match[2], start: match.index!, end: match.index! + match[0].length })
    }
  }

  if (tokens.length === 0) return [new TextRun(remaining)]

  tokens.sort((a, b) => a.start - b.start)
  let pos = 0
  for (const tok of tokens) {
    if (pos < tok.start) runs.push(new TextRun(remaining.slice(pos, tok.start)))
    const opts: any = {}
    if (tok.type === 'bold') opts.bold = true
    if (tok.type === 'italic') opts.italics = true
    if (tok.type === 'code') opts.font = 'Consolas'
    runs.push(new TextRun({ text: tok.text, ...opts }))
    pos = tok.end
  }
  if (pos < remaining.length) runs.push(new TextRun(remaining.slice(pos)))

  return runs.length > 0 ? runs : [new TextRun(remaining)]
}

// ── docx renderer ────────────────────────────────────────────────────────

interface ExportImage {
  buffer: Buffer
  type: 'png' | 'jpg' | 'gif' | 'bmp'
  width: number
  height: number
}

/**
 * #fix: 把文档内的托管图片 URL(/api/v1/files/download/<fileId>)解析为
 * 嵌入导出的位图。只接受本用户 uploads 目录内的文件(safeUploadPath
 * 防穿越);webp/未知格式经 sharp 转 png(docx/pdfkit 不支持 webp);
 * 尺寸读 metadata,长边限 1600px(docx 96dpi 下约 16.7 英寸)。
 */
export async function loadExportImage(userId: string, url: string): Promise<ExportImage | null> {
  try {
    const parsed = new URL(url, 'http://local')
    const m = parsed.pathname.match(/^\/api\/v1\/files\/download\/([^/]+)$/)
    if (!m) return null
    const fileId = decodeURIComponent(m[1])
    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) return null

    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads', fileId)
    if (!fs.existsSync(filepath)) return null

    let buffer = fs.readFileSync(filepath)
    const ext = fileId.split('.').pop()?.toLowerCase() || ''
    let type: ExportImage['type']
    if (ext === 'png') type = 'png'
    else if (ext === 'jpg' || ext === 'jpeg') type = 'jpg'
    else if (ext === 'gif') type = 'gif'
    else if (ext === 'bmp') type = 'bmp'
    else {
      buffer = await sharp(buffer).png().toBuffer()
      type = 'png'
    }

    const meta = await sharp(buffer).metadata()
    const srcW = meta.width || 300
    const srcH = meta.height || 300
    const scale = Math.min(1, 1600 / Math.max(srcW, srcH))
    return { buffer, type, width: Math.round(srcW * scale), height: Math.round(srcH * scale) }
  } catch {
    return null
  }
}

export async function renderDocxBuffer(title: string, body: string, userId?: string): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(body)
  const children: any[] = []

  // Title
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({ text: title, bold: true, size: 32 })],
    heading: HeadingLevel.TITLE,
  }))

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = block.level
        children.push(new Paragraph({
          spacing: { before: 240, after: 120 },
          children: parseInlineMarkdown(block.text),
          heading: (['', HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3] as any)[level] || HeadingLevel.HEADING_1,
        }))
        break
      }
      case 'bullet':
        for (const item of block.items) {
          children.push(new Paragraph({
            spacing: { before: 40, after: 40 },
            bullet: { level: 0 },
            indent: { left: 400 },
            children: parseInlineMarkdown(item),
          }))
        }
        break
      case 'ordered': {
        let num = 1
        for (const item of block.items) {
          children.push(new Paragraph({
            spacing: { before: 40, after: 40 },
            numbering: { reference: 'ordered', level: 0 },
            indent: { left: 400 },
            children: [new TextRun({ text: `${num}. ` }), ...parseInlineMarkdown(item)],
          }))
          num++
        }
        break
      }
      case 'code':
        children.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          border: { left: { style: 'single', size: 4, color: 'CCCCCC' } },
          indent: { left: 400 },
          children: [new TextRun({ text: block.lines.join('\n'), font: 'Consolas', size: 18 })],
        }))
        break
      case 'hr':
        children.push(new Paragraph({
          spacing: { before: 200, after: 200 },
          border: { bottom: { style: 'single', size: 6, color: 'CCCCCC' } },
          children: [],
        }))
        break
      case 'blank':
        children.push(new Paragraph({ spacing: { before: 60 }, children: [] }))
        break
      case 'image': {
        const img = userId ? await loadExportImage(userId, block.url) : null
        if (img) {
          children.push(new Paragraph({
            alignment: 'center',
            spacing: { before: 120, after: 120 },
            children: [new ImageRun({ type: img.type, data: img.buffer, transformation: { width: img.width, height: img.height } })],
          }))
        } else {
          children.push(new Paragraph({
            alignment: 'center',
            spacing: { before: 120, after: 120 },
            children: [new TextRun({ text: block.alt || '[图片]', italics: true, color: '888888' })],
          }))
        }
        break
      }
      case 'table': {
        const row = (cells: string[], isHeader: boolean) => new DocxTableRow({
          tableHeader: isHeader,
          children: cells.map((c) => new DocxTableCell({
            shading: isHeader ? { fill: 'EEEEEE' } : undefined,
            children: [new Paragraph({ children: parseInlineMarkdown(c || '') })],
          })),
        })
        children.push(new DocxTable({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            row(block.headers, true),
            ...block.rows.map((r) => row(r, false)),
          ],
        }))
        children.push(new Paragraph({ spacing: { before: 60 }, children: [] }))
        break
      }
      case 'paragraph':
        children.push(new Paragraph({
          spacing: { before: 60, after: 60 },
          children: parseInlineMarkdown(block.text),
        }))
        break
    }
  }

  const docx = new Document({
    sections: [{ properties: {}, children }],
  })
  return Packer.toBuffer(docx)
}

// ── pdf renderer ─────────────────────────────────────────────────────────

// CJK-capable single .ttf/.otf font if the host provides one. NOTE: .ttc
// collections (PingFang.ttc / NotoSansCJK-Regular.ttc) are NOT supported by
// pdfkit (EmbeddedFont.createSubset fails) — only single-font files work.
// Helvetica fallback renders latin fine but CJK as blank boxes.
const CJK_FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf',
  'C:/Windows/Fonts/msyh.ttf',
]

function resolveCjkFont(): string | null {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* keep probing */ }
  }
  return null
}

interface InlineSegment { text: string; bold?: boolean; italics?: boolean; code?: boolean }

function splitInlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const regex = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g
  let pos = 0
  for (const m of text.matchAll(regex)) {
    if (m.index! > pos) segments.push({ text: text.slice(pos, m.index!) })
    const tok = m[0]
    if (tok.startsWith('`')) segments.push({ text: tok.slice(1, -1), code: true })
    else if (tok.startsWith('**') || tok.startsWith('__')) segments.push({ text: tok.slice(2, -2), bold: true })
    else segments.push({ text: tok.slice(1, -1), italics: true })
    pos = m.index! + tok.length
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) })
  return segments.length > 0 ? segments : [{ text }]
}

/** Strips markdown links/images to their display text: [t](u) → t. */
function stripLinks(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
}

export async function renderPdfBuffer(title: string, body: string, userId?: string): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(body)
  const buffers: Buffer[] = []
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true })
  const cjkFont = resolveCjkFont()
  if (cjkFont) {
    doc.registerFont('cjk', cjkFont)
  } else {
    console.warn('[doc-export] no CJK font found on host — PDF CJK text will render as blank boxes')
  }

  doc.on('data', (chunk: Buffer) => buffers.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)
  })

  const baseFont = cjkFont ? 'cjk' : 'Helvetica'
  const fontFor = (seg: InlineSegment) => {
    if (seg.code) return 'Courier'
    if (cjkFont) return baseFont // custom CJK font has no bold/oblique variants
    if (seg.bold && seg.italics) return 'Helvetica-BoldOblique'
    if (seg.bold) return 'Helvetica-Bold'
    if (seg.italics) return 'Helvetica-Oblique'
    return baseFont
  }
  const writeInline = (text: string, opts: { size?: number; align?: 'left' | 'center'; underline?: boolean } = {}) => {
    const segments = splitInlineSegments(stripLinks(text))
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx]
      doc.font(fontFor(seg)).fontSize(opts.size ?? 12)
      doc.text(seg.text, {
        underline: opts.underline,
        continued: idx < segments.length - 1,
        align: opts.align ?? 'left',
      })
    }
    if (segments.length > 0 && !doc.x) doc.moveDown(0.2)
  }

  if (title) {
    doc.font(baseFont).fontSize(20).text(title, { align: 'center' })
    doc.moveDown(1.5)
  }

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const sizes = [18, 16, 14, 13, 12, 12]
        doc.moveDown(0.6)
        writeInline(block.text, { size: sizes[block.level - 1] ?? 12 })
        doc.moveDown(0.4)
        break
      }
      case 'bullet':
        for (const item of block.items) {
          writeInline(`•  ${item}`)
          doc.moveDown(0.15)
        }
        doc.moveDown(0.3)
        break
      case 'ordered': {
        let num = 1
        for (const item of block.items) {
          writeInline(`${num}.  ${item}`)
          doc.moveDown(0.15)
          num++
        }
        doc.moveDown(0.3)
        break
      }
      case 'code': {
        doc.font(baseFont).fontSize(10)
        doc.rect(50, doc.y, doc.page.width - 100, 0.01).fillOpacity(0).stroke()
        for (const line of block.lines) {
          doc.text(line, 56, undefined, { width: doc.page.width - 112 })
        }
        doc.moveDown(0.4)
        break
      }
      case 'hr': {
        const y = doc.y + 6
        doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#CCCCCC').stroke()
        doc.moveDown(0.8)
        break
      }
      case 'blank':
        doc.moveDown(0.4)
        break
      case 'image': {
        const img = userId ? await loadExportImage(userId, block.url) : null
        if (img) {
          try {
            doc.image(img.buffer, {
              fit: [doc.page.width - 100, doc.page.height - 160],
              align: 'center',
            })
            doc.moveDown(0.3)
          } catch {
            writeInline(block.alt || '[图片]')
            doc.moveDown(0.3)
          }
        } else {
          writeInline(block.alt || '[图片]')
          doc.moveDown(0.3)
        }
        break
      }
      case 'table': {
        renderPdfTable(doc, baseFont, block.headers, block.rows)
        break
      }
      case 'paragraph':
        writeInline(block.text)
        doc.moveDown(0.3)
        break
    }
  }

  doc.end()
  return done
}

function renderPdfTable(doc: PDFKit.PDFDocument, baseFont: string, headers: string[], rows: string[][]) {
  const pageWidth = doc.page.width - 100
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1)
  const colW = pageWidth / colCount
  const margin = 50
  let y = doc.y + 4

  const headerFont = baseFont === 'Helvetica' ? 'Helvetica-Bold' : baseFont

  const drawRow = (cells: string[], isHeader: boolean) => {
    const pad = 4
    const heights = cells.map((c, i) =>
      doc.font(baseFont).fontSize(isHeader ? 11 : 10)
        .heightOfString(c || '', { width: colW - pad * 2 }),
    )
    const rowH = Math.max(...heights, 16) + pad * 2 + 4
    if (y + rowH > doc.page.height - 60) {
      doc.addPage()
      y = 50
    }
    for (let i = 0; i < colCount; i++) {
      const text = cells[i] ?? ''
      doc.font(isHeader ? headerFont : baseFont).fontSize(isHeader ? 11 : 10)
      doc.text(text, margin + i * colW + pad, y + pad, {
        width: colW - pad * 2,
        height: rowH - pad,
        ellipsis: true,
      })
    }
    doc.moveTo(margin, y).lineTo(margin + pageWidth, y).strokeColor('#999999').stroke()
    y += rowH
  }

  drawRow(headers, true)
  for (const row of rows) drawRow(row, false)
  doc.moveTo(margin, y).lineTo(margin + pageWidth, y).strokeColor('#999999').stroke()
  doc.y = y + 10
}
