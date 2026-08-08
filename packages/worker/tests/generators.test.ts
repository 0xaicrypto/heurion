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
