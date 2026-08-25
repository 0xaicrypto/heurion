import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import PDFDocument from 'pdfkit'

// mock 视觉 provider — 返回固定 LaTeX(真实模型输出由生产验证)。
const fakeVision = vi.fn(async () => ({ content: '$$E = mc^2$$\n\n$$C_{\\mathrm{total}} = \\sum_i E_i \\cdot \\mathrm{PUE}_i \\cdot \\mathrm{EF}_i$$' }))
vi.mock('../../src/common/ai/ai-provider.js', () => ({
  createAiProvider: () => ({ vision: fakeVision }),
}))

import { extractFormulasFromPdf } from '../../src/lib/pdf-formula.js'

describe('extractFormulasFromPdf(方案 A 公式 OCR)', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-formula-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
    delete process.env.PDF_FORMULA_OCR
    vi.clearAllMocks()
  })

  async function makePdf(pages: number): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4' })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<void>((resolve) => doc.on('end', () => resolve()))
    for (let i = 1; i <= pages; i++) {
      doc.fontSize(16).text(`Section ${i}: Formula page`, { align: 'center' })
      doc.moveDown()
      doc.fontSize(12).text(`The key equation on page ${i} is shown below.`)
      doc.fontSize(14).text('E = mc^2  and  C = sum(Ei * PUEi * EFi)', { align: 'center' })
      if (i < pages) doc.addPage()
    }
    doc.end()
    await done
    return Buffer.concat(chunks)
  }

  test('提取公式 → 返回 ## 公式 段(按页分组,含 LaTeX)', async () => {
    const fileId = '1750000000300_paper.pdf'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdf(2))

    const out = await extractFormulasFromPdf('u1', fileId)
    expect(out).toContain('## 公式')
    expect(out).toContain('（第 1 页）')
    expect(out).toContain('（第 2 页）')
    expect(out).toContain('$$E = mc^2$$')
    // 视觉调用次数 = 页数(2)。
    expect(fakeVision).toHaveBeenCalledTimes(2)
    expect(fakeVision.mock.calls[0][0][0].mimeType).toBe('image/png')
    expect(fakeVision.mock.calls[0][0][0].base64.length).toBeGreaterThan(100)
  })

  test('视觉返回 NONE → 无公式段', async () => {
    fakeVision.mockResolvedValue({ content: 'NONE' })
    const fileId = '1750000000301_none.pdf'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdf(1))

    const out = await extractFormulasFromPdf('u1', fileId)
    expect(out).toBe('')
  })

  test('PDF_FORMULA_OCR=0 关闭;文件不存在返回空', async () => {
    process.env.PDF_FORMULA_OCR = '0'
    const fileId = '1750000000302_off.pdf'
    fs.writeFileSync(path.join(uploadsDir, fileId), await makePdf(1))
    expect(await extractFormulasFromPdf('u1', fileId)).toBe('')
    expect(await extractFormulasFromPdf('u1', 'missing.pdf')).toBe('')
  })
})
