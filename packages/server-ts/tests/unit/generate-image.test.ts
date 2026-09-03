import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { GenerateImageTool } from '../../src/tools/generate-image-tool.js'
import { extractImagesFromChatResponse, setLlmGatewayForTest, type LlmGateway } from '../../src/common/llm-gateway.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #827 — generate_image 走当前多模态主模型:
 * - 主模型非多模态/上游未返回图 → IMAGE_UNSUPPORTED 明确报错(不静默降级)
 * - 成功 → img_ 前缀落盘 + file_id + tokenized URL
 * - extractImagesFromChatResponse 提取 message.images 与 content 内联图
 */

const mockCtx = (): any => ({ userId: 'u_img', sessionId: 's1' })

describe('generate_image (#827 main-model path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heurion-img-'))
  let fakeGateway: { generateImage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.stubEnv('TWIN_BASE_DIR', tmp)
    fakeGateway = { generateImage: vi.fn() }
    setLlmGatewayForTest(fakeGateway as unknown as LlmGateway)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setLlmGatewayForTest(null)
    vi.restoreAllMocks()
  })

  test('主模型非多模态 → 明确报错(含切换模型指引),不产生文件', async () => {
    fakeGateway.generateImage.mockRejectedValue(
      new Error('IMAGE_UNSUPPORTED: 主模型 deepseek-v4-flash 非多模态,无法生成图片 — 请在设置页切换到多模态模型'),
    )
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'study design schematic' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('无法生成图片')
    expect(res.error).toContain('多模态')
    const updir = path.join(tmp, 'u_img', 'uploads')
    expect(!fs.existsSync(updir) || fs.readdirSync(updir).every((f) => !f.startsWith('img_'))).toBe(true)
  })

  test('多模态返回图 → img_ 落盘 + file_id + tokenized url', async () => {
    fakeGateway.generateImage.mockResolvedValue({
      mime: 'image/png',
      dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
    })
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'beam-scan sketch' })
    expect(res.success).toBe(true)
    const parsed = JSON.parse(String(res.output))
    expect(parsed.file_id).toMatch(/^img_\d+_[0-9a-f]+\.png$/)
    expect(parsed.url).toContain(`/api/v1/files/download/${parsed.file_id}?token=`)
    expect(fs.readFileSync(path.join(tmp, 'u_img', 'uploads', parsed.file_id), 'utf-8')).toBe('fake-png-bytes')
  })

  test('模型不支持图像输出(无图返回)→ 明确报错', async () => {
    fakeGateway.generateImage.mockRejectedValue(
      new Error('IMAGE_UNSUPPORTED: 模型 deepseek-v4-flash-vision-exp 未返回图片数据(该模型不支持图像生成)'),
    )
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({ prompt: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('不支持图像生成')
  })

  test('prompt 缺失 → 参数错误', async () => {
    const tool = new GenerateImageTool(mockCtx())
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('prompt')
    expect(fakeGateway.generateImage).not.toHaveBeenCalled()
  })
})

describe('#827 extractImagesFromChatResponse', () => {
  test('message.images(OpenAI-compat 约定)→ 提取 data URI', () => {
    const urls = extractImagesFromChatResponse({
      content: '这是图',
      images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }, { url: 'https://x/y.png' }],
    })
    expect(urls).toEqual(['data:image/png;base64,AAAA', 'https://x/y.png'])
  })

  test('content 内联 data-URI / 图片 URL 兜底提取', () => {
    const urls = extractImagesFromChatResponse({
      content: '![img](data:image/jpeg;base64,BBBB) 见 https://cdn.example.org/pic.webp?v=2',
    })
    expect(urls?.[0]).toContain('data:image/jpeg;base64,BBBB')
    expect(urls?.[1]).toBe('https://cdn.example.org/pic.webp?v=2')
  })

  test('纯文本响应 → undefined(既有消费方零影响)', () => {
    expect(extractImagesFromChatResponse({ content: '普通回答' })).toBeUndefined()
    expect(extractImagesFromChatResponse(null)).toBeUndefined()
  })
})
