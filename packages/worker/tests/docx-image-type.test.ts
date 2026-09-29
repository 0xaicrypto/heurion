import { describe, test, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { generateDocx } from '../src/handlers/docx.js'
import { imageDimensionsOf, fitImageBox } from '../src/handlers/image-dimensions.js'
import { detectImageMime } from '../src/handlers/remote-image.js'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

/**
 * #1148 — docx 图片类型/比例:
 *  - 旧实现写死 `type: 'png'` → JPEG/GIF 扩展名与类型错误、SVG 损坏;
 *  - 固定 240×120 拉伸所有图片（比例失真）。
 */

/** 最小可解析尺寸的 PNG（magic + IHDR 宽高；docx 不解码，仅按字节嵌入）。 */
function pngWithSize(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.write('89504e470d0a1a0a', 0, 'hex')
  buf.writeUInt32BE(13, 8) // IHDR length
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(w, 16)
  buf.writeUInt32BE(h, 20)
  return buf
}

/** 最小可解析尺寸的 JPEG（SOI + SOF0 段）。 */
function jpegWithSize(w: number, h: number): Buffer {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2) // segment length
  sof[4] = 8 // precision
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

const webpBuf = (() => {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.write('WEBP', 8, 'ascii')
  return b
})()

const IMG = (buf: Buffer) => ({ type: 'image' as const, ref: 'inline', data: buf.toString('base64') })

async function mediaNames(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer)
  return Object.keys(zip.files).filter((n) => /^word\/media\//.test(n))
}

async function docXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return (await zip.file('word/document.xml')?.async('string')) ?? ''
}

describe('#1148 docx 图片类型与比例', () => {
  test('imageDimensionsOf: PNG/JPEG/GIF/BMP 解析,WebP/SVG null', () => {
    expect(imageDimensionsOf(pngWithSize(100, 400))).toEqual({ width: 100, height: 400 })
    expect(imageDimensionsOf(jpegWithSize(320, 200))).toEqual({ width: 320, height: 200 })
    const gif = Buffer.alloc(10)
    gif.write('GIF8', 0, 'ascii')
    gif.writeUInt16LE(64, 6); gif.writeUInt16LE(32, 8)
    expect(imageDimensionsOf(gif)).toEqual({ width: 64, height: 32 })
    expect(imageDimensionsOf(webpBuf)).toBeNull()
    expect(imageDimensionsOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  test('fitImageBox 等比缩放（100×400 竖图不拉成横幅）', () => {
    const box = fitImageBox({ width: 100, height: 400 }, 480, 360)
    expect(box.height).toBeGreaterThan(box.width) // 竖图保持竖版
    expect(box.height).toBe(360)
    expect(fitImageBox(null)).toEqual({ width: 240, height: 120 })
  })

  test('JPEG 输入以 jpg 类型嵌入（旧实现写死 png）', async () => {
    const res = await generateDocx({ data: { schemaVersion: 1, title: 'T', sections: [{ heading: '图', paragraphs: [IMG(jpegWithSize(100, 50))] }] } })
    const media = await mediaNames((res as { buffer: Buffer }).buffer)
    expect(media.some((n) => n.endsWith('.jpg'))).toBe(true)
    expect(media.some((n) => n.endsWith('.png'))).toBe(false)
  })

  test('竖图按原比例嵌入（wp:extent 宽高比 ≠ 旧固定 2:1）', async () => {
    const res = await generateDocx({ data: { schemaVersion: 1, title: 'T', sections: [{ heading: '图', paragraphs: [IMG(pngWithSize(100, 400))] }] } })
    const xml = await docXml((res as { buffer: Buffer }).buffer)
    const m = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/)
    expect(m).toBeTruthy()
    const [, cx, cy] = m!
    expect(Number(cy)).toBeGreaterThan(Number(cx)) // 竖版保留
  })

  test('WebP 不支持 → 跳过 + 可见注记（不静默损坏）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateDocx({ data: { schemaVersion: 1, title: 'T', sections: [{ heading: '图', paragraphs: [IMG(webpBuf)] }] } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1148'))
    const media = await mediaNames((res as { buffer: Buffer }).buffer)
    expect(media.length).toBe(0)
    const xml = await docXml((res as { buffer: Buffer }).buffer)
    expect(xml).toContain('不支持的图片格式')
    warn.mockRestore()
  })

  test('SVG 带 PNG fallback 嵌入', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    const res = await generateDocx({ data: { schemaVersion: 1, title: 'T', sections: [{ heading: '图', paragraphs: [IMG(svg)] }] } })
    const media = await mediaNames((res as { buffer: Buffer }).buffer)
    expect(media.some((n) => n.endsWith('.svg'))).toBe(true)
  })
})

/**
 * #1150-followup — 未知格式不再被当成 SVG:严格 magic 识别(null)走可见注记。
 */
describe('#1150-followup 未知图片格式', () => {
  test('detectImageMime: 已知 magic → mime;未知 → null', () => {
    expect(detectImageMime(pngWithSize(10, 10))).toBe('image/png')
    expect(detectImageMime(jpegWithSize(10, 10))).toBe('image/jpeg')
    expect(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(detectImageMime(Buffer.from('this is not an image'))).toBeNull()
    expect(detectImageMime(Buffer.from([1, 2, 3]))).toBeNull()
  })

  test('非图片字节 → 跳过 + 可见注记(旧实现误当 SVG 内嵌成损坏图)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateDocx({ data: { schemaVersion: 1, title: 'T', sections: [{ heading: '图', paragraphs: [IMG(Buffer.from('plain text not an image'))] }] } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1148'))
    const media = await mediaNames((res as { buffer: Buffer }).buffer)
    expect(media.length).toBe(0)
    const xml = await docXml((res as { buffer: Buffer }).buffer)
    expect(xml).toContain('不支持的图片格式')
    warn.mockRestore()
  })
})
