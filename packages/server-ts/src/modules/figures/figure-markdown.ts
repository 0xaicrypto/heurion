/**
 * #821 — markdown 学术图抽取与解析(管线 A markdown-export / 管线 B
 * asset-embed 共用)。
 *
 * 扫描:```mermaid 围栏、`$$..$$`(单行/多行)、独立成行的 `$..$`。
 * 解析:ensureFigure(15s 预算,FigureRender 缓存)→ 成功则把源码行
 * 原位替换为托管图片行 `![学术图](/api/v1/files/download/fig_...)` —
 * 管线 A 的 image 块(loadExportImage 内 sharp SVG→PNG)与管线 B 的
 * embedContentImages(SVG density150→PNG base64)均按既有图片路径消费,
 * 双管线零新增渲染逻辑;失败/超时保留原行(管线 A 降级 code block,
 * 管线 B 降级文本),不阻塞导出。
 *
 * 段内行内公式(同一行混排文字+$..$)不抽取 — 误抽风险(金额/变量),
 * 留给 #824 的 docx 原生公式评估。
 */
import type { FigureInput } from './figure.service.js'

export interface FigureScanResult {
  /** 原文中的学术图输入(按出现顺序,已去重)。 */
  figures: FigureInput[]
  /** figure 槽位数(预热日志用)。 */
  count: number
}

interface FigureSlot {
  startLine: number
  endLine: number
  input: FigureInput
}

const MERMAID_FENCE = /^```mermaid\s*$/i
const DISPLAY_OPEN = /^\$\$\s*$/
const ONE_LINE_DISPLAY = /^\$\$([^$]+)\$\$$/
const ONE_LINE_INLINE = /^\$([^$\n]+)\$$/

/** 行级扫描 — 所有 figure 语义的唯一实现(扫两遍定位行号用)。 */
function scanSlots(lines: string[]): FigureSlot[] {
  const slots: FigureSlot[] = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // ```mermaid 围栏
    if (MERMAID_FENCE.test(trimmed)) {
      const start = i
      const src: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        src.push(lines[i])
        i++
      }
      i++ // closing fence
      const source = src.join('\n')
      if (source.trim()) slots.push({ startLine: start, endLine: i - 1, input: { kind: 'mermaid', source } })
      continue
    }

    // $$ 块级公式(多行)
    if (DISPLAY_OPEN.test(trimmed)) {
      const start = i
      const src: string[] = []
      i++
      while (i < lines.length && !DISPLAY_OPEN.test(lines[i].trim())) {
        src.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // closing $$
      const source = src.join('\n').trim()
      if (source) slots.push({ startLine: start, endLine: i - 1, input: { kind: 'latex_math', source, display: true } })
      continue
    }

    // 单行 $$...$$ 或独立行 $..$(行内公式独占一行才抽,段内混排不抽)
    const oneDisplay = ONE_LINE_DISPLAY.exec(trimmed)
    if (oneDisplay) {
      slots.push({ startLine: i, endLine: i, input: { kind: 'latex_math', source: oneDisplay[1].trim(), display: true } })
      i++
      continue
    }
    const oneInline = ONE_LINE_INLINE.exec(trimmed)
    if (oneInline) {
      slots.push({ startLine: i, endLine: i, input: { kind: 'latex_math', source: oneInline[1].trim(), display: false } })
      i++
      continue
    }

    i++
  }
  return slots
}

const slotKey = (input: FigureInput) => `${input.kind}:${input.source}`

/** 扫描 markdown 中的学术图(纯函数,无 I/O)。 */
export function scanFigures(body: string): FigureScanResult {
  const slots = scanSlots(body.split('\n'))
  const seen = new Set<string>()
  const figures: FigureInput[] = []
  for (const s of slots) {
    const key = slotKey(s.input)
    if (!seen.has(key)) {
      seen.add(key)
      figures.push(s.input)
    }
  }
  return { figures, count: slots.length }
}

/** 源码行 → 托管图片行(fig_ 前缀 URL,保留溯源引用)。 */
function replaceSlot(lines: string[], slot: FigureSlot, fileId: string): void {
  lines[slot.startLine] = `![学术图](/api/v1/files/download/${fileId})`
  for (let k = slot.startLine + 1; k <= slot.endLine; k++) lines[k] = ''
}

/**
 * 把 body 中的学术图解析为托管图片行。ensureFigure 失败的 figure 保留
 * 原行(降级不阻塞);同批次同源码共享一次渲染(缓存键天然去重)。
 */
export async function resolveFiguresToImageLines(
  userId: string,
  body: string,
  ensureFigure: (userId: string, input: FigureInput) => Promise<{ ok: true; file: { fileId: string } } | { ok: false; reason: string }>,
): Promise<string> {
  const lines = body.split('\n')
  const slots = scanSlots(lines)
  if (slots.length === 0) return body

  const fileIdBySource = new Map<string, string>()
  await Promise.all([...new Set(slots.map((s) => slotKey(s.input)))].map(async (key) => {
    const input = slots.find((s) => slotKey(s.input) === key)!.input
    try {
      const result = await ensureFigure(userId, input)
      if (result.ok) fileIdBySource.set(key, result.file.fileId)
    } catch { /* 保留原行降级 */ }
  }))
  if (fileIdBySource.size === 0) return body

  for (const slot of slots) {
    const fileId = fileIdBySource.get(slotKey(slot.input))
    if (fileId) replaceSlot(lines, slot, fileId)
  }
  return lines.join('\n')
}
