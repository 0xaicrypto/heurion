import { describe, test, expect, vi, afterEach } from 'vitest'
import { generatePptx } from '../src/handlers/pptx.js'
import { generateDocx } from '../src/handlers/docx.js'
import { SCHEMA_VERSION } from '@heurion/contracts'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, downloadUrl: '/f1', expiresIn: 3600 })),
}))

/**
 * Generator contract tests: validated content model → deterministic file;
 * images resolve from inline data; empty/invalid input never yields an empty
 * file (schema gate or fallback).
 */
describe('generator contract (AI → JSON → file)', () => {
  afterEach(() => vi.clearAllMocks())

  test('pptx renders a non-empty file from validated content', async () => {
    const payload = {
      schema_version: SCHEMA_VERSION,
      content_type: 'sidecar.generate_pptx',
      data: {
        schemaVersion: SCHEMA_VERSION,
        title: 'EGFR 肺癌免疫治疗',
        subtitle: '回顾性研究',
        slides: [
          { title: '背景', content: [{ type: 'paragraph', text: 'EGFR 突变患者 ICI 疗效存在争议。' }] },
          { title: '结果', content: [{ type: 'paragraph', text: 'PFS 5.2 个月。', style: 'bullet' }] },
        ],
      },
    }
    const { saveFile } = await import('../src/storage.js')
    const res = await generatePptx(payload)
    expect(res.fileName).toBe('presentation.pptx')
    const buf = (saveFile as any).mock.calls[0][0] as Buffer
    // PPTX is a zip — has the OOXML signature.
    expect(buf.slice(0, 2).toString('hex')).toBe('504b')
    expect(buf.length).toBeGreaterThan(1000)
  })

  test('pptx embeds an inline-base64 image', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') // minimal PNG header
    const payload = {
      data: {
        schemaVersion: SCHEMA_VERSION,
        title: 'With image',
        slides: [
          { title: '图', content: [{ type: 'image', ref: 'inline', data: png.toString('base64') }] },
        ],
      },
    }
    const res = await generatePptx(payload)
    expect(res.fileName).toBe('presentation.pptx')
  })

  test('pptx never produces an empty file on invalid input (fallback slide)', async () => {
    const { saveFile } = await import('../src/storage.js')
    const res = await generatePptx({ data: { title: 'T' } }) // slides missing
    expect(res.fileName).toBe('presentation.pptx')
    const buf = (saveFile as any).mock.calls[0][0] as Buffer
    expect(buf.length).toBeGreaterThan(500)
  })

  test('docx renders a non-empty file with sections', async () => {
    const payload = {
      data: {
        schemaVersion: SCHEMA_VERSION,
        title: '出院小结',
        sections: [
          { heading: '患者', paragraphs: [{ type: 'paragraph', text: 'ZQ，58 岁，男性' }] },
          { heading: '诊断', paragraphs: [{ type: 'paragraph', text: 'NSCLC' }] },
        ],
      },
    }
    const { saveFile } = await import('../src/storage.js')
    const res = await generateDocx(payload)
    expect(res.fileName).toBe('document.docx')
    const buf = (saveFile as any).mock.calls[0][0] as Buffer
    expect(buf.slice(0, 2).toString('hex')).toBe('504b')
    expect(buf.length).toBeGreaterThan(1000)
  })

  test('docx falls back to legacy template fields', async () => {
    const payload = {
      template_id: 'discharge_summary',
      output_name: 'x',
      data: { patient_initials: 'ZQ', diagnosis: 'NSCLC', findings_html: 'CT 示病灶缩小', treatment_plan: '继续免疫治疗' },
    }
    const { saveFile } = await import('../src/storage.js')
    await generateDocx(payload)
    const buf = (saveFile as any).mock.calls[0][0] as Buffer
    expect(buf.length).toBeGreaterThan(500)
  })
})

/**
 * #1133 — 边界 payload 必须降级为占位 deck,不得 TypeError。
 * null/undefined,或只有 content_type 而无 data/slides 时,旧写法
 * `(raw as ...).data` 读 null/undefined 直接抛错;契约校验失败本应走
 * fallback 生成占位页。修复:legacyContent 补可选链。
 */
describe('#1133 generatePptx 边界 payload 降级', () => {
  afterEach(() => vi.clearAllMocks())

  test('null / undefined / 仅 content_type → resolve 且生成含占位页的 pptx', async () => {
    const { saveFile } = await import('../src/storage.js')
    for (const payload of [null, undefined, { content_type: 'sidecar.generate_pptx' }]) {
      (saveFile as ReturnType<typeof vi.fn>).mockClear()
      const res = await generatePptx(payload as unknown)
      expect(res.fileName, JSON.stringify(payload)).toBe('presentation.pptx')
      const buf = ((saveFile as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]) as Buffer
      // PPTX 是 zip — OOXML 签名
      expect(buf.slice(0, 2).toString('hex'), JSON.stringify(payload)).toBe('504b')
    }
  })
})
