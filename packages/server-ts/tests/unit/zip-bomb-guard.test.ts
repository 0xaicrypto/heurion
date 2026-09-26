import { describe, test, expect, vi, beforeEach } from 'vitest'
import zlib from 'node:zlib'
import { assertZipBombSafe, readZipEntries } from '../../src/lib/zip-reader.js'

/**
 * P0/P1 解压炸弹 — zip 读取器边界 + mammoth 预扫。
 *
 * 修复前：inflateRawSync 无 maxOutputLength，中央目录声明的 uncompressedSize
 * 可以被伪造（声称 64B、实际展开 1MB/1GB）— 直接物化超大 Buffer；docx 走
 * mammoth 更完全没有防护（8G 主机 OOM 现实风险）。
 */

/** 手工构造 ZIP（本地头 + 中央目录 + EOCD），允许伪造声明解压尺寸。 */
function makeZip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; declaredUncompressed?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8')
    const method = e.method ?? 8
    const compressed = method === 8 ? zlib.deflateRawSync(e.data) : e.data
    const declared = e.declaredUncompressed ?? e.data.length

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14) // crc32 — 读取器不校验
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16) // crc32
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(declared, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + compressed.length
  }

  const cdOffset = offset
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, eocd])
}

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
