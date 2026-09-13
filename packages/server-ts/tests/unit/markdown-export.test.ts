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

/** 读取 docx(zip) 内单个条目的明文 — 校验 document.xml/numbering.xml 用。 */
function readDocxEntry(buffer: Buffer, entryName: string): string | null {
  const sig = Buffer.from('PK\x03\x04', 'binary')
  let off = 0
  while ((off = buffer.indexOf(sig, off)) !== -1) {
    const method = buffer.readUInt16LE(off + 8)
    const compSize = buffer.readUInt32LE(off + 18)
    const nameLen = buffer.readUInt16LE(off + 26)
    const extraLen = buffer.readUInt16LE(off + 28)
    const name = buffer.slice(off + 30, off + 30 + nameLen).toString('utf8')
    const dataStart = off + 30 + nameLen + extraLen
    if (name === entryName) {
      const data = buffer.slice(dataStart, dataStart + compSize)
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8')
    }
    off = dataStart + compSize
  }
  return null
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

describe('#review 导出列表编号(references 全为 1 的回归锁)', () => {
  const REFS_LOOSE = ['## References', '', '1. Smith J. First paper.', '', '2. Doe A. Second paper.', '', '3. Roe B. Third paper.'].join('\n')

  test('parser:空行分隔的 ordered/bullet 归入同一列表(loose list)', () => {
    const ordered = parseMarkdownBlocks(REFS_LOOSE)
    const o = ordered.find((b) => b.kind === 'ordered') as { items: string[] } | undefined
    expect(o?.items).toHaveLength(3)
    expect(o?.items[2]).toContain('Roe B.')

    const bullets = parseMarkdownBlocks('- a\n\n- b\n\n- c')
    const b = bullets.find((x) => x.kind === 'bullet') as { items: string[] } | undefined
    expect(b?.items).toEqual(['a', 'b', 'c'])
  })

  test('parser:列表之间的普通段落仍截断列表(不吞正文)', () => {
    const blocks = parseMarkdownBlocks('1. one\n\nafter\n\n1. two')
    expect(blocks.filter((x) => x.kind === 'ordered')).toHaveLength(2)
    expect(blocks.some((x) => x.kind === 'paragraph' && x.text === 'after')).toBe(true)
  })

  test('renderDocxBuffer:ordered 用真实 numId + decimal 编号,不再有无效占位/字面编号', async () => {
    const docx = await renderDocxBuffer('T', REFS_LOOSE)
    const doc = readDocxEntry(docx, 'word/document.xml')
    expect(doc).not.toBeNull()
    // 无效占位 numId({ordered-0})不再出现 — 全部替换为数字
    expect(doc).not.toContain('{ordered-')
    const numIds = [...doc!.matchAll(/<w:numId w:val="([^"]*)"/g)].map((m) => m[1])
    expect(numIds).toHaveLength(3)
    expect(numIds.every((id) => /^\d+$/.test(id))).toBe(true)
    // 不再拼字面 "1. " 前缀(否则与自动编号双重)
    expect(doc).not.toContain('>1. </w:t>')
    // numbering.xml 中存在 decimal 有序定义
    const numbering = readDocxEntry(docx, 'word/numbering.xml')
    expect(numbering).toContain('w:numFmt w:val="decimal"')
    expect(numbering).toContain('w:lvlText w:val="%1."')
  })

  test('renderDocxBuffer:两个独立有序列表各自从新 instance 开始编号', async () => {
    const docx = await renderDocxBuffer('T', ['1. a', '2. b', '', '段落', '', '1. c', '2. d'].join('\n'))
    const doc = readDocxEntry(docx, 'word/document.xml')!
    const numIds = [...doc.matchAll(/<w:numId w:val="([^"]*)"/g)].map((m) => m[1])
    expect(numIds).toHaveLength(4)
    // 两个列表 → 两个不同的 concrete numbering(各自从 1 开始)
    expect(new Set(numIds).size).toBe(2)
  })

  test('parser:无空行的连续行归入同一段落(soft wrap);空行仍分段', () => {
    const blocks = parseMarkdownBlocks('第一行\n第二行\n\n另起一段\n第三行')
    const paras = blocks.filter((b) => b.kind === 'paragraph') as Array<{ text: string }>
    expect(paras.map((p) => p.text)).toEqual(['第一行 第二行', '另起一段 第三行'])
  })

  test('renderDocxBuffer:[text](https url) 生成真实超链接;非安全 scheme 退化纯文本', async () => {
    const docx = await renderDocxBuffer('T', '参考 [NEJM 研究](https://www.nejm.org/doi/10.1056/abc) 与 [坏链](javascript:void)。')
    const doc = readDocxEntry(docx, 'word/document.xml')!
    expect(doc).toContain('w:hyperlink')
    expect(doc).not.toContain('javascript:')
    // markdown 语法不再原样出现在正文
    expect(doc).not.toContain('[NEJM 研究]')
    expect(doc).not.toContain('](https://')
    const rels = readDocxEntry(docx, 'word/_rels/document.xml.rels') ?? ''
    expect(rels).toContain('https://www.nejm.org/doi/10.1056/abc')
  })

  test('renderDocxBuffer:H4-H6 保持层级(不再统一压成 Heading3)', async () => {
    const docx = await renderDocxBuffer('T', '#### H4 细节\n\n###### H6 细节')
    const doc = readDocxEntry(docx, 'word/document.xml')!
    expect(doc).toContain('w:val="Heading4"')
    expect(doc).toContain('w:val="Heading6"')
  })
})
