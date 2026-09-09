/**
 * Shared handler plumbing (#686): image resolution and the pdfkit
 * buffer-collection boilerplate were copy-pasted across docx/pptx/pdf/
 * table; the chart palette repeated 3× inside plot.ts.
 */
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import type { ContentBlock } from '@heurion/contracts'
import { saveFile } from '../storage.js'

export type ImageBlock = ContentBlock & { type: 'image' }

/** #fix 2026-09: PDF 导出中文全是方块 — pdfkit 默认 Helvetica 无 CJK 字形。
 *  注册单面 .ttf 中文字体并设为默认。注意 pdfkit 不能嵌 .ttc 集合
 *  （fonts-noto-cjk 全是 .ttc），必须用 fonts-droid-fallback 的单面 ttf。
 *  #928: 只保留单面 .ttf 候选 — 此前的 .ttc 候选在 pdfkit 里命中即延迟
 *  失败（registerFont 解析 .ttc 集合在渲染期才炸），移除。
 *  返回是否成功注册；找不到字体时保持 Helvetica（拉丁正常,降级为服务器
 *  缺字体的部署），调用方据此决定能否引用 'cjk' 字体名。 */
const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
]
export function applyCjkFont(doc: PDFKit.PDFDocument): boolean {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        doc.registerFont('cjk', p)
        doc.font('cjk')
        return true
      }
    } catch { /* keep probing */ }
  }
  return false
}

/** Resolve an image block: inline base64 data, or asset://name on disk.
 *  Returns null when unresolvable (renders skip it). */
export async function resolveImage(block: ImageBlock): Promise<{ data: Buffer; caption?: string } | null> {
  if (block.data) {
    const base64 = block.data.startsWith('data:') ? block.data.split(',')[1] || '' : block.data
    return { data: Buffer.from(base64, 'base64'), caption: block.caption }
  }
  if (block.ref.startsWith('asset://')) {
    const name = block.ref.slice('asset://'.length)
    // #900: asset name is untrusted input — `../.env` would read arbitrary
    // files from the worker FS. Reject separators/dot-segments/NUL up front,
    // then basename + resolve-inside-dir as a second gate. Unresolvable →
    // null (renders skip the block, same as a missing file).
    const base = path.basename(name)
    if (!base || base === '.' || base === '..' || base.includes('..') || /[/\\\0]/.test(name)) {
      return null
    }
    try {
      const { readFile } = await import('node:fs/promises')
      const dir = path.resolve(process.env.ASSET_DIR || '/opt/heurion/assets')
      const target = path.resolve(dir, base)
      if (!target.startsWith(dir + path.sep)) return null
      const data = await readFile(target)
      return { data, caption: block.caption }
    } catch {
      return null
    }
  }
  return null
}

/** Render a pdfkit document and persist it — shared buffer-collection
 *  promise wrapper (was duplicated in pdf.ts and table.ts).
 *  #928: draw 回调第二参数声明 'cjk' 字体是否可用 — 缺字体部署里
 *  doc.font('cjk') 会抛（未注册字体名），调用方须条件使用。 */
export function renderPdf(draw: (doc: PDFKit.PDFDocument, hasCjk: boolean) => void, fileName: string, mimeType = 'application/pdf') {
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  const hasCjk = applyCjkFont(doc)
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
    draw(doc, hasCjk)
    doc.end()
  })
}

/** Chart palette shared by bar/line/pie SVG generation in plot.ts. */
export const PLOT_COLORS = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']
