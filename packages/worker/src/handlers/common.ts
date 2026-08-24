/**
 * Shared handler plumbing (#686): image resolution and the pdfkit
 * buffer-collection boilerplate were copy-pasted across docx/pptx/pdf/
 * table; the chart palette repeated 3× inside plot.ts.
 */
import PDFDocument from 'pdfkit'
import type { ContentBlock } from '@heurion/contracts'
import { saveFile } from '../storage.js'

export type ImageBlock = ContentBlock & { type: 'image' }

/** Resolve an image block: inline base64 data, or asset://name on disk.
 *  Returns null when unresolvable (renders skip it). */
export async function resolveImage(block: ImageBlock): Promise<{ data: Buffer; caption?: string } | null> {
  if (block.data) {
    const base64 = block.data.startsWith('data:') ? block.data.split(',')[1] || '' : block.data
    return { data: Buffer.from(base64, 'base64'), caption: block.caption }
  }
  if (block.ref.startsWith('asset://')) {
    const name = block.ref.slice('asset://'.length)
    try {
      const { readFile } = await import('node:fs/promises')
      const dir = process.env.ASSET_DIR || '/opt/heurion/assets'
      const data = await readFile(`${dir}/${name}`)
      return { data, caption: block.caption }
    } catch {
      return null
    }
  }
  return null
}

/** Render a pdfkit document and persist it — shared buffer-collection
 *  promise wrapper (was duplicated in pdf.ts and table.ts). */
export function renderPdf(draw: (doc: PDFKit.PDFDocument) => void, fileName: string, mimeType = 'application/pdf') {
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  const buffers: Buffer[] = []
  doc.on('data', (chunk: Buffer) => buffers.push(chunk))

  return new Promise<any>((resolve, reject) => {
    doc.on('end', async () => {
      try {
        const buffer = Buffer.concat(buffers)
        const result = await saveFile(buffer, fileName, mimeType)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
    doc.on('error', reject)
    draw(doc)
    doc.end()
  })
}

/** Chart palette shared by bar/line/pie SVG generation in plot.ts. */
export const PLOT_COLORS = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']
