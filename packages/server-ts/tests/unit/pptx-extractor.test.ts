import { describe, test, expect } from 'vitest'
import zlib from 'zlib'
import { readZipEntries, ZipReadError } from '../../src/lib/zip-reader.js'
import { parsePptx, pptxSlidesToMarkdown, pptxSlidesToDeck } from '../../src/lib/pptx-extractor.js'

/**
 * #777 — pptx 解析导入单元测试。
 * fixture：测试内手写 zip（stored 条目，零依赖）— 与真实 pptx 的
 * OOXML 结构（presentation.xml sldIdLst 页序 / slideN.xml / rels /
 * notesSlides / media）对齐，覆盖解析边界与安全约束。
 */

function crc32(buf: Buffer): number {
  return zlib.crc32(buf)
}

/** 构造一个 zip（stored 条目）— 与标准 ZIP 中央目录布局一致。 */
function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    const nameBuf = Buffer.from(name, 'utf-8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt32LE(crc32(dataBuf), 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0, 8) // flags
    cen.writeUInt16LE(0, 10) // method
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

interface FixtureSlide { title: string; body: string[]; notes?: string; xml?: string; rels?: string }

function buildPptxBuffer(slides: FixtureSlide[], opts: { presentation?: string } = {}): Buffer {
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/presentation.xml', data: opts.presentation ?? `<p:presentation>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>` },
  ]
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: s.xml ?? SLIDE_SHELL(`${TITLE_SHAPE(s.title)}${BODY_SHAPE(s.body)}`) })
    if (s.rels) entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: s.rels })
    if (s.notes) {
      entries.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: SLIDE_SHELL(`<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp>`) })
    }
  })
  return buildZip(entries)
}

describe('#777 zip-reader（零依赖）', () => {
  test('读取 stored 条目（解压/过滤/顺序）', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.bin', data: Buffer.from([1, 2, 3, 4]) },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin'])
    expect(entries[0].data.toString()).toBe('hello')
    expect(entries[1].data).toEqual(Buffer.from([1, 2, 3, 4]))
    const filtered = readZipEntries(zip, { filter: (n) => n === 'dir/b.bin' })
    expect(filtered).toHaveLength(1)
  })

  test('非 zip / 条目数超限 → ZipReadError', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(ZipReadError)
    const zip = buildZip([{ name: 'a', data: 'x' }])
    expect(() => readZipEntries(zip, { maxEntries: 0 })).toThrow(ZipReadError)
  })

  test('加密 zip（gp flag bit 0）→ 可读错误', () => {
    const data = Buffer.from('secret')
    const nameBuf = Buffer.from('a.txt')
    const local = Buffer.alloc(30 + nameBuf.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(1, 6) // encrypted flag
    local.set(nameBuf, 30)
    // 手工拼一个标记了加密位的 zip（中央目录同样置位）。
    const cen = Buffer.alloc(46 + nameBuf.length)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(1, 8)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(0, 42)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cen.length, 12)
    eocd.writeUInt32LE(local.length, 16)
    const zip = Buffer.concat([local, cen, eocd])
    expect(() => readZipEntries(zip)).toThrow(/加密/)
  })
})

describe('#777 parsePptx', () => {
  test('标题/正文/页序（sldIdLst 权威序）/notes 提取', () => {
    const buf = buildPptxBuffer([
      { title: '研究背景', body: ['EGFR 突变 NSCLC', '一线治疗'], notes: '开场 30 秒' },
      { title: '关键结果', body: ['中位 PFS 5.2 个月'] },
    ])
    const result = parsePptx(buf)
    expect(result.ok).toBe(true)
    expect(result.slides.map((s) => s.title)).toEqual(['研究背景', '关键结果'])
    expect(result.slides[0].paragraphs).toEqual(['EGFR 突变 NSCLC', '一线治疗'])
    expect(result.slides[0].notes).toBe('开场 30 秒')
  })

  test('sldIdLst 顺序与文件名顺序不一致 → 以 sldIdLst 为准', () => {
    const buf = buildPptxBuffer([
      { title: '第一页', body: [] },
      { title: '第二页', body: [] },
    ], {
      presentation: '<p:presentation><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:presentation>',
    })
    const result = parsePptx(buf)
    expect(result.slides.map((s) => s.title)).toEqual(['第二页', '第一页'])
  })

  test('实体解码 + 无标题页兜底「第 N 页」', () => {
    const buf = buildPptxBuffer([
      { title: 'A &amp; B', body: [] },
      { title: '', body: ['x'], xml: SLIDE_SHELL(BODY_SHAPE(['只有正文'])) },
    ])
    const result = parsePptx(buf)
    expect(result.slides[0].title).toBe('A & B')
    expect(result.slides[1].title).toBe('第 2 页')
  })

  test('表格/图表占位注记（不静默丢内容）', () => {
    const xml = SLIDE_SHELL(`${TITLE_SHAPE('数据页')}<p:graphicFrame><a:tbl><a:tr><a:tc/></a:tr></a:tbl></p:graphicFrame>`)
    const buf = buildPptxBuffer([{ title: 'x', body: [], xml }])
    const result = parsePptx(buf)
    expect(result.ok).toBe(true)
    expect(result.slides[0].paragraphs).toContain('[本页含表格，未解析]')
  })

  test('损坏/非 zip 输入 → ok:false 可读错误（不抛出）', () => {
    const result = parsePptx(Buffer.from('this is not a pptx'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法解析 PPTX')
  })

  test('media 图片按页关联提取', () => {
    const png = Buffer.from('fake-png')
    const rels = '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>'
    const buf = buildPptxBuffer([
      { title: '有图页', body: [], rels },
      { title: '无图页', body: [] },
    ], {
      presentation: '<p:presentation><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:presentation>',
    })
    // buildPptxBuffer 不含 media — 手动追加。
    const withMedia = buildZip([...Array.from(readZipEntries(buf)).map((e) => ({ name: e.name, data: e.data })), { name: 'ppt/media/image1.png', data: png }])
    const result = parsePptx(withMedia)
    expect(result.ok).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ mime: 'image/png', page: 1 })
  })
})

describe('#777 双落点转换', () => {
  test('pptxSlidesToMarkdown：## 分节 + 页标记（embedDocumentImages 兼容）', () => {
    const parsed = parsePptx(buildPptxBuffer([
      { title: '研究背景', body: ['EGFR 突变 NSCLC'] },
      { title: '结论', body: ['获益需筛选'] },
    ]))
    const md = pptxSlidesToMarkdown(parsed)
    expect(md).toContain('## 研究背景')
    expect(md).toContain('EGFR 突变 NSCLC')
    expect(md).toContain('<!-- page:2 -->')
  })

  test('pptxSlidesToDeck：对齐 presentationContent（含图片块）', () => {
    const png = Buffer.from('fake-png')
    const rels = '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>'
    const buf = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'ppt/presentation.xml', data: '<p:presentation><p:sldId id="256" r:id="rId1"/></p:presentation>' },
      { name: 'ppt/_rels/presentation.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>' },
      { name: 'ppt/slides/slide1.xml', data: SLIDE_SHELL(`${TITLE_SHAPE('有图页')}${BODY_SHAPE(['要点'])}`) },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels },
      { name: 'ppt/media/image1.png', data: png },
    ])
    const parsed = parsePptx(buf)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, '测试 PPT', 1)
    expect(deck).toBeTruthy()
    expect(deck!.title).toBe('测试 PPT')
    expect(deck!.slides[0].title).toBe('有图页')
    expect(deck!.slides[0].content[0]).toMatchObject({ type: 'paragraph', text: '要点', style: 'bullet' })
    expect(deck!.slides[0].content[1]).toMatchObject({ type: 'image', data: png.toString('base64') })
  })
})
