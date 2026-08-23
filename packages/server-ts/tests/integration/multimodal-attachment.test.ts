import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  serializeContent,
  providerSupportsVision,
  modelSupportsVision,
  type ChatContentPart,
} from '../../src/common/llm-gateway.js'
import { isImageFile, extractImageUpload } from '../../src/lib/document-extractor.js'

/**
 * #511 — 图片附件多模态传递:content parts 序列化 / 视觉 provider 判定 /
 * 图片上传读取。非视觉 provider 必须走文本降级(由 chat-handler 组装)。
 */
describe('#511 content part serialization', () => {
  test('字符串 content 原样序列化(兼容旧调用)', () => {
    expect(serializeContent('hello')).toBe('hello')
  })

  test('文本 part → OpenAI text part', () => {
    const parts: ChatContentPart[] = [{ type: 'text', text: 'hi' }]
    expect(serializeContent(parts)).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('图片 part → image_url data URL', () => {
    const parts: ChatContentPart[] = [{ type: 'image', mime: 'image/png', dataBase64: 'aGVsbG8=' }]
    expect(serializeContent(parts)).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ])
  })

  test('混合 parts 顺序保持', () => {
    const parts: ChatContentPart[] = [
      { type: 'image', mime: 'image/jpeg', dataBase64: 'AA==' },
      { type: 'text', text: '看图' },
    ]
    const out = serializeContent(parts) as Array<{ type: string }>
    expect(out[0].type).toBe('image_url')
    expect(out[1].type).toBe('text')
  })

  // #fix: deepseek-v4-flash 支持多模态 — 纯文本模型(deepseek-chat/reasoner)
  // 序列化时必须把图片 part 降级为文本说明,否则 provider 直接 400。
  test('图片 part 发给纯文本模型时降级为文本说明', () => {
    const parts: ChatContentPart[] = [
      { type: 'image', mime: 'image/png', dataBase64: 'aGVsbG8=' },
      { type: 'text', text: '看图' },
    ]
    const out = serializeContent(parts, 'deepseek-chat') as Array<{ type: string; text?: string }>
    expect(out.every((p) => p.type === 'text')).toBe(true)
    expect(out[0].text).toContain('图片附件已省略')
  })
})

describe('#511 vision provider detection', () => {
  const old = process.env.DEFAULT_LLM_PROVIDER
  afterEach(() => {
    if (old === undefined) delete process.env.DEFAULT_LLM_PROVIDER
    else process.env.DEFAULT_LLM_PROVIDER = old
  })

  test('gemini/openai/anthropic 支持视觉', () => {
    expect(providerSupportsVision('gemini')).toBe(true)
    expect(providerSupportsVision('openai')).toBe(true)
    expect(providerSupportsVision('anthropic')).toBe(true)
  })

  // #fix: deepseek/opencode 默认模型是 deepseek-v4-flash — 支持多模态。
  test('deepseek/opencode 默认(v4-flash)支持视觉,kimi 纯文本', () => {
    expect(providerSupportsVision('deepseek')).toBe(true)
    expect(providerSupportsVision('opencode')).toBe(true)
    expect(providerSupportsVision('kimi')).toBe(false)
  })

  test('按模型精确判定:v4 支持(含 vision-exp),v3 时代纯文本', () => {
    expect(modelSupportsVision('deepseek-v4-flash')).toBe(true)
    expect(modelSupportsVision('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(modelSupportsVision('deepseek-v4-pro')).toBe(true)
    expect(modelSupportsVision('deepseek-chat')).toBe(false)
    expect(modelSupportsVision('deepseek-reasoner')).toBe(false)
    // model 维度优先于 provider 默认。
    expect(providerSupportsVision('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(true)
    expect(providerSupportsVision('deepseek', 'deepseek-chat')).toBe(false)
    expect(providerSupportsVision('kimi', 'deepseek-v4-flash')).toBe(true)
  })

  test('未指定时按环境变量默认值', () => {
    process.env.DEFAULT_LLM_PROVIDER = 'gemini'
    expect(providerSupportsVision()).toBe(true)
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    expect(providerSupportsVision()).toBe(true)
    process.env.DEFAULT_LLM_PROVIDER = 'kimi'
    expect(providerSupportsVision()).toBe(false)
  })
})

describe('#511 image upload detection', () => {
  let baseDir: string
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-upload-'))
    process.env.TWIN_BASE_DIR = baseDir
  })
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('位图文件判定为图片', () => {
    expect(isImageFile('x.png')).toBe(true)
    expect(isImageFile('x.jpg')).toBe(true)
    expect(isImageFile('x.jpeg')).toBe(true)
    expect(isImageFile('x.webp')).toBe(true)
    expect(isImageFile('x.png', 'image/png')).toBe(true)
  })

  test('SVG 与文本不算位图图片(走文本路径)', () => {
    expect(isImageFile('chart.svg')).toBe(false)
    expect(isImageFile('x.svg', 'image/svg+xml')).toBe(false)
    expect(isImageFile('report.txt')).toBe(false)
    expect(isImageFile('a.pdf', 'application/pdf')).toBe(false)
  })

  test('extractImageUpload 读取文件为 base64 且保留 mime', async () => {
    const dir = path.join(baseDir, 'u1', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const fileId = 'abc_pic.png'
    fs.writeFileSync(path.join(dir, fileId), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const out = await extractImageUpload('u1', fileId)
    expect(out).not.toBeNull()
    expect(out!.mime).toBe('image/png')
    expect(out!.dataBase64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
  })

  test('extractImageUpload 对缺失文件/非图片返回 null', async () => {
    expect(await extractImageUpload('u1', 'missing_x.png')).toBeNull()
    const dir = path.join(baseDir, 'u1', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'abc_note.txt'), 'hello')
    expect(await extractImageUpload('u1', 'abc_note.txt')).toBeNull()
  })

  test('超过 4MB 上限的图片返回 oversized(不读内容)', async () => {
    const dir = path.join(baseDir, 'u1', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'big_x.png'), Buffer.alloc(4 * 1024 * 1024 + 1))
    const out = await extractImageUpload('u1', 'big_x.png')
    expect(out).toEqual({ oversized: true })
  })
})
