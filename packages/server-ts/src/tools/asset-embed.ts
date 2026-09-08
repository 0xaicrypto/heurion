/**
 * Asset image embedding (#789②) — uploads-dir image resolution extracted
 * from insert-asset-tool.ts. File I/O (fs/sharp) but no prisma; shared by
 * the faithful-export and organized-deck paths.
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { uploadsBaseDir } from '../lib/upload-path.js'

/**
 * #769 — 契约内容模型里的图片 markdown 段落 → 内嵌 base64 image block
 * （worker pptx/docx 渲染器均已消费 image block，零 worker 改动）。
 * URL 只在本用户 uploads 目录内解析（取 path basename，防目录穿越）；
 * 文件缺失/不可读时保留原段落（worker 渲染文本，不产生半截文件）。
 */
export async function embedContentImages(userId: string, blocks: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for (const b of blocks) {
    if (b.type !== 'paragraph') { out.push(b); continue }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(String(b.text || ''))
    if (!img) { out.push(b); continue }
    out.push((await resolveLocalImageBlock(userId, img[2], img[1])) || b)
  }
  return out
}

/** #772 — 把 bullets 里的 ![caption](托管URL) 解析为内嵌 base64 图片块。
 *  URL 只在本用户 uploads 目录内解析（取 path basename，防目录穿越）；
 *  文件不存在返回 null（跳过该块，由调用方计数注记）。
 *  #fix 2026-09: SVG 图表不能按原字节嵌入 — worker docx/pptx 把图片统一
 *  声明为 PNG，SVG 字节被 Word/PowerPoint 按位图解析 → diagram 内中文
 *  成方块。服务端 sharp 栅格化为 PNG（本容器有 Droid CJK 字体，中文
 *  正确渲染；density 150 保证清晰度）。 */
export async function resolveLocalImageBlock(userId: string, url: string, caption: string): Promise<{ type: 'image'; ref: string; caption?: string; data: string } | null> {
  const name = path.basename(url.split('?')[0] || '')
  const p = path.join(uploadsBaseDir(userId), name)
  try {
    if (!name || !fs.existsSync(p)) return null
    let buf = fs.readFileSync(p)
    if (name.toLowerCase().endsWith('.svg')) {
      buf = await sharp(buf, { density: 150 }).png().toBuffer()
    }
    return { type: 'image', ref: url.slice(0, 500), caption: caption ? caption.slice(0, 500) : undefined, data: buf.toString('base64') }
  } catch {
    return null
  }
}
