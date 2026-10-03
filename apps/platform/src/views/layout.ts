import type { Node as PMNode } from 'prosemirror-model'
import { pt } from '../model/deck-schema.ts'
import { isDecoName } from '../model/deck-templates.ts'
import { hasBullet } from './deck.ts'

/**
 * 版面检查（PLATFORM.md §7 layout_check）：按字号近似估算文字是否溢出形状、形状是否重叠、
 * 是否超出页面、字号是否过小。只是近似（真实排版以 slide_render 为准）。
 */

export interface LayoutIssue { slide: number; shape_id: string; kind: 'overflow' | 'overlap' | 'out_of_bounds' | 'small_font'; detail: string }

const DEFAULT_SIZE: Record<string, number> = { title: 40, ctrTitle: 44, subTitle: 24 }
const BODY_LEVELS = [28, 24, 20, 18, 18]

function fontSizeOf(shape: PMNode, p: PMNode): number {
  let size = 0
  p.forEach(c => {
    if (size || !c.isText) return
    const xml = c.marks.find(m => m.type.name === 'rpr')?.attrs.xml as string | undefined
    const sz = xml ? /\ssz="(\d+)"/.exec(xml)?.[1] : undefined
    if (sz) size = Number(sz) / 100
  })
  if (size) return size
  const ph = shape.attrs.ph as string | null
  if (ph && DEFAULT_SIZE[ph]) return DEFAULT_SIZE[ph]!
  if (ph === 'body' || ph === 'obj') return BODY_LEVELS[p.attrs.lvl as number] ?? 18
  return 18
}

/** 文字宽度（pt）：全角字按 1em，半角按 0.55em。 */
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += /[⺀-￯]/.test(ch) ? size : size * 0.55
  return w
}

export function checkLayout(doc: PMNode, size: { cx: number; cy: number }, slideIds?: string[]): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const W = pt(size.cx)
  const H = pt(size.cy)
  doc.forEach((slide, _o, index) => {
    if (slideIds && !slideIds.includes(slide.attrs.id as string)) return
    const boxes: Array<{ id: string; x: number; y: number; w: number; h: number }> = []
    slide.forEach(shape => {
      if (shape.type.name !== 'shape') return
      if (isDecoName(shape.attrs.name)) return // 模板装饰（可以有意出血到页外）
      const id = shape.attrs.id as string
      const x = pt(shape.attrs.x as number), y = pt(shape.attrs.y as number)
      const w = pt(shape.attrs.w as number), h = pt(shape.attrs.h as number)
      if (w <= 0 || h <= 0) return
      if (x < -2 || y < -2 || x + w > W + 2 || y + h > H + 2) {
        issues.push({ slide: index + 1, shape_id: id, kind: 'out_of_bounds', detail: `形状 (${x}, ${y}, ${w}×${h}) 超出页面 ${W}×${H}` })
      }
      if (shape.attrs.kind !== 'text' || !shape.textContent.trim()) return
      boxes.push({ id, x, y, w, h })
      const autofit = /normAutofit|spAutoFit/.test(String(shape.attrs.body_pr ?? ''))
      const inner = Math.max(10, w - 14)
      let height = 7
      let smallest = 99
      shape.forEach(p => {
        if (p.type.name !== 'paragraph') return
        const s = fontSizeOf(shape, p)
        smallest = Math.min(smallest, s)
        const indent = (p.attrs.lvl as number) * 18 + (hasBullet(shape, p) ? 18 : 0)
        const lines = p.textContent.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(textWidth(line, s) / Math.max(10, inner - indent))), 0)
        height += lines * s * 1.2 + s * 0.3
      })
      if (height > h * 1.08) {
        issues.push({ slide: index + 1, shape_id: id, kind: 'overflow', detail: `文字约需 ${Math.round(height)}pt 高，形状只有 ${h}pt${autofit ? '（开启了自动缩放，文字会被缩小）' : ''}` })
      }
      if (smallest < 12) issues.push({ slide: index + 1, shape_id: id, kind: 'small_font', detail: `最小字号 ${smallest}pt，投影时难以阅读` })
    })
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        const smaller = Math.min(a.w * a.h, b.w * b.h)
        if (smaller > 0 && (ix * iy) / smaller > 0.2) {
          issues.push({ slide: index + 1, shape_id: b.id, kind: 'overlap', detail: `与形状 {#${a.id}} 重叠 ${Math.round((ix * iy) / smaller * 100)}%` })
        }
      }
    }
  })
  return issues
}
