import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import PDFDocument from 'pdfkit'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, ImageRun } from 'docx'
import { extractTextFromUpload, extractPdfImagesFromUpload, extractDocxContentFromUpload, extractImageUpload, sniffDocumentMime, pdfTextToMarkdown, extractDocumentMarkdownFromUpload, extractDocumentMarkdownWithImagesFromUpload, cachedExtractDocumentMarkdownFromUpload, cachedExtractTextFromUpload } from '../../src/lib/document-extractor.js'
import { buildAttachmentParts, MAX_ATTACHMENT_IMAGES } from '../../src/modules/shared/chat-context.js'

/** 生成一张合法 PNG(RGB,无压缩选项) — 测试用最小实现。 */
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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const scanlines = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 3 + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const off = y * (width * 3 + 1) + 1 + x * 3
      scanlines[off] = 200
      scanlines[off + 1] = 30
      scanlines[off + 2] = 60
    }
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}

/** 生成一个带标题 + 内嵌图片 + 表格文本的 PDF。 */
function makePdfWithImage(): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4' })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.fontSize(16).text('Section Heading')
    doc.image(makePng(200, 150), { fit: [200, 150] })
    doc.fontSize(10).text('columnA\tcolumnB\n1\t2')
    doc.end()
  })
}

/** #fix — 大附件分档处理:>150MB 硬跳过,普通文件正常提取。 */
describe('document-extractor 大附件分档', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-extract-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('超过 150MB 的附件直接跳过提取(防 OOM),返回提示文本', async () => {
    const fileId = '1750000000000_huge.pdf'
    // 先建文件再稀疏截断为 160MB — 立即生成"大文件",不占真实磁盘。
    fs.writeFileSync(path.join(uploadsDir, fileId), '')
    fs.truncateSync(path.join(uploadsDir, fileId), 160 * 1024 * 1024)
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toContain('已跳过文本提取')
    expect(text).toContain('150MB')
  })

  test('普通小文件仍正常提取文本', async () => {
    const fileId = '1750000000001_note.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'plain text content', 'utf-8')
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toBe('plain text content')
  })

  test('文件缺失返回空串(调用方按无附件处理)', async () => {
    expect(await extractTextFromUpload('u1', '1750000000002_missing.txt')).toBe('')
  })
})

describe('document-extractor DOCX 结构化提取', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-docx-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('DOCX 提取为保留标题/加粗/表格的 markdown,而非拍平的纯文字', async () => {
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: '研究背景', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun({ text: '关键结论', bold: true })] }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph('指标')] }), new TableCell({ children: [new Paragraph('数值')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('OS')] }), new TableCell({ children: [new Paragraph('12.4')] })] }),
            ],
          }),
        ],
      }],
    })
    const fileId = '1750000000200_report.docx'
    fs.writeFileSync(path.join(uploadsDir, fileId), await Packer.toBuffer(doc))
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toContain('## 研究背景')
    expect(text).toContain('**关键结论**')
    // GFM 表格:表头 + 分隔行 + 数据行。
    expect(text).toContain('| 指标 | 数值 |')
    expect(text).toContain('| --- | --- |')
    expect(text).toContain('| OS | 12.4 |')
  })

  test('DOCX 转换失败时回退到纯文本提取', async () => {
    const fileId = '1750000000201_broken.docx'
    fs.writeFileSync(path.join(uploadsDir, fileId), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toMatch(/^\[(DOCX extraction failed|DOCX returned empty text)/)
  })

  test('#fix DOCX 内嵌图片抽为多模态 part,正文不含 base64 垃圾', async () => {
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: 'Figure 1 caption' }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: makePng(50, 50), transformation: { width: 50, height: 50 } })] }),
          new Paragraph({ text: 'text after image' }),
        ],
      }],
    })
    const fileId = '1750000000202_with_img.docx'
    fs.writeFileSync(path.join(uploadsDir, fileId), await Packer.toBuffer(doc))

    // 提取路径:正文干净(无 base64),图片单独抽出。
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toContain('Figure 1 caption')
    expect(text).toContain('text after image')
    expect(text).not.toContain('data:image')
    expect(text).toContain('图') // 内嵌图替换为 [图] 占位(turndown 转义方括号)

    const content = await extractDocxContentFromUpload('u1', fileId, { maxChars: 30000, vision: true })
    expect(content).not.toBeNull()
    expect(content!.images.length).toBe(1)
    expect(content!.images[0].mime).toBe('image/png')
    expect(content!.images[0].dataBase64.length).toBeGreaterThan(50)
  })

  test('#fix buildAttachmentParts: DOCX 内嵌图片注入为图片 part(视觉模型)', async () => {
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: 'results section' }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: makePng(50, 50), transformation: { width: 50, height: 50 } })] }),
        ],
      }],
    })
    const fileId = '1750000000203_with_img2.docx'
    fs.writeFileSync(path.join(uploadsDir, fileId), await Packer.toBuffer(doc))

    const vision = await buildAttachmentParts([fileId], { userId: 'u1', vision: true })
    expect(vision.parts.some((p) => p.type === 'image')).toBe(true)
    expect(vision.attachmentText).toContain('results section')
    expect(vision.attachmentText).not.toContain('data:image')
    expect(vision.notes.some((n) => n.includes('内嵌图片 ×1/1'))).toBe(true)

    const textOnly = await buildAttachmentParts([fileId], { userId: 'u1', vision: false })
    expect(textOnly.parts.some((p) => p.type === 'image')).toBe(false)
    expect(textOnly.attachmentText).toContain('results section')
    expect(textOnly.attachmentText).not.toContain('data:image')
  })
})

describe('#fix(参考 opencode) magic bytes 嗅探 + sharp 图片归一化', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-sniff-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('sniffDocumentMime 识别 PNG/PDF/zip(docx) 魔数', () => {
    expect(sniffDocumentMime(makePng(10, 10))).toBe('image/png')
    expect(sniffDocumentMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf')
    expect(sniffDocumentMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe('application/zip')
    expect(sniffDocumentMime(Buffer.from('plain text'))).toBeNull()
  })

  test('伪装扩展名:PDF 改名 .txt 仍按 PDF 解析(不再解码成乱码)', async () => {
    const fileId = '1750000000204_disguised.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdfWithImage())
    const text = await extractTextFromUpload('u1', fileId)
    expect(text).toContain('Section Heading')
  })

  test('无扩展名 PNG 附件被嗅探为图片并注入多模态 part', async () => {
    const fileId = '1750000000205_img.bin'
    fs.writeFileSync(path.join(uploadsDir, fileId), makePng(200, 150))
    const probe = await extractImageUpload('u1', fileId)
    expect(probe).not.toBeNull()
    expect((probe as any).mime).toBe('image/png')

    const res = await buildAttachmentParts([fileId], { userId: 'u1', vision: true })
    expect(res.parts.some((p) => p.type === 'image')).toBe(true)
  })

  test('超过 4MB 的图片自动归一化压缩,不再直接降级', async () => {
    // 高熵 PNG(≈18MB)模拟论文高清图/病理截图。
    const wide = 2600, tall = 2600
    const raw = crypto.randomBytes(wide * tall * 3)
    const bigPng = await (await import('sharp')).default(raw, { raw: { width: wide, height: tall, channels: 3 } })
      .png({ compressionLevel: 6 }).toBuffer()
    expect(bigPng.length).toBeGreaterThan(4 * 1024 * 1024)

    const fileId = '1750000000206_scan.png'
    fs.writeFileSync(path.join(uploadsDir, fileId), bigPng)
    const probe = await extractImageUpload('u1', fileId)
    expect(probe).not.toBeNull()
    expect((probe as any).oversized).toBeUndefined()
    expect((probe as any).normalized).toBe(true)
    expect((probe as any).mime).toBe('image/webp')
    // 压缩后 base64 显著小于原图(远低于 4MB 上限)。
    expect((probe as any).dataBase64.length).toBeLessThan(bigPng.length)
  })
})

describe('#fix 导入格式保留 pdfTextToMarkdown 结构恢复', () => {
  test('英文标题 → ##,跨行段落按行尾标点合并(补空格)', () => {
    const pdf = [
      'Abstract',
      'Background: some first line of the abstract',
      'that continues here without a period at the end',
      'and finishes here.',
      '',
      'Methods',
      'We enrolled patients from 2020 to 2024.',
    ].join('\n')
    const md = pdfTextToMarkdown(pdf)
    expect(md).toContain('## Abstract')
    expect(md).toContain('## Methods')
    expect(md).toContain('Background: some first line of the abstract that continues here without a period at the end and finishes here.')
  })

  test('中文标题与中文段落拼接(不加空格)', () => {
    const md = pdfTextToMarkdown('摘要\n这是摘要的第一行\n继续的第二行。\n\n方法\n这是方法。')
    expect(md).toContain('## 摘要')
    expect(md).toContain('## 方法')
    expect(md).toContain('这是摘要的第一行继续的第二行。')
  })

  test('编号标题识别,普通数字行不被误判', () => {
    const md = pdfTextToMarkdown('1. Introduction\nText.\n\n1.1 Background\nMore text.\n\n10 patients were enrolled.')
    expect(md).toContain('## 1. Introduction')
    expect(md).toContain('## 1.1 Background')
    expect(md).not.toContain('## 10 patients')
    expect(md).toContain('10 patients were enrolled.')
  })

  test('重复标题(页眉/页脚)只保留第一次', () => {
    const md = pdfTextToMarkdown('Methods\ncontent one.\n\nMethods\ncontent two.\n\nDiscussion\nfinal.')
    expect(md).toContain('## Methods')
    expect(md).toContain('content two.')
    expect(md.match(/## Methods/g)!.length).toBe(1)
  })

  test('extractDocumentMarkdownFromUpload:PDF 导入走结构恢复(段落合并)', async () => {
    const tmpDir = path.join(os.tmpdir(), `heurion-mdimport-${Date.now()}`)
    const uploadsDir = path.join(tmpDir, 'u1', 'uploads')
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    try {
      const fileId = '1750000000300_paper.pdf'
      fs.writeFileSync(path.join(uploadsDir, fileId), await makePdfWithImage())
      const md = await extractDocumentMarkdownFromUpload('u1', fileId)
      expect(md.length).toBeGreaterThan(0)
      // pdfkit 无 ToUnicode 会出乱码,标题检测不可靠 — 验证段落合并生效:
      // 原文多行(标题/表格文本)被合并为单个段落(无空行分隔)。
      expect(md.split('\n\n').length).toBe(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.TWIN_BASE_DIR
    }
  })

  test('extractDocumentMarkdownFromUpload:DOCX 保留标题/表格(markdown 结构)', async () => {
    const tmpDir = path.join(os.tmpdir(), `heurion-docximport-${Date.now()}`)
    const uploadsDir = path.join(tmpDir, 'u1', 'uploads')
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    try {
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: '研究背景', heading: HeadingLevel.HEADING_2 }),
            new Table({
              rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph('指标')] }), new TableCell({ children: [new Paragraph('数值')] })] }),
              ],
            }),
          ],
        }],
      })
      const fileId = '1750000000301_report.docx'
      fs.writeFileSync(path.join(uploadsDir, fileId), await Packer.toBuffer(doc))
      const md = await extractDocumentMarkdownFromUpload('u1', fileId)
      expect(md).toContain('## 研究背景')
      expect(md).toContain('| 指标 | 数值 |')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.TWIN_BASE_DIR
    }
  })

  test('#fix 导入图片托管:PDF 内嵌图随 markdown 一起抽出(供落盘渲染)', async () => {
    const tmpDir = path.join(os.tmpdir(), `heurion-pdfimgmd-${Date.now()}`)
    const uploadsDir = path.join(tmpDir, 'u1', 'uploads')
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    try {
      const fileId = '1750000000302_fig.pdf'
      fs.writeFileSync(path.join(uploadsDir, fileId), await makePdfWithImage())
      const { text, images } = await extractDocumentMarkdownWithImagesFromUpload('u1', fileId)
      expect(text.length).toBeGreaterThan(0)
      expect(images.length).toBeGreaterThanOrEqual(1)
      expect(images[0].dataBase64.length).toBeGreaterThan(100)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.TWIN_BASE_DIR
    }
  })

  test('#fix 导入图片托管:DOCX 内嵌图抽出且文本保留 [图] 占位(供替换)', async () => {
    const tmpDir = path.join(os.tmpdir(), `heurion-docximgmd-${Date.now()}`)
    const uploadsDir = path.join(tmpDir, 'u1', 'uploads')
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
    try {
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: 'results section' }),
            new Paragraph({ children: [new ImageRun({ type: 'png', data: makePng(50, 50), transformation: { width: 50, height: 50 } })] }),
            new Paragraph({ text: 'text after image' }),
          ],
        }],
      })
      const fileId = '1750000000303_fig.docx'
      fs.writeFileSync(path.join(uploadsDir, fileId), await Packer.toBuffer(doc))
      const { text, images } = await extractDocumentMarkdownWithImagesFromUpload('u1', fileId)
      expect(text).toContain('results section')
      expect(text).toContain('text after image')
      expect(text).not.toContain('data:image')
      expect(text).toContain('图')
      expect(images.length).toBe(1)
      expect(images[0].mime).toBe('image/png')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.TWIN_BASE_DIR
    }
  })
})

describe('document-extractor PDF 内嵌图片提取', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-pdfimg-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('PDF 内嵌图片被抽出为多模态数据(≥100×100 过滤小图标)', async () => {
    const fileId = '1750000000100_paper.pdf'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdfWithImage())
    const images = await extractPdfImagesFromUpload('u1', fileId)
    expect(images).toBeTruthy()
    expect(images!.length).toBeGreaterThanOrEqual(1)
    expect(images![0].dataBase64.length).toBeGreaterThan(100)
    expect(images![0].mime).toMatch(/^image\/(png|jpeg)$/)
    expect(images![0].page).toBe(1)
    // base64 解码后是有效位图数据(PNG/JPEG magic bytes)。
    const raw = Buffer.from(images![0].dataBase64, 'base64')
    const isPng = raw.length > 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e
    const isJpeg = raw.length > 3 && raw[0] === 0xff && raw[1] === 0xd8
    expect(isPng || isJpeg).toBe(true)
  })

  test('非 PDF 附件返回 null', async () => {
    const fileId = '1750000000101_note.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'plain text', 'utf-8')
    expect(await extractPdfImagesFromUpload('u1', fileId)).toBeNull()
  })

  test('buildAttachmentParts: 视觉模型收到图片 part,文本模型只有文本', async () => {
    const fileId = '1750000000102_paper.pdf'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdfWithImage())
    const vision = await buildAttachmentParts([fileId], { userId: 'u1', vision: true })
    expect(vision.parts.some((p) => p.type === 'image')).toBe(true)
    // pdfkit 默认 Helvetica 用 WinAnsi 编码,无 ToUnicode 映射,部分字符
    // 会被 pdf.js 解码成乱码 — 断言稳定的 ASCII 片段即可(真实 Word/LaTeX
    // PDF 带完整 ToUnicode,不受此影响)。
    expect(vision.attachmentText).toContain('Section Heading')
    expect(vision.notes.some((n) => n.includes('内嵌图片'))).toBe(true)

    const textOnly = await buildAttachmentParts([fileId], { userId: 'u1', vision: false })
    expect(textOnly.parts.some((p) => p.type === 'image')).toBe(false)
    expect(textOnly.attachmentText).toContain('Section Heading')
  })

  test('多张直接上传图片共用数量上限 — 超出降级为文件名说明,不撑爆请求体', async () => {
    const png = makePng(200, 150)
    const ids: string[] = []
    for (let i = 0; i < MAX_ATTACHMENT_IMAGES + 3; i++) {
      const fid = `175000000011${i}_img${i}.png`
      fs.writeFileSync(path.join(uploadsDir, fid), png)
      ids.push(fid)
    }
    const res = await buildAttachmentParts(ids, { userId: 'u1', vision: true })
    const imageParts = res.parts.filter((p) => p.type === 'image')
    expect(imageParts.length).toBe(MAX_ATTACHMENT_IMAGES)
    expect(res.notes.some((n) => n.includes('image skipped — part cap reached'))).toBe(true)
    expect(res.attachmentText).toContain('超出单条消息图片上限')
  })

  test('PDF 内嵌图片与直接上传图片共用配额', async () => {
    const pdfId = '1750000000120_paper.pdf'
    fs.writeFileSync(path.join(uploadsDir, pdfId), await makePdfWithImage())
    const pngId = '1750000000121_extra.png'
    fs.writeFileSync(path.join(uploadsDir, pngId), makePng(200, 150))
    // PDF(1 张内嵌图)+ 8 张直接图 — 超过 8 张上限,整体被裁剪。
    const ids = [pdfId, ...Array.from({ length: MAX_ATTACHMENT_IMAGES }, (_, i) => `175000000012${i + 2}_e${i}.png`).map((f) => {
      fs.writeFileSync(path.join(uploadsDir, f), makePng(200, 150))
      return f
    })]
    const res = await buildAttachmentParts(ids, { userId: 'u1', vision: true })
    const imageParts = res.parts.filter((p) => p.type === 'image')
    expect(imageParts.length).toBeLessThanOrEqual(MAX_ATTACHMENT_IMAGES)
    expect(imageParts.length).toBeGreaterThanOrEqual(1)
  })
})

describe('cachedExtractDocumentMarkdownFromUpload 缓存', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-extract-cache-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('同参数第二次命中缓存,不重新提取;失败结果不缓存', async () => {
    const fileId = '1750000000200_cached.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'Hello cached extraction.', 'utf-8')
    // #914: key 含 mtime(文件版本)— 固定 mtime 使两次调用键稳定。
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(1000000000000), new Date(1000000000000))

    const a = await cachedExtractDocumentMarkdownFromUpload('u1', fileId)
    expect(a).toBe('Hello cached extraction.')

    // 覆盖写入不同内容但 mtime 不变 — 仍命中缓存(证明没重新读盘)。
    fs.writeFileSync(path.join(uploadsDir, fileId), 'changed on disk', 'utf-8')
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(1000000000000), new Date(1000000000000))
    const b = await cachedExtractDocumentMarkdownFromUpload('u1', fileId)
    expect(b).toBe('Hello cached extraction.')

    // 不存在的文件(提取失败)不缓存 — 每次都会重新尝试(返回空)。
    const d1 = await cachedExtractDocumentMarkdownFromUpload('u1', 'nope.txt')
    const d2 = await cachedExtractDocumentMarkdownFromUpload('u1', 'nope.txt')
    expect(d1).toBe('')
    expect(d2).toBe('')
  })
})

describe('#914 提取缓存 key 含文件版本维度(mtime)— 覆盖重写后不拿旧提取', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-extract-cache-ver-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('cachedExtractTextFromUpload: 第二次命中缓存;同一 fileId 覆盖新内容(mtime 推进)→ 重新提取', async () => {
    const fileId = '1750000000600_ver.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'v1 content', 'utf-8')
    // 显式固定 mtime,避免"同毫秒写入"导致的键碰撞不确定性。
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(1000000000000), new Date(1000000000000))

    const a = await cachedExtractTextFromUpload('u1', fileId)
    expect(a).toBe('v1 content')

    // 覆盖写入不同内容但 mtime 不变 — 仍命中缓存(证明没重新读盘)。
    fs.writeFileSync(path.join(uploadsDir, fileId), 'changed on disk', 'utf-8')
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(1000000000000), new Date(1000000000000))
    expect(await cachedExtractTextFromUpload('u1', fileId)).toBe('v1 content')

    // 同一 fileId 被覆盖写入新内容 + mtime 推进 → key 版本变化,重新提取。
    fs.writeFileSync(path.join(uploadsDir, fileId), 'v2 content', 'utf-8')
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(2000000000000), new Date(2000000000000))
    expect(await cachedExtractTextFromUpload('u1', fileId)).toBe('v2 content')
  })

  test('cachedExtractDocumentMarkdownFromUpload 同样带文件版本维度', async () => {
    const fileId = '1750000000601_ver.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'md v1', 'utf-8')
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(1000000000000), new Date(1000000000000))

    expect(await cachedExtractDocumentMarkdownFromUpload('u1', fileId)).toBe('md v1')

    fs.writeFileSync(path.join(uploadsDir, fileId), 'md v2', 'utf-8')
    fs.utimesSync(path.join(uploadsDir, fileId), new Date(2000000000000), new Date(2000000000000))
    expect(await cachedExtractDocumentMarkdownFromUpload('u1', fileId)).toBe('md v2')
  })
})

/**
 * #922 — 手写 LRU 收敛到 lib/lru-cache.ts(MiniLruCache)+ 新增 inflight
 * 去重(参照 tools/external-fetch.ts #860)。用 readFileSync 调用次数作为
 * "是否重新读盘提取"的观测点(txt 路径提取恰好一次 readFileSync)。
 */
describe('#922 提取缓存 MiniLruCache 收敛(命中不读盘 + inflight 合并)', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-extract-lru-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('第二次调用命中缓存 — 不再 readFileSync(不重新读盘)', async () => {
    const fileId = '1750000000700_lru.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'lru cached text', 'utf-8')

    const readSpy = vi.spyOn(fs, 'readFileSync')
    try {
      const a = await cachedExtractTextFromUpload('u1', fileId)
      expect(a).toBe('lru cached text')
      const firstRunReads = readSpy.mock.calls.length
      expect(firstRunReads).toBeGreaterThan(0)

      const b = await cachedExtractTextFromUpload('u1', fileId)
      expect(b).toBe('lru cached text')
      expect(readSpy.mock.calls.length).toBe(firstRunReads)
    } finally {
      readSpy.mockRestore()
    }
  })

  test('同文件并发请求 inflight 合并 — 只读盘提取一次', async () => {
    const fileId = '1750000000701_inflight.txt'
    fs.writeFileSync(path.join(uploadsDir, fileId), 'inflight merged', 'utf-8')

    const readSpy = vi.spyOn(fs, 'readFileSync')
    try {
      const [a, b] = await Promise.all([
        cachedExtractTextFromUpload('u1', fileId),
        cachedExtractTextFromUpload('u1', fileId),
      ])
      expect(a).toBe('inflight merged')
      expect(b).toBe('inflight merged')
      // 两次并发只触发一次提取(txt 路径 = 恰一次 readFileSync)。
      expect(readSpy.mock.calls.length).toBe(1)
    } finally {
      readSpy.mockRestore()
    }
  })
})
