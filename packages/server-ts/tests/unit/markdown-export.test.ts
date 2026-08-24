import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { parseMarkdownBlocks, renderDocxBuffer, renderPdfBuffer, loadExportImage } from '../../src/modules/documents/markdown-export.js'

function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanlines = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const off = y * (width * 3 + 1) + 1 + x * 3
      scanlines[off] = 200
      scanlines[off + 1] = 30
      scanlines[off + 2] = 60
    }
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}

describe('#fix markdown-export 图片嵌入导出', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-export-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, 'img_doc1_1.png'), makePng(200, 150))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  const imgUrl = '/api/v1/files/download/img_doc1_1.png?token=x'

  test('parser:独立图片行识别为 image block', () => {
    const blocks = parseMarkdownBlocks(`# 标题\n\n![图 1](${imgUrl})\n\n正文。`)
    const img = blocks.find((b) => b.kind === 'image') as any
    expect(img).toBeTruthy()
    expect(img.url).toBe(imgUrl)
    expect(img.alt).toBe('图 1')
  })

  test('loadExportImage:解析本用户 uploads 内图片,长边 ≤1600 且保持比例', async () => {
    const img = await loadExportImage('u1', imgUrl)
    expect(img).not.toBeNull()
    expect(img!.type).toBe('png')
    expect(img!.width).toBe(200)
    expect(img!.height).toBe(150)
    expect(img!.buffer.length).toBeGreaterThan(100)
  })

  test('loadExportImage:路径穿越/外部 URL/不存在文件 → null', async () => {
    expect(await loadExportImage('u1', '/api/v1/files/download/..%2F..%2Fetc%2Fpasswd')).toBeNull()
    expect(await loadExportImage('u1', 'https://evil.example/x.png')).toBeNull()
    expect(await loadExportImage('u1', '/api/v1/files/download/missing.png')).toBeNull()
  })

  test('loadExportImage:webp 自动转 png(docx/pdfkit 不支持 webp)', async () => {
    const webp = await (await import('sharp')).default(makePng(100, 80)).webp().toBuffer()
    fs.writeFileSync(path.join(uploadsDir, 'img_doc1_2.webp'), webp)
    const img = await loadExportImage('u1', '/api/v1/files/download/img_doc1_2.webp?token=x')
    expect(img).not.toBeNull()
    expect(img!.type).toBe('png')
    expect(img!.buffer[0]).toBe(0x89) // PNG magic
  })

  test('renderDocxBuffer:内嵌图进入 docx 媒体包', async () => {
    const docx = await renderDocxBuffer('Test', `## Results\n\n![图 1](${imgUrl})\n\n结论。`, 'u1')
    const text = docx.toString('latin1')
    // docx 库以 sha 哈希命名媒体文件(word/media/<hash>.png)。
    expect(/word\/media\/[a-f0-9]+\.png/.test(text)).toBe(true)
    expect(text).toContain('png')
  })

  test('renderPdfBuffer:内嵌图进入 PDF 图片对象', async () => {
    const pdf = await renderPdfBuffer('Test', `## Results\n\n![图 1](${imgUrl})\n\n结论。`, 'u1')
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text).toContain('/Subtype /Image')
  })
})
