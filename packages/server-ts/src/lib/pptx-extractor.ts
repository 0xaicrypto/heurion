import { readZipEntries, ZipReadError } from './zip-reader.js'
import { safeUploadPath } from './upload-path.js'
import type { ExtractedPdfImage } from './document-extractor.js'

/**
 * #777 — pptx 解析导入：pptx（zip + OOXML）→ slides 结构 + 内嵌图。
 *
 * 与 export 互为镜像（epic #775 三轮走查）：`ppt/slides/slideN.xml` 按页
 * 提取占位符文本（`<a:t>` 文本串）→ `{ slides: [{ title, paragraphs }] }`
 * 天然对齐 presentationContentSchema（deck 落点），同时渲染 markdown
 * （`## 页标题` + 正文，文档落点）。
 *
 * 安全（不可信 XML/zip，五轮走查）：
 *   - zip 炸弹：zip-reader 条目数/解压总量上限；
 *   - XXE：不使用任何 XML 解析器 — 文本提取为正则收集 `<a:t>` 内容 +
 *     基本实体解码，不存在外部实体解析路径；
 *   - 加密 zip：zip-reader 抛可读错误。
 *
 * 解析边界（绝不静默丢内容）：表格（`<a:tbl>`，#1047）解析为结构化行列
 * 数据（合并单元格降级为重复文本；行列/尺寸超出导出 schema 时截断并标记
 * truncatedDegraded，#1062-1/#1062-7）；图表（chart part，#1048）解析常见
 * 类型（barChart/lineChart/pieChart）为结构化 chart 块，标签/数值按
 * `<c:pt idx>` 对齐（#1059，弃下标位置假设），不支持的类型降级占位并记录
 * 类型名；SmartArt（`<dgm:`，#1052）解析 PowerPoint 兼容用的降级绘图
 * （dsp:drawing，经 dataModelExt relId 与 frame 权威配对，#1062-4）提取
 * 形状文字为列表，降级绘图缺失才占位。speaker notes 按该页 rels 的
 * notesSlide 关系定位（#1062-2，弃页序假设），关系缺失才按页序兜底。
 * 页序优先 presentation.xml 的 sldIdLst（权威顺序），缺失/损坏时按文件名
 * 自然排序兜底。
 */

export interface PptxSlide {
  title: string
  paragraphs: string[]
  /** speaker notes（可选提取，演示场景有价值）。 */
  notes?: string
  /** #1047: 解析出的表格（合并单元格降级为重复文本，mergedDegraded 标记）。 */
  tables?: PptxTable[]
  /** #1048: 解析出的图表（对齐 contracts chartBlockSchema 的 spec 形状）。 */
  charts?: PptxChart[]
}

export interface PptxTable {
  /** 逻辑网格（合并单元格已按重复文本展开，无空白格）。 */
  rows: string[][]
  /** 源表格含合并单元格（gridSpan/rowSpan/hMerge/vMerge）— 降级处理。 */
  mergedDegraded?: boolean
  /** #1062-1/#1062-7: 行列/尺寸超出导出 schema（tableBlockSchema）被截断 — 降级标记。 */
  truncatedDegraded?: boolean
}

export interface PptxChart {
  /** OOXML 原生图表类型名（barChart/lineChart/pieChart/...），降级提示用。 */
  ooxmlType: string
  /**
   * 结构化图表 spec（对齐 contracts chartBlockSchema：chart_type + data）。
   * 不支持/未能提取数据的类型为 null（调用方降级占位）。
   * #1048 决策：饼图在现有渲染管道（#176，chart_type 枚举 line|bar|dose_curve）
   * 无原生饼图渲染 — 映射为 bar 保留全部数据（类别+数值），caption 记录原类型。
   */
  spec?: { chart_type: 'bar' | 'line'; data: Array<{ label: string; value: number }>; title?: string }
  /** 降级说明（pie→bar / 多系列只保留第 1 个等），不静默。 */
  caption?: string
}

export interface PptxParseResult {
  ok: boolean
  /** 解析失败时的可读原因（损坏/加密/空结构）。 */
  error?: string
  slides: PptxSlide[]
  images: ExtractedPdfImage[]
}

export const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** 上限（五轮走查约束：≤100 页；图片沿用 PDF 提取限额口径）。 */
const MAX_SLIDES = 100
const MAX_MEDIA_FILES = 24
const MAX_MEDIA_FILE_BYTES = 4 * 1024 * 1024
const MAX_SLIDE_TEXT_CHARS = 20000

/** #1062-1: 表格 data 导出上限（contracts tableBlockSchema data max 256KB）—
 * 导入侧按导出 schema 预自检，避免"导入成功、导出永远报验证错"的延迟爆炸。 */
const TABLE_DATA_EXPORT_LIMIT = 256 * 1024

export function isPptx(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.pptx') || mimeType === PPTX_MIME_TYPE
}

/** XML 文本节点实体解码（最小集 — `<a:t>` 内出现的是 XML 预定义实体）。 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

/** 一个 shape（`<p:sp>`）内的段落列表：按 `<a:p>` 分段、段内拼接 `<a:t>`。 */
function paragraphsFromShape(spXml: string): string[] {
  const paragraphs: string[] = []
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(spXml)) !== null) {
    const runs: string[] = []
    const runRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
    let r: RegExpExecArray | null
    while ((r = runRe.exec(m[1])) !== null) runs.push(decodeXmlEntities(r[1]))
    const text = runs.join('').replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs
}

function isTitleShape(spXml: string): boolean {
  return /<p:ph[^>]*\stype="(title|ctrTitle)"/.test(spXml)
}

/** graphicFrame 里的表格 → 逻辑网格（#1047）。 */
function parseTableFrame(frameXml: string): PptxTable | null {
  const rawRows: Array<Array<{ text: string; attrs: string }>> = []
  const trRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g
  let m: RegExpExecArray | null
  while ((m = trRe.exec(frameXml)) !== null) {
    const cells: Array<{ text: string; attrs: string }> = []
    const tcRe = /<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g
    let c: RegExpExecArray | null
    while ((c = tcRe.exec(m[1])) !== null) {
      cells.push({ text: paragraphsFromShape(c[2]).join(' ').slice(0, 2000), attrs: c[1] })
    }
    rawRows.push(cells)
  }
  if (rawRows.length === 0) return null

  // 逻辑网格展开（最小可用降级方案 — 不追求合并单元格的像素级还原）：
  //   gridSpan/rowSpan → 重复文本占位后续行列；hMerge/vMerge（续格）→
  //   复制左格/上格文本。保证无空白格、无内容丢失。
  const pending = new Map<number, Map<number, string>>() // 待填行号 → (列号 → 携带文本)
  const grid: string[][] = []
  let degraded = false
  // #1062-7: 行/列截断不再静默 — 标记 truncatedDegraded（caption 可见）。
  let truncated = false
  rawRows.forEach((cells, ri) => {
    const fills = pending.get(ri)
    const row: string[] = []
    let ci = 0
    // #1067: 锚点剩余覆盖数 — 真实 PowerPoint 合并单元格的标准写法是「锚点
    // gridSpan="N" + N-1 个 hMerge="1" 占位格」同时出现：锚点自身占 1 个列槽、
    // 还覆盖后续 N-1 个槽。每个非续格处理完后重置为 span-1。
    let anchorCover = 0
    const fillCarried = () => {
      while (fills?.has(ci)) {
        row.push(fills.get(ci)!)
        ci += 1
      }
    }
    for (const cell of cells) {
      fillCarried()
      const span = parseInt(/gridSpan="(\d+)"/.exec(cell.attrs)?.[1] || '', 10) || 1
      const vSpan = parseInt(/rowSpan="(\d+)"/.exec(cell.attrs)?.[1] || '', 10) || 1
      const isHMerge = /hMerge="1"/.test(cell.attrs)
      const isVMerge = /vMerge="1"/.test(cell.attrs)
      // #1067: hMerge 占位格的列槽已被前一锚点的 gridSpan 覆盖 → 跳过 push、
      // 仅 ci += 1（列槽已被锚点填过；旧实现把占位格又当新列 push，行宽多计
      // N-1 → 全表内容错位）。锚点未声明 gridSpan 的畸形续格（HTML 风格产物）
      // anchorCover 已耗尽 → 落到下方「复制左格」回退路径，旧行为保持。
      if (isHMerge && anchorCover > 0) {
        anchorCover -= 1
        ci += 1
        degraded = true
        if (ci > 30) truncated = true
        continue
      }
      let text = cell.text
      if (isHMerge) text = row[ci - 1] ?? text
      if (isVMerge) text = grid[ri - 1]?.[ci] ?? text
      if (span > 1 || vSpan > 1 || isHMerge || isVMerge) degraded = true
      for (let k = 0; k < Math.min(span, 30 - ci); k += 1) row.push(text)
      if (vSpan > 1) {
        for (let r2 = 1; r2 < Math.min(vSpan, 200 - ri); r2 += 1) {
          const carryRow = pending.get(ri + r2) ?? new Map<number, string>()
          for (let k = 0; k < span; k += 1) carryRow.set(ci + k, text)
          pending.set(ri + r2, carryRow)
        }
      }
      ci += span
      // #1067: 锚点展开后剩余覆盖 = span - 1（紧随的 hMerge 占位格各消费 1 槽）
      anchorCover = span - 1
      // #1062-7: 逻辑网格越过 30 列（截断发生）标记
      if (ci > 30) truncated = true
    }
    fillCarried()
    // #1062-7: 合并填充使行越过 30 列（截断发生）标记
    if (row.length > 30) truncated = true
    grid.push(row.slice(0, 30))
  })
  // 全空表格无可解析内容 — 保留原占位注记（不产出空 table 块）。
  if (!grid.some((row) => row.some((cell) => cell.trim() !== ''))) return null
  // #1062-7: 行截断（slice(0,200)）标记
  if (grid.length > 200) truncated = true
  let rows = grid.slice(0, 200)
  // #1062-1: 按导出 schema 预自检（data JSON ≤256KB）— 超限丢尾部行（保表头）
  // 并标记，杜绝"导入成功、导出永远报验证错"。
  const sizeOf = (rs: string[][]): number => JSON.stringify({ rows: rs }).length
  if (sizeOf(rows) > TABLE_DATA_EXPORT_LIMIT) {
    truncated = true
    const kept = [rows[0]]
    for (let ri = 1; ri < rows.length; ri++) {
      if (sizeOf([...kept, rows[ri]]) > TABLE_DATA_EXPORT_LIMIT) break
      kept.push(rows[ri])
    }
    rows = kept
  }
  return {
    rows,
    ...(degraded ? { mergedDegraded: true } : {}),
    ...(truncated ? { truncatedDegraded: true } : {}),
  }
}

/** slide XML → { title, paragraphs, tables, chartRids, smartArtXmls }。 */
function parseSlideXml(xml: string, slideIndex: number): {
  title: string
  paragraphs: string[]
  tables: PptxTable[]
  /** 图表 frame 的 r:id（#1048 — 由 parsePptx 经 slide rels 解析 chart part）。 */
  chartRids: string[]
  /** SmartArt frame XML（#1052 — 由 parsePptx 经 diagramDrawing 关系解析降级绘图）。 */
  smartArtXmls: string[]
} {
  let title = ''
  const paragraphs: string[] = []
  const tables: PptxTable[] = []
  const chartRids: string[] = []
  const smartArtXmls: string[] = []
  let budget = MAX_SLIDE_TEXT_CHARS

  const pushTexts = (texts: string[]) => {
    for (const t of texts) {
      if (budget <= 0) return
      const piece = t.slice(0, budget)
      budget -= piece.length
      paragraphs.push(piece)
    }
  }

  // 1) 形状（<p:sp>）：title 占位符 → 页标题；其余 → 正文段落。
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let m: RegExpExecArray | null
  while ((m = shapeRe.exec(xml)) !== null) {
    const spXml = m[1]
    if (isTitleShape(spXml) && !title) {
      const paras = paragraphsFromShape(spXml)
      if (paras.length > 0) {
        title = paras.join(' ').slice(0, 500)
        continue
      }
    }
    pushTexts(paragraphsFromShape(spXml))
  }

  // 2) 复杂对象（<p:graphicFrame>）：表格就地结构化解析（#1047，无 rels
  //    依赖）；图表/SmartArt 记录 frame 由 parsePptx 按 rels 解析对应 part
  //    （#1048/#1052），解析失败降级为占位注记（不静默丢内容）。
  const frameRe = /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g
  while ((m = frameRe.exec(xml)) !== null) {
    const frameXml = m[1]
    if (/<a:tbl[\s>]/.test(frameXml)) {
      const table = parseTableFrame(frameXml)
      if (table) tables.push(table)
      else pushTexts(['[本页含表格，未解析]'])
      continue
    }
    const chartRid = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(frameXml)?.[1]
    if (chartRid) {
      chartRids.push(chartRid)
      continue
    }
    if (/<dgm:/.test(frameXml)) smartArtXmls.push(frameXml)
  }

  return { title: title || `第 ${slideIndex} 页`, paragraphs, tables, chartRids, smartArtXmls }
}

/** rels Target → zip 内 part 名（slide rels 相对于 ppt/slides/ 解析）。 */
function normalizePartTarget(target: string): string {
  if (target.startsWith('../')) return `ppt/${target.slice(3)}`
  if (target.startsWith('/')) return target.slice(1)
  return `ppt/slides/${target}`
}

/** slide rels + r:id → 关系目标 part 字节（关系断链/part 缺失返回 null）。 */
function slidePartByRid(rid: string, relsXml: string, entries: Map<string, Buffer>): Buffer | null {
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    const attrs = m[1]
    if (!attrs.includes(`Id="${rid}"`)) continue
    const target = /Target="([^"]+)"/.exec(attrs)?.[1]
    return target ? entries.get(normalizePartTarget(target)) ?? null : null
  }
  return null
}

/** slide rels → SmartArt 降级绘图（diagramDrawing，MS 2007 扩展关系）part 名列表。 */
function diagramDrawingTargets(relsXml: string): string[] {
  const out: string[] = []
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    const attrs = m[1]
    if (!/diagramDrawing/.test(attrs)) continue
    const target = /Target="([^"]+)"/.exec(attrs)?.[1]
    if (target) out.push(normalizePartTarget(target))
  }
  return out
}

/**
 * #1062-2: slide rels → 该页 notesSlide part 名（Type 含 notesSlide 的关系）。
 * 真实 pptx 页重排/复制后 notesSlideN 编号与页序无关 — 按 rels 定位才能把
 * 备注挂对页；rels 是无序映射，故按 Type 匹配而非出现序。无 → null（调用方
 * 按页序兜底，兼容旧生成器产物）。
 */
function notesSlideTargetByRels(relsXml: string): string | null {
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    const attrs = m[1]
    if (!/Type="[^"]*notesSlide"/.test(attrs)) continue
    const target = /Target="([^"]+)"/.exec(attrs)?.[1]
    if (target) return normalizePartTarget(target)
  }
  return null
}

/** OOXML 图表类型 → contracts chartBlockSchema.chart_type（#1048）。 */
const PPTX_CHART_TYPE_MAP: Record<string, 'bar' | 'line'> = {
  barChart: 'bar',
  lineChart: 'line',
  // 饼图/环图在现有渲染管道（#176）无原生类型 — 映射为 bar 保留全部数据，
  // caption 记录原类型（视觉形态降级、数据不丢，见 PptxChart 注释）。
  pieChart: 'bar',
  doughnutChart: 'bar',
}

/** chartN.xml → 结构化图表（首系列）。不支持类型/无数据 → spec 缺省。 */
function parseChartXml(xml: string): PptxChart {
  const ooxmlType = /<c:(\w+Chart)\b/.exec(xml)?.[1] || 'unknownChart'
  const chartType = PPTX_CHART_TYPE_MAP[ooxmlType]
  if (!chartType) return { ooxmlType }
  const ser = /<c:ser>[\s\S]*?<\/c:ser>/.exec(xml)?.[0]
  if (!ser) return { ooxmlType }

  /**
   * #1059: `<c:pt>` 按 idx 属性建映射（idx → 解码后的 <c:v> 文本），弃按数组
   * 位置配对。真实 OOXML 中数值列含空单元格时 Excel 在 numCache 里跳过该
   * `<c:pt>`（cat strCache 保留全部类别）——按下标位置配对会使后续 label/value
   * 整体错一位（静默数据串行）。
   */
  const collectPtsByIdx = (block: string): Map<number, string> => {
    const out = new Map<number, string>()
    const ptRe = /<c:pt\b[^>]*idx="(\d+)"[^>]*>([\s\S]*?)<\/c:pt>/g
    let m: RegExpExecArray | null
    while ((m = ptRe.exec(block)) !== null) {
      out.set(parseInt(m[1], 10), decodeXmlEntities(/<c:v>([\s\S]*?)<\/c:v>/.exec(m[2])?.[1] || '').trim())
    }
    return out
  }
  const catByIdx = collectPtsByIdx(/<c:cat>[\s\S]*?<\/c:cat>/.exec(ser)?.[0] || '')
  const valByIdx = collectPtsByIdx(/<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] || '')
  // val 侧沿用原数值过滤口径（非有限数 → 该 idx 不入列，只丢该点不整体错位）。
  const valueByIdx = new Map<number, number>()
  for (const [idx, v] of valByIdx) {
    const n = Number(v)
    if (Number.isFinite(n)) valueByIdx.set(idx, n)
  }
  // #1059: 按 idx 交集配对，升序输出（idx 乱序出现的 part 也按类别轴顺序还原）。
  const data = [...valueByIdx.keys()]
    .filter((idx) => catByIdx.has(idx))
    .sort((a, b) => a - b)
    .slice(0, 200)
    .map((idx) => ({ label: (catByIdx.get(idx) || `#${idx + 1}`).slice(0, 200), value: valueByIdx.get(idx)! }))
  if (data.length === 0) return { ooxmlType }

  const title = decodeXmlEntities(/<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0]?.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/)?.[1] || '').trim().slice(0, 500)
  // 契约 spec 单系列 — 多系列保留第 1 个，其余系列数记入 caption（不静默）。
  const seriesCount = (xml.match(/<c:ser>/g) || []).length
  let caption: string | undefined
  if (ooxmlType !== 'barChart' && ooxmlType !== 'lineChart') {
    caption = `原图表类型 ${ooxmlType}，数据已按${chartType === 'bar' ? '柱状图' : '折线图'}保留`
  }
  if (seriesCount > 1) caption = `${caption ? `${caption}；` : ''}源文件共 ${seriesCount} 个系列，已保留第 1 个`
  return {
    ooxmlType,
    spec: { chart_type: chartType, data, ...(title ? { title } : {}) },
    ...(caption ? { caption } : {}),
  }
}

/** SmartArt 降级绘图（dsp:drawing）→ 形状文字列表（按几何位置排序近似阅读序，#1052）。 */
function parseSmartArtDrawingXml(xml: string): string[] {
  const shapes: Array<{ x: number; y: number; text: string }> = []
  const spRe = /<dsp:sp\b[^>]*>([\s\S]*?)<\/dsp:sp>/g
  let m: RegExpExecArray | null
  while ((m = spRe.exec(xml)) !== null) {
    const text = paragraphsFromShape(m[1]).join(' ').trim()
    if (!text) continue
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(m[1])
    shapes.push({ x: off ? parseInt(off[1], 10) : 0, y: off ? parseInt(off[2], 10) : 0, text: text.slice(0, 500) })
  }
  return shapes
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .slice(0, 30)
    .map((s) => s.text)
}

/** notesSlide XML → 纯文本（有界，只取 body 占位符 — 跳过页码占位）。
 * #1062-6: 提取上限统一到 wire 口径（contracts notes max 5000，原 2000 与
 * wire/worker 三处不一致）。 */
function parseNotesXml(xml: string): string {
  const texts: string[] = []
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let m: RegExpExecArray | null
  while ((m = shapeRe.exec(xml)) !== null) {
    if (!/<p:ph[^>]*\stype="body"/.test(m[1])) continue
    texts.push(...paragraphsFromShape(m[1]))
  }
  return texts.join(' ').slice(0, 5000)
}

/** slideN.xml.rels → 该页引用的 media 文件名（去重）。 */
function mediaFromSlideRels(relsXml: string): string[] {
  const names: string[] = []
  const relRe = /<Relationship\b[^>]*Target="([^"]*media\/[^"]*)"[^>]*\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    const base = m[1].split('/').pop() || ''
    if (base) names.push(base)
  }
  return names
}

/** presentation.xml + rels → 权威页序（slide 文件名列表）；失败返回 null。 */
function orderedSlideNames(entries: Map<string, Buffer>): string[] | null {
  try {
    const presXml = entries.get('ppt/presentation.xml')?.toString('utf-8')
    const relsXml = entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf-8')
    if (!presXml || !relsXml) return null
    const ridToTarget = new Map<string, string>()
    const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]*slides\/[^"]*)"[^>]*\/?>/g
    let m: RegExpExecArray | null
    while ((m = relRe.exec(relsXml)) !== null) {
      const base = m[2].split('/').pop() || ''
      if (base) ridToTarget.set(m[1], `ppt/slides/${base}`)
    }
    const ordered: string[] = []
    const sldRe = /<p:sldId\b[^>]*r:id="([^"]+)"/g
    while ((m = sldRe.exec(presXml)) !== null) {
      const target = ridToTarget.get(m[1])
      if (target && entries.has(target)) ordered.push(target)
    }
    return ordered.length > 0 ? ordered : null
  } catch {
    return null
  }
}

/**
 * 解析 pptx 字节流。任何失败都以 { ok:false, error } 返回（可读、可引导），
 * 绝不抛出 — 上传/导入管线据此降级，不产生半截导入。
 */
export function parsePptx(buffer: Buffer): PptxParseResult {
  const fail = (error: string): PptxParseResult => ({ ok: false, error, slides: [], images: [] })
  let entriesMap: Map<string, Buffer>
  try {
    const entries = readZipEntries(buffer, {
      maxEntries: 3000,
      maxTotalUncompressed: 300 * 1024 * 1024,
      // 只解压文本/关系/媒体 — 其余（fonts/embeddings/thumbnails）跳过。
      // #1048/#1052: chart part（ppt/charts/chartN.xml）与 SmartArt 降级绘图
      // （ppt/diagrams/drawingN.xml）随批次解析纳入。
      filter: (name) => /^(ppt\/slides\/slide\d+\.xml|ppt\/slides\/_rels\/|ppt\/notesSlides\/|ppt\/media\/|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/charts\/chart\d+\.xml|ppt\/diagrams\/drawing\d+\.xml)/.test(name),
    })
    entriesMap = new Map(entries.map((e) => [e.name, e.data]))
  } catch (err) {
    if (err instanceof ZipReadError) return fail(`无法解析 PPTX：${err.message}`)
    return fail(`无法解析 PPTX：${(err as Error).message.slice(0, 120)}`)
  }

  // 页序：presentation.xml sldIdLst 权威序 → 文件名自然序兜底。
  const natural = [...entriesMap.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0))
  const slideNames = orderedSlideNames(entriesMap) ?? natural
  if (slideNames.length === 0) return fail('无法解析 PPTX：未找到幻灯片内容（文件损坏或不是有效的 PowerPoint 文件）')

  const mediaEntries = new Map<string, Buffer>()
  for (const [name, data] of entriesMap) {
    if (name.startsWith('ppt/media/') && data.length <= MAX_MEDIA_FILE_BYTES) {
      mediaEntries.set(name.slice('ppt/media/'.length), data)
    }
  }

  const slides: PptxSlide[] = []
  const images: ExtractedPdfImage[] = []
  for (let i = 0; i < Math.min(slideNames.length, MAX_SLIDES); i++) {
    const slideName = slideNames[i]
    const xml = entriesMap.get(slideName)?.toString('utf-8') || ''
    const relsXml = entriesMap.get(`ppt/slides/_rels/${slideName.split('/').pop()}.rels`)?.toString('utf-8') || ''
    const parsedSlide = parseSlideXml(xml, i + 1)
    const slide: PptxSlide = {
      title: parsedSlide.title,
      paragraphs: parsedSlide.paragraphs,
      ...(parsedSlide.tables.length ? { tables: parsedSlide.tables } : {}),
    }

    // #1048: 图表 part（rels r:id → ppt/charts/chartN.xml）→ 结构化 chart 数据；
    // 关系断链 → 原占位注记；不支持类型 → 降级占位并记录类型名（不中断导入）。
    const charts: PptxChart[] = []
    for (const rid of parsedSlide.chartRids) {
      const chartPart = slidePartByRid(rid, relsXml, entriesMap)
      if (!chartPart) {
        slide.paragraphs.push('[本页含图表，未解析]')
        continue
      }
      const chart = parseChartXml(chartPart.toString('utf-8'))
      if (chart.spec) charts.push(chart)
      else slide.paragraphs.push(`[本页含图表（类型：${chart.ooxmlType}），暂不支持结构化解析]`)
    }
    if (charts.length > 0) slide.charts = charts

    // #1052: SmartArt → 降级绘图（dsp:drawing）形状文字列表（信息不丢）；
    // 降级绘图缺失/不可读（极少数旧版工具产物）→ 明确占位提示，不静默。
    // drawing part 经 slide rels 的 diagramDrawing 关系定位（dgm:relIds 的
    // dm/lo/qs/cs 不指向 drawing）。
    // #1062-4: 同页多 SmartArt 的 frame↔drawing 配对弃「rels 出现序」假设
    // （rels 是无序映射）— 以 frame 引用的 diagramData r:id（dgm:relIds
    // r:dm）↔ drawing part 的 dsp:dataModelExt relId 权威配对（PowerPoint
    // 写入的回链）；旧产物无 dataModelExt 时才按 rels 出现序兜底消费。
    const drawingTargets = diagramDrawingTargets(relsXml)
    const drawingTargetByDataRid = new Map<string, string>()
    for (const target of drawingTargets) {
      const drawingXml = entriesMap.get(target)?.toString('utf-8') || ''
      const relId = /<dsp:dataModelExt\b[^>]*relId="([^"]+)"/.exec(drawingXml)?.[1]
      if (relId && !drawingTargetByDataRid.has(relId)) drawingTargetByDataRid.set(relId, target)
    }
    const availableDrawings = [...drawingTargets]
    const takeDrawing = (frameXml: string): string | undefined => {
      const dmRid = /<dgm:relIds\b[^>]*r:dm="([^"]+)"/.exec(frameXml)?.[1]
      if (dmRid) {
        const matched = drawingTargetByDataRid.get(dmRid)
        if (matched) {
          const pos = availableDrawings.indexOf(matched)
          if (pos >= 0) availableDrawings.splice(pos, 1)
          return matched
        }
      }
      // 兜底：drawing part 无 dataModelExt（旧生成器产物）→ 按 rels 出现序消费
      return availableDrawings.shift()
    }
    for (const frameXml of parsedSlide.smartArtXmls) {
      const drawingTarget = takeDrawing(frameXml)
      const drawingXml = drawingTarget ? entriesMap.get(drawingTarget)?.toString('utf-8') : undefined
      const texts = drawingXml ? parseSmartArtDrawingXml(drawingXml) : []
      if (texts.length > 0) {
        slide.paragraphs.push('[SmartArt 已降级为文字列表，原图形排布未保留]')
        let budget = 10000
        for (const t of texts) {
          if (budget <= 0) break
          const piece = t.slice(0, budget)
          budget -= piece.length
          slide.paragraphs.push(piece)
        }
      } else {
        slide.paragraphs.push('[本页含 SmartArt，未解析：降级绘图缺失或不可读]')
      }
    }

    // speaker notes（notesSlide，可选）— #1062-2: 按 slide rels 的 notesSlide
    // 关系定位（真实 pptx 页重排/复制后 notesSlideN 编号与页序无关，页序映射
    // 会把备注静默挂错页）；关系缺失才按页序兜底（旧生成器产物）。
    const notesTarget = notesSlideTargetByRels(relsXml) ?? `ppt/notesSlides/notesSlide${i + 1}.xml`
    const notesXml = entriesMap.get(notesTarget)?.toString('utf-8')
    if (notesXml) {
      const notes = parseNotesXml(notesXml)
      if (notes) slide.notes = notes
    }
    // 该页引用的图片（按 rels → media 落位，页号 = 页码，供 markdown 分页嵌图）。
    for (const mediaName of mediaFromSlideRels(relsXml)) {
      const data = mediaEntries.get(mediaName)
      if (!data || images.length >= MAX_MEDIA_FILES) continue
      const ext = mediaName.split('.').pop()?.toLowerCase() || ''
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) continue
      images.push({ mime: mimeFromExt(ext), dataBase64: data.toString('base64'), page: i + 1 })
    }
    slides.push(slide)
  }
  if (slides.length === 0) return fail('无法解析 PPTX：未提取到任何页面内容')
  return { ok: true, slides, images }
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  }
  return map[ext] || 'image/png'
}

/** deck 落点：slides → presentationContent（契约模型，#773 的 Doc.deck）。 */
// #1066-9: 返回类型同步 slides[].notes — #1046 起运行时已回填 notes
// （worker 导出侧 addNotes 写回），此前手写返回类型陈旧未跟上。
export function pptxSlidesToDeck(slides: PptxSlide[], images: ExtractedPdfImage[], title: string, schemaVersion: number): { schemaVersion: number; title: string; slides: Array<{ title: string; notes?: string; content: Array<Record<string, unknown>> }> } | null {
  if (slides.length === 0) return null
  const byPage = new Map<number, ExtractedPdfImage[]>()
  for (const img of images) {
    const list = byPage.get(img.page) || []
    list.push(img)
    byPage.set(img.page, list)
  }
  const deckSlides = slides.slice(0, 30).map((s, i) => {
    const content: Array<Record<string, unknown>> = []
    // #1062-7: 契约上限（presentationSlideSchema content max 50）内为表格/
    // 图表/图片等追加块预留槽位 — 此前段落满 50 块时追加块被无痕丢弃。
    const MAX_BLOCKS = 50
    const reservedBlocks = Math.min((s.tables || []).length, 5) + Math.min((s.charts || []).length, 5) + Math.min((byPage.get(i + 1) || []).length, 3)
    let paraBudget = MAX_BLOCKS - reservedBlocks
    let paraDropped = 0
    if (s.paragraphs.length > paraBudget) {
      paraDropped = s.paragraphs.length - (paraBudget - 1)
      paraBudget = Math.max(0, paraBudget - 1) // 留 1 块给降级注记
    }
    for (const p of s.paragraphs.slice(0, paraBudget)) {
      content.push({ type: 'paragraph', text: p.slice(0, 2000), style: 'bullet' })
    }
    // #1047: 表格 → type:'table' 块（行列数据 JSON 字符串，contracts tableBlockSchema
    // 形状）；合并单元格/行列截断降级均以 caption 注明（不静默）。
    for (const t of (s.tables || []).slice(0, 5)) {
      // #1062-1/#1062-7: 截断降级标记 → caption（含合并单元格时拼接说明）。
      const caption = [
        t.mergedDegraded ? '（含合并单元格：已按重复文本降级）' : '',
        t.truncatedDegraded ? '（表格超出导出上限：已截断至边界内）' : '',
      ].filter(Boolean).join('；')
      content.push({
        type: 'table',
        data: JSON.stringify({ rows: t.rows }),
        ...(caption ? { caption } : {}),
      })
    }
    // #1048: 图表 → type:'chart' 块（spec 对齐 contracts chartBlockSchema，复用
    // insert_chart 的确定性渲染管道；导出边界转图片/原生图表，worker 零改动）。
    for (const c of (s.charts || []).slice(0, 5)) {
      if (c.spec) content.push({ type: 'chart', spec: c.spec, ...(c.caption ? { caption: c.caption } : {}) })
    }
    for (const img of (byPage.get(i + 1) || []).slice(0, 3)) {
      content.push({ type: 'image', ref: `pptx-media-${i + 1}-${content.length}`, data: img.dataBase64, caption: `图 ${i + 1}` })
    }
    // #1062-7: 段落被 50 块上限截断 → 显式注记块（丢弃数可见，不再静默）。
    if (paraDropped > 0) {
      content.push({ type: 'paragraph', text: `（本页内容超出 ${MAX_BLOCKS} 块上限：已丢弃 ${paraDropped} 段落）`, style: 'normal' })
    }
    if (content.length === 0) content.push({ type: 'paragraph', text: '（本页待补充）', style: 'normal' })
    // #1046: speaker notes 映射到 DeckWire.slides[].notes（此前在此步被丢弃 —
    // PptxSlide.notes 提取后没有任何消费方）。导出侧 worker slide.addNotes 写回。
    return {
      title: s.title.slice(0, 500),
      ...(s.notes ? { notes: s.notes } : {}),
      content: content.slice(0, 50), // 契约上限（presentationSlideSchema content max 50）
    }
  })
  return { schemaVersion, title: (title || 'Presentation').slice(0, 500), slides: deckSlides }
}

/** 文档落点：slides → markdown（`##` 分节 + 页标记供 embedDocumentImages 嵌图）。 */
export function pptxSlidesToMarkdown(result: PptxParseResult): string {
  const parts: string[] = []
  result.slides.forEach((s, i) => {
    parts.push(`## ${s.title}`)
    for (const p of s.paragraphs) parts.push(p)
    parts.push('')
    parts.push(`<!-- page:${i + 1} -->`)
    parts.push('')
  })
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 从 uploads 读取并解析 pptx（供后台 deck 落点与导入管线共用）。 */
export function extractPptxContentFromUpload(userId: string, fileId: string): { text: string; slides: PptxSlide[]; images: ExtractedPdfImage[]; error?: string } {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath) return { text: '', slides: [], images: [], error: '上传文件不存在' }
  let buffer: Buffer
  try {
    buffer = require('fs').readFileSync(filepath)
  } catch {
    return { text: '', slides: [], images: [], error: '上传文件不存在' }
  }
  const parsed = parsePptx(buffer)
  if (!parsed.ok) return { text: '', slides: [], images: [], error: parsed.error }
  return { text: pptxSlidesToMarkdown(parsed), slides: parsed.slides, images: parsed.images }
}
