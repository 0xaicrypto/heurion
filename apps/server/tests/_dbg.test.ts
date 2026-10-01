import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { it } from 'vitest'
import { buildProjection, reconcilePptxIds } from '../src/docs/office.ts'

it('dbg pptx reconcile', () => {
  const slide = (title: string, id: string) =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T"/><p:cNvSpPr/></p:nvSpPr>` +
    `<p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`
  const proj1 = buildProjection('pptx', zipSync({ 'ppt/slides/slide1.xml': strToU8(slide('终点', '2')) }))
  const lo = zipSync({ 'ppt/slides/slide1.xml': strToU8(slide('终点', '82')) })
  const r = reconcilePptxIds(proj1, lo)
  console.log('out xml:', strFromU8(unzipSync(r.bytes)['ppt/slides/slide1.xml']!))
})
