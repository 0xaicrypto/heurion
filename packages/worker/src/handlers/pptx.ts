import { saveFile } from '../storage.js'
import PptxGenJS from 'pptxgenjs'

// pptxgenjs ships CJS with its own typings; the default export is the constructor.
const PptxGenJSCtor = PptxGenJS as unknown as new () => any

export interface PptxSlide {
  title?: string
  bullets?: string[]
  content?: string
}

export interface PptxInput {
  title?: string
  slides?: PptxSlide[]
}

/**
 * Sidecar/plugin jobs arrive as { template_id, data: {...}, output_name }.
 * The actual slide content lives under `data`, so unwrap it before rendering
 * (also tolerates a flat { title, slides } payload for direct callers).
 */
function unwrapPayload(payload: any): Record<string, unknown> {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data
  }
  return payload || {}
}

export async function generatePptx(payload: any) {
  const input = unwrapPayload(payload) as PptxInput
  const pres = new PptxGenJSCtor()

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

  const buffer = Buffer.from(await pres.write({ outputType: 'nodebuffer' }))
  return saveFile(buffer, 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
}
