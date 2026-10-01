import { DOMParser, type Element as XElement } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { LayoutInfo } from '../ops/deck.ts'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** pptx 包里的版式（名称、部件、占位符几何）与页面尺寸。 */
export function readLayouts(pkg: Uint8Array): { layouts: LayoutInfo[]; size: { cx: number; cy: number } } {
  const files = unzipSync(pkg)
  const parse = (name: string) => files[name] ? new DOMParser().parseFromString(strFromU8(files[name]!), 'text/xml') : null
  const pres = parse('ppt/presentation.xml')
  const sz = pres?.getElementsByTagNameNS(P, 'sldSz')[0]
  const size = { cx: Number(sz?.getAttribute('cx') ?? 12192000), cy: Number(sz?.getAttribute('cy') ?? 6858000) }
  const layouts: LayoutInfo[] = []
  const parts = Object.keys(files).filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
  for (const part of parts) {
    const doc = parse(part)
    if (!doc) continue
    const name = doc.getElementsByTagNameNS(P, 'cSld')[0]?.getAttribute('name') ?? part
    const placeholders: LayoutInfo['placeholders'] = []
    const sps = doc.getElementsByTagNameNS(P, 'sp')
    for (let i = 0; i < sps.length; i++) {
      const sp = sps.item(i) as XElement
      const ph = sp.getElementsByTagNameNS(P, 'ph')[0]
      if (!ph) continue
      const off = sp.getElementsByTagNameNS(A, 'off')[0]
      const ext = sp.getElementsByTagNameNS(A, 'ext')[0]
      placeholders.push({
        type: ph.getAttribute('type') ?? 'body',
        idx: ph.getAttribute('idx'),
        x: Number(off?.getAttribute('x') ?? 0), y: Number(off?.getAttribute('y') ?? 0),
        w: Number(ext?.getAttribute('cx') ?? 0), h: Number(ext?.getAttribute('cy') ?? 0),
      })
    }
    layouts.push({ name, part, placeholders })
  }
  return { layouts, size }
}
