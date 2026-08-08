import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType, ImageRun, convertMillimetersToTwip } from 'docx'
import { saveFile } from '../storage.js'
import { SCHEMA_VERSION, validateRenderContent, type ContentBlock, type DocumentContent } from '@heurion/contracts'

export interface DocxSection {
  heading?: string
  paragraphs?: string[]
  table?: { headers: string[]; rows: string[][] }
}

export interface DocxInput {
  title?: string
  sections?: DocxSection[]
}

/**
 * Sidecar/plugin jobs arrive as { template_id, data: {...}, output_name }.
 * The actual content lives under `data`, so unwrap it before rendering
 * (also tolerates a flat payload for direct callers).
 */
function unwrapPayload(payload: any): Record<string, unknown> {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data
  }
  return payload || {}
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * Build document sections from legacy template-placeholder fields
 * (patient_initials, diagnosis, findings_html, treatment_plan, generated_at).
 * Kept as a fallback when the payload carries no explicit `sections`.
 */
function sectionsFromTemplateData(data: Record<string, unknown>): DocxSection[] {
  const sections: DocxSection[] = []
  const patientBits = [
    data.patient_initials ? `Initials: ${str(data.patient_initials)}` : '',
    data.age !== undefined && data.age !== null ? `Age: ${str(data.age)}` : '',
    data.sex ? `Sex: ${str(data.sex)}` : '',
  ].filter(Boolean)
  if (patientBits.length > 0) sections.push({ heading: 'Patient', paragraphs: [patientBits.join(', ')] })
  if (data.diagnosis) sections.push({ heading: 'Diagnosis', paragraphs: [str(data.diagnosis)] })
  if (data.findings_html) sections.push({ heading: 'Findings', paragraphs: [str(data.findings_html)] })
  if (data.treatment_plan) sections.push({ heading: 'Treatment Plan', paragraphs: [str(data.treatment_plan)] })
  if (data.generated_at) sections.push({ heading: 'Generated', paragraphs: [`Date: ${str(data.generated_at)}`] })
  return sections
}

export async function generateDocx(payload: any, tenant?: { userId?: string; workspaceId?: string }) {
  // New validated contract: { schema_version, content_type, data: {schemaVersion, title, sections} }.
  // Legacy tolerance: { template_id, data: {...legacy fields} } → sectionsFromTemplateData.
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

  const resolveImage = async (block: ContentBlock & { type: 'image' }) => {
    if (block.data) {
      const base64 = block.data.startsWith('data:') ? block.data.split(',')[1] || '' : block.data
      return Buffer.from(base64, 'base64')
    }
    if (block.ref.startsWith('asset://')) {
      try {
        const { readFile } = await import('node:fs/promises')
        return await readFile(`${process.env.ASSET_DIR || '/opt/heurion/assets'}/${block.ref.slice('asset://'.length)}`)
      } catch { return null }
    }
    return null
  }

  for (const section of input.sections || []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: 'Heading1', spacing: { before: 400, after: 200 } }))
    }
    for (const block of section.paragraphs || []) {
      if (block.type === 'image') {
        const buf = await resolveImage(block)
        if (buf) {
          try {
            children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: buf as any, transformation: { width: 240, height: 120 } })] }))
          } catch { /* skip broken image */ }
        }
        continue
      }
      children.push(new Paragraph({ children: [new TextRun(String(block.text || ''))], spacing: { after: 120 } }))
    }
  }

  const doc = new Document({ sections: [{ children }] })
  const buffer = Buffer.from(await Packer.toBuffer(doc))
  return saveFile(buffer, 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}
