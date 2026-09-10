/**
 * #960 — deck v2 chart/figure block → image block 转换（导出边界）。
 * chart spec → SVG（确定性 #176 管线，零生成式模型）；figure 源码
 * （mermaid/latex）→ figures #820 产物 SVG → PNG base64（docx/pptx
 * 按 PNG 声明的口径，见 asset-embed.ts #fix 注释）。worker 零改动。
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { uploadsBaseDir } from '../lib/upload-path.js'
import { renderSvgChart, type ChartInput } from './chart-renderer.js'

/** chart spec → SVG 字符串（渲染失败返回 null，调用方降级）。 */
export function chartSpecSvg(spec: ChartInput): string | null {
  try {
    return renderSvgChart(spec)
  } catch {
    return null
  }
}

/** chart spec → PNG base64（SVG 经 sharp 光栅化，中文/公式正确渲染）。 */
export async function chartSpecPng(spec: ChartInput): Promise<string | null> {
  const svg = chartSpecSvg(spec)
  if (!svg) return null
  try {
    const png = await sharp(Buffer.from(svg), { density: 150 }).png().toBuffer()
    return png.toString('base64')
  } catch {
    return null
  }
}

/** figures 产物 SVG → PNG base64（本容器 Droid CJK 字体，中文正确栅格化）。 */
export async function resolveFigureSvg(userId: string, fileId: string): Promise<string | null> {
  const p = path.join(uploadsBaseDir(userId), path.basename(fileId))
  try {
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p)
    const png = await sharp(buf, { density: 150 }).png().toBuffer()
    return png.toString('base64')
  } catch {
    return null
  }
}
