import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType } from 'docx'
import { saveFile } from '../storage.js'

export interface DocxInput {
  title?: string
  sections?: { heading?: string; paragraphs?: string[]; table?: { headers: string[]; rows: string[][] } }[]
}

export async function generateDocx(input: DocxInput, tenant?: { userId?: string; workspaceId?: string }) {
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
