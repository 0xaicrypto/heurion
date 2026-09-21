import { describe, test, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generateDocx, MAX_DOCX_EMBEDDED_IMAGE_BYTES, resolveDocxImageBudget } from '../src/handlers/docx.js'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

/**
 * #1090-4 — docx 导出图片内存预算（对齐 pptx #1066-8 机制）。
 * docx 的 ImageRun 持原始 Buffer 全驻留内存直到 Packer.toBuffer 序列化完成，
 * 此前无任何预算；超预算图片跳过 + 正文可见注记（不崩溃、不中断导出）。
 */
async function unzip(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const out: Record<string, string> = {}
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out[name] = await file.async('string')
  }
  return out
}

/** 最小 PNG 头 + 填充到指定字节数（嵌入路径不解码图片，magic 校验仅下载分支）。
 *  seed 参与填充内容 — docx 对相同字节的 media 会去重（同 hash 复用单 media）。 */
const pngOf = (bytes: number, seed = 0x61): Buffer => {
  const head = Buffer.from('89504e470d0a1a0a', 'hex')
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), seed)])
}

const IMG = (buf: Buffer) => ({ type: 'image' as const, ref: 'inline', data: buf.toString('base64') })

describe('#1090-4 docx 图片内存预算（镜像 pptx #1066-8 机制）', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    delete process.env.DOCX_IMAGE_BUDGET_BYTES
  })

  test('resolveDocxImageBudget：默认 100MB，env 合法值覆盖，非法值回退默认', () => {
    delete process.env.DOCX_IMAGE_BUDGET_BYTES
    expect(resolveDocxImageBudget()).toBe(MAX_DOCX_EMBEDDED_IMAGE_BYTES)
    process.env.DOCX_IMAGE_BUDGET_BYTES = '4096'
    expect(resolveDocxImageBudget()).toBe(4096)
    process.env.DOCX_IMAGE_BUDGET_BYTES = 'not-a-number'
    expect(resolveDocxImageBudget()).toBe(MAX_DOCX_EMBEDDED_IMAGE_BYTES)
    process.env.DOCX_IMAGE_BUDGET_BYTES = '0'
    expect(resolveDocxImageBudget()).toBe(MAX_DOCX_EMBEDDED_IMAGE_BYTES)
    process.env.DOCX_IMAGE_BUDGET_BYTES = '-5'
    expect(resolveDocxImageBudget()).toBe(MAX_DOCX_EMBEDDED_IMAGE_BYTES)
  })

  test('单张超大图 → 跳过并留可见注记（不崩溃），后续小图仍正常内嵌', async () => {
    process.env.DOCX_IMAGE_BUDGET_BYTES = '1024'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateDocx({
      data: {
        schemaVersion: 1,
        title: 'T',
        sections: [
          {
            heading: '图',
            paragraphs: [IMG(pngOf(4096)), IMG(pngOf(64))],
          },
        ],
      },
    })
    expect(res.fileName).toBe('document.docx')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[DOCX] #1090-4'))
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const docXml = parts['word/document.xml'] || ''
    // 超大图跳过 + 正文可见注记
    expect(docXml).toContain('图片已省略')
    // 后续小图未受影响（预算余量充足）→ 仅 1 处注记
    expect((docXml.match(/图片已省略/g) || []).length).toBe(1)
    const media = Object.keys(parts).filter((n) => /^word\/media\//.test(n))
    expect(media.length).toBe(1)
  })

  test('预算总量被尊重：首图嵌入后预算耗尽 → 第二张跳过（env 低值）', async () => {
    process.env.DOCX_IMAGE_BUDGET_BYTES = '24'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateDocx({
      data: {
        schemaVersion: 1,
        title: 'T',
        sections: [
          {
            heading: '图',
            paragraphs: [IMG(pngOf(16)), IMG(pngOf(16))],
          },
        ],
      },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1090-4'))
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    // 第一张（16B ≤ 24B）嵌入，第二张（16+16 > 24）跳过
    const media = Object.keys(parts).filter((n) => /^word\/media\//.test(n))
    expect(media.length).toBe(1)
    expect((parts['word/document.xml'].match(/图片已省略/g) || []).length).toBe(1)
  })

  test('默认预算下小图正常内嵌（回归：预算不误伤正常文档）', async () => {
    delete process.env.DOCX_IMAGE_BUDGET_BYTES
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateDocx({
      data: {
        schemaVersion: 1,
        title: 'T',
        sections: [{ heading: '图', paragraphs: [IMG(pngOf(64, 0x61)), IMG(pngOf(64, 0x62))] }],
      },
    })
    expect(warn).not.toHaveBeenCalled()
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const media = Object.keys(parts).filter((n) => /^word\/media\//.test(n))
    expect(media.length).toBe(2)
    expect(parts['word/document.xml']).not.toContain('图片已省略')
  })
})
