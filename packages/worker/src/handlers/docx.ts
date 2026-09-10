import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType, ImageRun, convertMillimetersToTwip } from 'docx'
import { saveFile } from '../storage.js'
import { SCHEMA_VERSION, validateRenderContent, type ContentBlock, type DocumentContent } from '@heurion/contracts'
import { resolveImage } from './common.js'

export interface DocxSection {
  heading?: string
  paragraphs?: string[]
  table?: { headers: string[]; rows: string[][] }
}

export interface DocxInput {
  title?: string
  sections?: DocxSection[]
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

  for (const section of input.sections || []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: 'Heading1', spacing: { before: 400, after: 200 } }))
    }
    for (const block of section.paragraphs || []) {
      if (block.type === 'image') {
        const img = await resolveImage(block)
        if (img) {
          try {
            children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: img.data as any, transformation: { width: 240, height: 120 } })] }))
          } catch { /* skip broken image */ }
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
