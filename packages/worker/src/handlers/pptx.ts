import { saveFile } from '../storage.js'
import PptxGenJS from 'pptxgenjs'
import { SCHEMA_VERSION, validateRenderContent, type ContentBlock, type PresentationContent } from '@heurion/contracts'

const PptxGenJSCtor = PptxGenJS as unknown as new () => any

/**
 * Resolve an image block: inline base64 data, or a file on the worker's
 * asset dir (asset://name). Returns a buffer or null.
 */
async function resolveImage(block: ContentBlock & { type: 'image' }): Promise<{ data: Buffer; caption?: string } | null> {
  if (block.data) {
    const base64 = block.data.startsWith('data:') ? block.data.split(',')[1] || '' : block.data
    return { data: Buffer.from(base64, 'base64'), caption: block.caption }
  }
  if (block.ref.startsWith('asset://')) {
    const name = block.ref.slice('asset://'.length)
    try {
      const { readFile } = await import('node:fs/promises')
      const dir = process.env.ASSET_DIR || '/opt/heurion/assets'
      const buf = await readFile(`${dir}/${name}`)
      return { data: buf, caption: block.caption }
    } catch {
      return null
    }
  }
  return null
}

/**
 * Generator: validated PresentationContent → .pptx. Pure — the same input
 * always renders the same file. Images resolve from refs/data.
 */
export async function generatePptx(payload: any) {
  // The server now sends { schema_version, content_type, data: {schemaVersion,...} }.
  // Accept the legacy { template_id, data: {...} } and flat shapes too.
  let raw = payload?.data ?? payload
  if (raw && typeof raw === 'object' && 'content_type' in payload && !('slides' in raw)) {
    raw = payload.data
  }
  const check = validateRenderContent('sidecar.generate_pptx', raw)
  const input: PresentationContent = check.ok ? (check.data as PresentationContent) : {
    schemaVersion: SCHEMA_VERSION,
    title: String(raw?.title || 'Presentation'),
    slides: [
      { title: '内容', content: [{ type: 'paragraph', text: String(raw?.data?.slides?.[0]?.content || '') }] },
    ],
  }

  const pres = new PptxGenJSCtor()
  pres.defineLayout({ name: 'WIDE', width: 10, height: 5.625 })
  pres.layout = 'WIDE'

  const titleSlide = pres.addSlide()
  titleSlide.addText(input.title, { x: 0.5, y: 1.5, w: 9, h: 1, fontSize: 32, bold: true, align: 'center' })
  if (input.subtitle || input.presenter) {
    titleSlide.addText([input.subtitle || '', input.presenter || ''].filter(Boolean).join(' · '), {
      x: 0.5, y: 2.7, w: 9, h: 0.6, fontSize: 16, align: 'center', color: '666666',
    })
  }

  for (const slide of input.slides) {
    const s = pres.addSlide()
    s.addText(slide.title, { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 26, bold: true })
    let y = 1.1
    for (const block of slide.content) {
      if (block.type === 'paragraph') {
        const opts: Record<string, unknown> = {
          x: 0.5, y, w: 9, h: 0.5, fontSize: 16, valign: 'top', breakLine: false,
        }
        if (block.style === 'heading') { opts.bold = true; opts.fontSize = 18 }
        if (block.style === 'bullet') { opts.bullet = true; opts.fontSize = 15 }
        s.addText(block.text, opts)
        y += 0.55
      } else if (block.type === 'image') {
        const img = await resolveImage(block)
        if (img) {
          try { s.addImage({ data: img.data as any, x: 0.5, y, w: 6, h: 2.8 }) } catch { /* skip broken image */ }
          y += 3
        }
      }
      if (y > 4.8) break
    }
  }

  const buffer = Buffer.from(await pres.write({ outputType: 'nodebuffer' }))
  return saveFile(buffer, 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
}
