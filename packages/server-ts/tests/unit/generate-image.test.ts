import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { GenerateImageTool } from '../../src/tools/generate-image-tool.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

const mockCtx = (): any => ({ userId: 'u_img', sessionId: 's1' })

describe('generate_image (#177)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heurion-img-'))

  beforeEach(() => {
    vi.stubEnv('TWIN_BASE_DIR', tmp)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('returns a clear unconfigured error when IMG_API_KEY is missing', async () => {
    vi.unstubAllEnvs()
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'schematic of a clinical trial design' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('not configured')
  })

  test('saves the generated image and returns file_id + url', async () => {
    vi.stubEnv('IMG_API_KEY', 'test-key')
    const png = Buffer.from('fake-png-bytes')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (String(url).includes('images/generations')) {
        return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) } as any
      }
      throw new Error('unexpected fetch')
    })

    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'study design schematic', size: '1024x1024' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.file_id).toMatch(/^img_/)
    expect(out.url).toContain('/download')
    // File actually written.
    const saved = path.join(tmp, 'u_img', 'uploads', out.file_id)
    expect(fs.existsSync(saved)).toBe(true)
    expect(fs.readFileSync(saved).equals(png)).toBe(true)
  })

  test('API failure degrades to an error without throwing', async () => {
    vi.stubEnv('IMG_API_KEY', 'test-key')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) as any)

    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('429')
  })

  test('prompt is required', async () => {
    vi.stubEnv('IMG_API_KEY', 'test-key')
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: '  ' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('prompt required')
  })
})
