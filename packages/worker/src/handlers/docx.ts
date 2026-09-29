import { Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun } from 'docx'
import { saveFile } from '../storage.js'
import { SCHEMA_VERSION, validateRenderContent, type DocumentContent } from '@heurion/contracts'
import { resolveImage, detectImageMime } from './remote-image.js' // #1074-2: remote-image 职责自 common.ts 拆出
import { imageDimensionsOf, fitImageBox } from './image-dimensions.js'

/**
 * #1148: mime → docx ImageRun type。docx 仅支持 jpg/png/gif/bmp/svg —
 * webp 等无对应类型（旧实现写死 'png'，JPEG/GIF 被标成 png、SVG 损坏）。
 */
const DOCX_IMAGE_TYPES: Record<string, 'jpg' | 'png' | 'gif' | 'bmp' | 'svg'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** #1148: SVG 在旧版 Word 无原生支持 — docx 要求 fallback（1×1 透明 PNG）。 */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const DOCX_IMAGE_MAX_W = 480
const DOCX_IMAGE_MAX_H = 360

export interface DocxSection {
  heading?: string
  paragraphs?: string[]
  table?: { headers: string[]; rows: string[][] }
}

export interface DocxInput {
  title?: string
  sections?: DocxSection[]
}

/** #1090-4: 单次导出内嵌图片总字节预算 — ImageRun 持原始 Buffer，全驻留内存
 *  直到 Packer.toBuffer 序列化完成（此前无任何预算，20MB×N 张最坏可致 worker
 *  OOM）。机制镜像 pptx #1066-8：默认 100MB（正常文档远低于该阈值，仅封顶
 *  恶意超大 payload 的自身导出），可用 DOCX_IMAGE_BUDGET_BYTES 覆盖（部署
 *  调优/测试，非法值回退默认）。注：docx 驻留的是原始字节（非 base64 膨胀
 *  后），故按 raw 字节计，与 pptx 的 base64InflatedBytes 口径差异见各自注释。 */
export const MAX_DOCX_EMBEDDED_IMAGE_BYTES = 100 * 1024 * 1024

/** #1090-4: 解析生效预算（env 覆盖解析与 pptx resolveImageBudget 同款）。 */
export function resolveDocxImageBudget(): number {
  const raw = Number(process.env.DOCX_IMAGE_BUDGET_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_DOCX_EMBEDDED_IMAGE_BYTES
}

/** #1090-4: 累计已嵌入字节 + 本张字节是否超预算（镜像 pptx imageBudgetExceeded
 *  — 单张独超预算时 embedded=0 同样命中，即 per-image 隐式封顶）。 */
export function docxImageBudgetExceeded(embeddedBytes: number, incomingBytes: number, budget: number = resolveDocxImageBudget()): boolean {
  return embeddedBytes + incomingBytes > budget
}

/** #1141: 图片解析时间预算 — 远程图串行下载每张最长 10s，数百张可把导出拖
 *  到小时级；超预算后不再解析，正文留可见注记（与字节预算同口径）。
 *  DOCX_IMAGE_TIME_BUDGET_MS 可覆盖（测试/部署调优，非法值回退默认）。 */
export const MAX_DOCX_IMAGE_RESOLVE_MS = 60_000

export function resolveDocxImageTimeBudget(): number {
  const raw = Number(process.env.DOCX_IMAGE_TIME_BUDGET_MS)
  // 0 合法（=立即过期，禁图；测试/极端降级用）；负数/NaN 回退默认。
  return Number.isFinite(raw) && raw >= 0 ? raw : MAX_DOCX_IMAGE_RESOLVE_MS
}

export async function generateDocx(payload: unknown) {
  // New validated contract: { schema_version, content_type, data: {schemaVersion, title, sections} }.
  // Legacy tolerance: when validation fails, sections are rebuilt from
  // whatever `sections` array arrived (top-level or nested under `data`,
  // flat or partial); a payload with no sections at all degrades to a
  // single placeholder section — never an empty document.
  const raw = (payload as { data?: unknown } | null)?.data ?? payload
  const check = validateRenderContent('sidecar.generate_docx', raw)
  let input: DocumentContent
  if (check.ok) {
    input = check.data as DocumentContent
  } else {
    // Build sections explicitly from whatever shape arrived (legacy flat or
    // partial) — never an empty document.
    const rawObj = (raw ?? {}) as Record<string, unknown>
    const nested = (rawObj.data ?? {}) as Record<string, unknown>
    const rawSections: unknown[] = Array.isArray(rawObj.sections)
      ? rawObj.sections
      : (Array.isArray(nested.sections) ? nested.sections : [])
    const sections = (rawSections.length > 0
      ? rawSections.map((secUnknown) => {
          const sec = (secUnknown ?? {}) as Record<string, unknown>
          const paras: unknown[] = Array.isArray(sec.paragraphs) ? sec.paragraphs : [String(sec.paragraphs || sec.content || '')]
          return {
            heading: String(sec.heading || 'Section'),
            paragraphs: paras.map((p) => (typeof p === 'string' ? { type: 'paragraph' as const, text: p } : p)),
          }
        })
      : [{ heading: '内容', paragraphs: [{ type: 'paragraph' as const, text: '（无内容）' }] }]) as DocumentContent['sections']
    input = {
      schemaVersion: SCHEMA_VERSION,
      title: String(rawObj.title || 'Document'),
      sections,
    }
  }

  const children: Paragraph[] = []
  children.push(
    new Paragraph({ text: input.title || 'Document', heading: 'Title', alignment: AlignmentType.CENTER }),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
  )

  // #1090-4: 导出期累计已嵌入图片字节；超预算的图片块跳过（log 可观测）+
  // 正文留可见注记（与 pptx #1066-8/#1090-3「降级必须可见」口径一致）。
  const budget = resolveDocxImageBudget()
  const imageDeadline = Date.now() + resolveDocxImageTimeBudget()
  let embeddedImageBytes = 0
  let timeBudgetWarned = false
  for (const section of input.sections || []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: 'Heading1', spacing: { before: 400, after: 200 } }))
    }
    for (const block of section.paragraphs || []) {
      if (block.type === 'image') {
        // #1141: 超时预算 — 跳过解析（不再发起远程下载），可见注记。
        if (Date.now() >= imageDeadline) {
          if (!timeBudgetWarned) {
            console.warn('[DOCX] #1141 图片解析时间预算用尽 — 跳过后续图片解析')
            timeBudgetWarned = true
          }
          children.push(new Paragraph({ children: [new TextRun('[图片已省略：超出导出时间预算]')], spacing: { after: 120 } }))
          continue
        }
        const img = await resolveImage(block)
        if (img) {
          // #1090-4: 预算按原始字节计（docx 驻留 Buffer，见 MAX_DOCX_EMBEDDED_IMAGE_BYTES 注释）。
          if (docxImageBudgetExceeded(embeddedImageBytes, img.data.length, budget)) {
            console.warn(`[DOCX] #1090-4 内嵌图片总量超预算(${Math.round(budget / 1024 / 1024)}MB) — 跳过该图片块`)
            children.push(new Paragraph({ children: [new TextRun('[图片已省略：超出导出图片预算]')], spacing: { after: 120 } }))
          } else {
            embeddedImageBytes += img.data.length
            // #1148: 按 magic bytes 选 docx 类型（旧实现写死 png → JPEG/GIF
            // 类型错误、SVG 损坏）+ 按原图比例缩放进上限框（旧实现固定
            // 240×120 拉伸）。
            // #1150-followup: 严格识别 — 未识别(null)走可见注记,不再误当 SVG。
            const mime = detectImageMime(img.data)
            const docxType = mime ? DOCX_IMAGE_TYPES[mime] : undefined
            if (!docxType) {
              console.warn(`[DOCX] #1148 不支持的图片类型 ${mime ?? 'unknown'} — 跳过该图片块（Word 无法内嵌）`)
              children.push(new Paragraph({ children: [new TextRun('[图片已省略：不支持的图片格式]')], spacing: { after: 120 } }))
            } else {
              const transformation = fitImageBox(imageDimensionsOf(img.data), DOCX_IMAGE_MAX_W, DOCX_IMAGE_MAX_H)
              try {
                children.push(new Paragraph({ children: [docxType === 'svg'
                  ? new ImageRun({ type: 'svg', data: img.data, transformation, fallback: { type: 'png', data: TRANSPARENT_PNG } })
                  : new ImageRun({ type: docxType, data: img.data, transformation })] }))
              } catch { /* skip broken image */ }
            }
          }
        }
        continue
      }
      // #957: contentBlock 联合扩展(chart/figure 在导出边界已转 image)，
      // docx 渲染器按 paragraph/image 处理，其余块降级为空行。
      children.push(new Paragraph({ children: [new TextRun(String((block as { text?: string }).text || ''))], spacing: { after: 120 } }))
    }
  }

  const doc = new Document({ sections: [{ children }] })
  const buffer = Buffer.from(await Packer.toBuffer(doc))
  return saveFile(buffer, 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}
