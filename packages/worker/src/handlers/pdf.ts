import PDFDocument from 'pdfkit'
import { saveFile } from '../storage.js'

export interface PdfInput {
  title?: string
  content: string
  sections?: { heading: string; body: string }[]
}

export async function convertToPdf(input: PdfInput) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  const buffers: Buffer[] = []

  doc.on('data', (chunk: Buffer) => buffers.push(chunk))

  return new Promise<any>((resolve, reject) => {
    doc.on('end', async () => {
      try {
        const buffer = Buffer.concat(buffers)
        const result = await saveFile(buffer, 'document.pdf', 'application/pdf')
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
    doc.on('error', reject)

    if (input.title) {
      doc.fontSize(24).text(input.title, { align: 'center' })
      doc.moveDown(2)
    }

    if (input.content) {
      doc.fontSize(12).text(input.content)
      doc.moveDown(1)
    }

    for (const section of input.sections || []) {
      doc.fontSize(18).text(section.heading, { underline: true })
      doc.moveDown(0.5)
      doc.fontSize(12).text(section.body)
      doc.moveDown(1)
    }

    doc.end()
  })
}
