import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getLlmGateway, setLlmGatewayForTest, type LlmGateway } from '../../src/common/llm-gateway.js'
import { describeImage, readImageFile, resetImageVisionCacheForTest, visionModelForActiveProvider } from '../../src/lib/image-vision.js'
import { ViewImageTool } from '../../src/tools/view-image-tool.js'

/**
 * #fix 2026-09 — 图片视觉理解(A view_image 工具 + B 导入期图题)。
 * 模型对文档内嵌图原本"盲"(只见 ![caption](url) 文本),本模块把文件库
 * 图片喂给多模态主模型。
 */

// PNG magic bytes 的最小合法头(8 字节签名 + 4 字节长度)。
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])

let tmpDir: string
const USER = 'user_test'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-vision-'))
  process.env.TWIN_BASE_DIR = tmpDir
  process.env.DEFAULT_LLM_PROVIDER = 'opencode'
  process.env.DEFAULT_LLM_MODEL = 'glm-5.3-flash'
  process.env.OPENCODE_API_KEY = 'test-key'
  resetImageVisionCacheForTest()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.TWIN_BASE_DIR
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function writeImage(fileId: string, bytes: Buffer = PNG_BYTES): void {
  fs.writeFileSync(path.join(tmpDir, USER, 'uploads', fileId), bytes)
}

function mockGateway(result: { text: string } | Error) {
  const chatWithMeta = vi.fn(async () => {
    if (result instanceof Error) throw result
    return { ...result, truncated: false }
  })
  setLlmGatewayForTest({ chatWithMeta } as unknown as LlmGateway)
  return chatWithMeta
}

describe('readImageFile / visionModelForActiveProvider', () => {
  test('PNG magic bytes → mime 判定 + base64;非图片 → null', () => {
    fs.mkdirSync(path.join(tmpDir, USER, 'uploads'), { recursive: true })
    writeImage('img_a_1.png')
    expect(readImageFile(USER, 'img_a_1.png')?.mime).toBe('image/png')
    fs.writeFileSync(path.join(tmpDir, USER, 'uploads', 'plain.txt'), 'not an image')
    expect(readImageFile(USER, 'plain.txt')).toBeNull()
    expect(readImageFile(USER, 'missing.png')).toBeNull()
  })

  test('多模态主模型 → 模型名;纯文本模型(provider kimi + kimi 模型名) → null', () => {
    expect(visionModelForActiveProvider()).toBe('glm-5.3-flash')
    process.env.DEFAULT_LLM_PROVIDER = 'kimi'
    process.env.DEFAULT_LLM_MODEL = 'moonshot-v1-8k'
    expect(visionModelForActiveProvider()).toBeNull()
  })
})

describe('describeImage (A/B 共用)', () => {
  test('vision 调用带 image part + 返回描述;同一图片第二次命中缓存(不重烧)', async () => {
    fs.mkdirSync(path.join(tmpDir, USER, 'uploads'), { recursive: true })
    writeImage('img_doc_1.png')
    const chatWithMeta = mockGateway({ text: '柱状图:三组患者疗效对比' })

    const first = await describeImage(USER, 'img_doc_1.png')
    expect(first).toContain('柱状图')
    expect(chatWithMeta).toHaveBeenCalledTimes(1)
    const parts = (chatWithMeta.mock.calls[0][0] as any)[0].content
    expect(parts[0].type).toBe('image')
    expect(parts[0].mime).toBe('image/png')

    const second = await describeImage(USER, 'img_doc_1.png')
    expect(second).toContain('柱状图')
    expect(chatWithMeta).toHaveBeenCalledTimes(1) // 缓存命中
  })

  test('vision 调用失败 → 空串(best-effort),且失败不进缓存(下次重试)', async () => {
    fs.mkdirSync(path.join(tmpDir, USER, 'uploads'), { recursive: true })
    writeImage('img_doc_2.png')
    mockGateway(new Error('LLM 请求失败'))
    expect(await describeImage(USER, 'img_doc_2.png')).toBe('')
    // 重试路径:换成可用 gateway 再调 → 成功
    const chatWithMeta = mockGateway({ text: '流程图' })
    expect(await describeImage(USER, 'img_doc_2.png')).toBe('流程图')
    expect(chatWithMeta).toHaveBeenCalledTimes(1)
  })
})

describe('view_image 工具 (A)', () => {
  const ctx = { userId: USER, sessionId: 'doc-doc1', memory: {}, facts: {}, episodes: {}, skills: {}, knowledge: {}, eventLog: { query: () => [] } } as any

  test('URL 形态解析 file_id → 视觉理解', async () => {
    fs.mkdirSync(path.join(tmpDir, USER, 'uploads'), { recursive: true })
    writeImage('img_doc_3.png')
    const chatWithMeta = mockGateway({ text: ' Kaplan-Meier 曲线:两组生存率对比' })
    const tool = new ViewImageTool(ctx)
    const r = await tool.execute({ image: '/api/v1/files/download/img_doc_3.png?token=abc', question: '总结这张图' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('Kaplan-Meier')
    const prompt = (chatWithMeta.mock.calls[0][0] as any)[0].content[1].text
    expect(prompt).toContain('总结这张图')
    void getLlmGateway
  })

  test('非本库 URL / 文件不存在 → 诚实报错', async () => {
    const tool = new ViewImageTool(ctx)
    const r1 = await tool.execute({ image: 'https://example.com/pic.png' })
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('外部 URL 无法读取')
    const r2 = await tool.execute({ image: 'img_missing_9.png' })
    expect(r2.success).toBe(false)
    expect(r2.error).toContain('无法读取图片')
  })

  test('纯文本主模型 → 明确报错引导切换多模态', async () => {
    process.env.DEFAULT_LLM_PROVIDER = 'kimi'
    process.env.DEFAULT_LLM_MODEL = 'moonshot-v1-8k'
    const tool = new ViewImageTool(ctx)
    const r = await tool.execute({ image: 'img_doc_3.png' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('多模态')
  })
})
