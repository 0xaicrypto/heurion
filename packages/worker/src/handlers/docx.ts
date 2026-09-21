import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType, ImageRun, convertMillimetersToTwip } from 'docx'
import { saveFile } from '../storage.js'
import { SCHEMA_VERSION, validateRenderContent, type ContentBlock, type DocumentContent } from '@heurion/contracts'
import { resolveImage } from './remote-image.js' // #1074-2: remote-image 职责自 common.ts 拆出

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

export async function generateDocx(payload: any) {
  // New validated contract: { schema_version, content_type, data: {schemaVersion, title, sections} }.
  // Legacy tolerance: when validation fails, sections are rebuilt from
  // whatever `sections` array arrived (top-level or nested under `data`,
  // flat or partial); a payload with no sections at all degrades to a
  // single placeholder section — never an empty document.
  let raw = payload?.data ?? payload
  const check = validateRenderContent('sidecar.generate_docx', raw)
  let input: DocumentContent
  if (check.ok) {
    input = check.data as DocumentContent
  } else {
    // Build sections explicitly from whatever shape arrived (legacy flat or
    // partial) — never an empty document.
    const rawSections: any[] = Array.isArray(raw?.sections) ? raw.sections
      : (raw?.data?.sections as any[]) || []
    const sections = rawSections.length > 0
      ? rawSections.map((sec: any) => {
          const paras = Array.isArray(sec?.paragraphs) ? sec.paragraphs : [String(sec?.paragraphs || sec?.content || '')]
          return {
            heading: String(sec?.heading || 'Section'),
            paragraphs: paras.map((p: any) => (typeof p === 'string' ? { type: 'paragraph' as const, text: p } : p)),
          }
        })
      : [{ heading: '内容', paragraphs: [{ type: 'paragraph' as const, text: '（无内容）' }] }]
    input = {
      schemaVersion: SCHEMA_VERSION,
      title: String(raw?.title || 'Document'),
      sections,
    }
  }

  const children: any[] = []
  children.push(
    new Paragraph({ text: input.title || 'Document', heading: 'Title', alignment: AlignmentType.CENTER }),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
  )

  // #1090-4: 导出期累计已嵌入图片字节；超预算的图片块跳过（log 可观测）+
  // 正文留可见注记（与 pptx #1066-8/#1090-3「降级必须可见」口径一致）。
  const budget = resolveDocxImageBudget()
  let embeddedImageBytes = 0
  for (const section of input.sections || []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: 'Heading1', spacing: { before: 400, after: 200 } }))
    }
    for (const block of section.paragraphs || []) {
      if (block.type === 'image') {
        const img = await resolveImage(block)
        if (img) {
          // #1090-4: 预算按原始字节计（docx 驻留 Buffer，见 MAX_DOCX_EMBEDDED_IMAGE_BYTES 注释）。
          if (docxImageBudgetExceeded(embeddedImageBytes, img.data.length, budget)) {
            console.warn(`[DOCX] #1090-4 内嵌图片总量超预算(${Math.round(budget / 1024 / 1024)}MB) — 跳过该图片块`)
            children.push(new Paragraph({ children: [new TextRun('[图片已省略：超出导出图片预算]')], spacing: { after: 120 } }))
          } else {
            embeddedImageBytes += img.data.length
            try {
              children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: img.data as any, transformation: { width: 240, height: 120 } })] }))
            } catch { /* skip broken image */ }
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
