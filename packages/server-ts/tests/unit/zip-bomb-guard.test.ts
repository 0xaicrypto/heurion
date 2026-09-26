import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { assertZipBombSafe, readZipEntries } from '../../src/lib/zip-reader.js'
import { extractDocxContentFromUpload } from '../../src/lib/document-extractor.js'
import { uploadsBaseDir } from '../../src/lib/upload-path.js'
import { makeZip } from '../helpers/make-zip.js'

/**
 * P0/P1 解压炸弹 — zip 读取器边界 + mammoth 预扫。
 *
 * 修复前：inflateRawSync 无 maxOutputLength，中央目录声明的 uncompressedSize
 * 可以被伪造（声称 64B、实际展开 1MB/1GB）— 直接物化超大 Buffer；docx 走
 * mammoth 更完全没有防护（8G 主机 OOM 现实风险）。
 */

describe('P1 zip 炸弹: 有界解压', () => {
  test('伪造声明尺寸（64B 实展开 1MB）→ 解压中途拒绝，不物化超大 Buffer', () => {
    const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(1024 * 1024, 0x41), method: 8, declaredUncompressed: 64 }])
    expect(() => assertZipBombSafe(bomb, { maxTotalUncompressed: 4 * 1024 * 1024 }))
      .toThrow(/expands beyond|size mismatch/)
  })

  test('声明总解压量超上限 → 拒绝（不做解压）', () => {
    const bomb = makeZip([{ name: 'a.bin', data: Buffer.alloc(2 * 1024 * 1024, 0x42), method: 8 }])
    expect(() => assertZipBombSafe(bomb, { maxTotalUncompressed: 1024 })).toThrow(/zip expands beyond/)
  })

  test('正常条目/正常调用不受影响（数据保留、尺寸一致）', () => {
    const ok = makeZip([{ name: 'word/document.xml', data: Buffer.from('<w:document>hi</w:document>'), method: 8 }])
    const entries = readZipEntries(ok)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('word/document.xml')
    expect(entries[0].data.toString('utf-8')).toContain('hi')
    expect(() => assertZipBombSafe(ok)).not.toThrow()
  })
})

/**
 * docx 路径：炸弹必须先被预扫拦下，绝不进入 mammoth（第三方解压器零上限）。
 */
const mammothMocks = vi.hoisted(() => ({
  convertToHtml: vi.fn(),
  extractRawText: vi.fn(),
}))

vi.mock('mammoth', () => ({
  default: {
    convertToHtml: mammothMocks.convertToHtml,
    extractRawText: mammothMocks.extractRawText,
  },
}))

import { extractDocumentText } from '../../src/lib/document-extractor.js'

describe('P1 docx 炸弹: mammoth 前预扫', () => {
  beforeEach(() => {
    mammothMocks.convertToHtml.mockReset()
    mammothMocks.extractRawText.mockReset()
    mammothMocks.convertToHtml.mockResolvedValue({ value: '<p>ok</p>' })
    mammothMocks.extractRawText.mockResolvedValue({ value: 'ok' })
  })

  test('伪造尺寸的 .docx → 预扫拒绝，mammoth 一次都不调用', async () => {
    const bomb = makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 8 },
      { name: 'word/document.xml', data: Buffer.alloc(512 * 1024, 0x41), method: 8, declaredUncompressed: 64 },
    ])
    const text = await extractDocumentText(bomb, 'bomb.docx')
    expect(text).toContain('DOCX extraction failed')
    expect(mammothMocks.convertToHtml).not.toHaveBeenCalled()
    expect(mammothMocks.extractRawText).not.toHaveBeenCalled()
  })

  test('正常 docx → 预扫放行，mammoth 正常提取', async () => {
    const ok = makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 8 },
      { name: 'word/document.xml', data: Buffer.from('<w:document>hello</w:document>'), method: 8 },
    ])
    const text = await extractDocumentText(ok, 'ok.docx')
    expect(text).toContain('ok')
    expect(mammothMocks.convertToHtml).toHaveBeenCalledTimes(1)
  })
})

/**
 * #1129 — vision 路径炸弹防护绕过: extractDocxContentFromUpload 此前在
 * 文本侧失败后仍会对同一 buffer 二次 mammoth.convertToHtml(图片提取),
 * 炸弹在这条路径被完整解压。修复: 入口统一预扫,任何 mammoth 之前拒绝。
 */
describe('#1129 vision 路径: 炸弹 docx 预扫前置', () => {
  const userId = `u1129_${Date.now()}`
  const fileId = 'bomb.docx'
  const filepath = path.join(uploadsBaseDir(userId), fileId)

  beforeEach(() => {
    mammothMocks.convertToHtml.mockReset()
    mammothMocks.extractRawText.mockReset()
    mammothMocks.convertToHtml.mockResolvedValue({ value: '<p>ok</p>' })
  })

  test('vision=true 上传炸弹 docx → 拒绝且 mammoth 一次都不调用', async () => {
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    // 伪造声明尺寸(64B 实展开 512KB) — 文本侧会拒绝,修复前图片侧照常解压
    const bomb = makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 8 },
      { name: 'word/document.xml', data: Buffer.alloc(512 * 1024, 0x41), method: 8, declaredUncompressed: 64 },
    ])
    fs.writeFileSync(filepath, bomb)
    try {
      const res = await extractDocxContentFromUpload(userId, fileId, { maxChars: 1000, vision: true })
      expect(res?.text).toContain('DOCX extraction failed')
      expect(res?.images).toEqual([])
      expect(mammothMocks.convertToHtml).not.toHaveBeenCalled()
      expect(mammothMocks.extractRawText).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(path.dirname(filepath), { recursive: true, force: true })
    }
  })

  test('vision=true 正常 docx → 文本与图片输出照常(不误伤)', async () => {
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    const okDoc = makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 8 },
      { name: 'word/document.xml', data: Buffer.from('<w:document>hello</w:document>'), method: 8 },
    ])
    fs.writeFileSync(filepath, okDoc)
    try {
      const res = await extractDocxContentFromUpload(userId, fileId, { maxChars: 1000, vision: true })
      expect(res?.text).toContain('ok')
      expect(mammothMocks.convertToHtml).toHaveBeenCalled()
    } finally {
      fs.rmSync(path.dirname(filepath), { recursive: true, force: true })
    }
  })
})
