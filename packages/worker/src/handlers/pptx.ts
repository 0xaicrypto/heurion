import { saveFile } from '../storage.js'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PptxGenJS = require('pptxgenjs') as new () => any

export interface PptxInput {
  title?: string
  slides?: { title?: string; bullets?: string[]; content?: string }[]
}

export async function generatePptx(input: PptxInput) {
  const pres = new PptxGenJS()

  if (input.title) {
    const slide = pres.addSlide()
    slide.addText(input.title, { x: 0.5, y: 1.5, w: 9, h: 2, fontSize: 36, bold: true, align: 'center' })
  }

  for (const slideIn of input.slides || []) {
    const slide = pres.addSlide()
    if (slideIn.title) {
      slide.addText(slideIn.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true })
    }
    if (slideIn.bullets?.length) {
      slide.addText(
        slideIn.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 18 } })),
        { x: 0.5, y: 1.5, w: 9, h: 5 },
      )
    }
    if (slideIn.content) {
      slide.addText(slideIn.content, { x: 0.5, y: 1.5, w: 9, h: 5, fontSize: 18 })
    }
  }

  const buffer = Buffer.from(await pres.write({ outputType: 'buffer' }))
  return saveFile(buffer, 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
}
