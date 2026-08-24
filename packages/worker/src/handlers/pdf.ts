import { renderPdf } from './common.js'

export interface PdfInput {
  title?: string
  content: string
  sections?: { heading: string; body: string }[]
}

export async function convertToPdf(input: PdfInput) {
  return renderPdf((doc) => {
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
  }, 'document.pdf')
}
