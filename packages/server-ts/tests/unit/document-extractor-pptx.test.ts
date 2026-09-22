import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { extractDocumentMarkdownFromUpload, extractTextFromUpload } from '../../src/lib/document-extractor.js'

/**
 * #1104 — extractDocumentMarkdownFromUpload 漏 isPptx 分支回归锁:
 * .pptx(zip 容器)此前直接落到 mammoth(docx)解析 → 空/乱码导入内容。
 * 与 #777(extractDocumentMarkdownWithImagesFromUpload / extractDocumentText)
 * 对齐:pptx 走专用解析器 → slides markdown。
 *
 * fixture:测试内手写 zip(stored 条目,零依赖)— 与 pptx-extractor.test.ts
 * 的 OOXML 结构对齐(presentation.xml sldIdLst 页序 / slideN.xml)。
 */

function crc32(buf: Buffer): number {
  return zlib.crc32(buf)
}

/** 构造一个 zip(stored 条目)— 与标准 ZIP 中央目录布局一致。 */
function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    const nameBuf = Buffer.from(name, 'utf-8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt32LE(0, 8) // method = stored
    local.writeUInt32LE(crc32(dataBuf), 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt32LE(crc32(dataBuf), 16)
    cen.writeUInt32LE(dataBuf.length, 20)
    cen.writeUInt32LE(dataBuf.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const cdStart = offset
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

const TITLE_SHAPE = (text: string) =>
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
const BODY_SHAPE = (paras: string[]) =>
  `<p:sp><p:txBody>${paras.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
const SLIDE_SHELL = (inner: string) =>
  `<?xml version="1.0"?><p:sld xmlns:p="urn:pptx" xmlns:a="urn:main">${inner}</p:sld>`

function buildPptxBuffer(slides: Array<{ title: string; body: string[] }>): Buffer {
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/presentation.xml', data: `<p:presentation>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>` },
  ]
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: SLIDE_SHELL(`${TITLE_SHAPE(s.title)}${BODY_SHAPE(s.body)}`) })
  })
  return buildZip(entries)
}

describe('#1104 pptx 导入提取(extractDocumentMarkdownFromUpload 补 isPptx 分支)', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-pptx-md-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  const fileId = '1750000000400_deck.pptx'
  const pptx = buildPptxBuffer([
    { title: '研究背景', body: ['EGFR 突变 NSCLC', '一线治疗'] },
    { title: '结论', body: ['获益人群需筛选'] },
  ])

  beforeAll(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, fileId), pptx)
  })
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('extractDocumentMarkdownFromUpload:.pptx → slides markdown(## 分节 + 正文)', async () => {
    const md = await extractDocumentMarkdownFromUpload('u1', fileId)
    expect(md).toContain('## 研究背景')
    expect(md).toContain('EGFR 突变 NSCLC')
    expect(md).toContain('## 结论')
    expect(md).toContain('获益人群需筛选')
    // 页标记(与 embedDocumentImages 对齐)
    expect(md).toContain('<!-- page:2 -->')
  })

  test('extractTextFromUpload:.pptx 同走 pptx 解析(不再 mammoth 乱码)', async () => {
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toContain('研究背景')
    expect(text).toContain('EGFR 突变 NSCLC')
  })
})
