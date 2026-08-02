import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType } from 'docx'
import { saveFile } from '../storage.js'

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
  const data = unwrapPayload(payload)
  const input: DocxInput = {
    title: data.title ? str(data.title) : undefined,
    sections: Array.isArray(data.sections) ? (data.sections as DocxSection[]) : sectionsFromTemplateData(data),
  }
  const children: any[] = []

  children.push(
    new Paragraph({
      text: input.title || 'Document',
      heading: 'Title',
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
  )

  for (const section of input.sections || []) {
    if (section.heading) {
      children.push(
        new Paragraph({
          text: section.heading,
          heading: 'Heading1',
          spacing: { before: 400, after: 200 },
        }),
      )
    }
    for (const para of section.paragraphs || []) {
      children.push(
        new Paragraph({
          children: [new TextRun(para)],
          spacing: { after: 120 },
        }),
      )
    }
    if (section.table) {
      const { headers, rows } = section.table
      const tableRows: TableRow[] = [
        new TableRow({
          tableHeader: true,
          children: headers.map(
            (h) =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
                width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
              }),
          ),
        }),
        ...rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph(cell)],
                  }),
              ),
            }),
        ),
      ]
      children.push(
        new Table({ rows: tableRows }),
        new Paragraph({ spacing: { after: 200 }, children: [] }),
      )
    }
  }

  const doc = new Document({ sections: [{ children }] })
  const buffer = Buffer.from(await Packer.toBuffer(doc))
  return saveFile(buffer, 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}
