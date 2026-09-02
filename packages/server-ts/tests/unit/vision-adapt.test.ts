import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectImageAttachments, pickVisionTurnModel } from '../../src/modules/shared/chat-context.js'

/**
 * #fix 视觉模型自适应 — 图片附件 + 纯文本模型时自动切换视觉模型;
 * PDF/文本附件不需要视觉能力。
 */
describe('detectImageAttachments 位图附件探测', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-vision-test-${Date.now()}`)
  const uploadsDir = path.join(tmpDir, 'u1', 'uploads')

  beforeEach(() => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(uploadsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('png/jpg 位图附件 → true', async () => {
    const id1 = '1750000000400_scan.png'
    const id2 = '1750000000401_photo.jpg'
    fs.writeFileSync(path.join(uploadsDir, id1), 'x')
    fs.writeFileSync(path.join(uploadsDir, id2), 'x')
    expect(await detectImageAttachments('u1', [id1, id2])).toBe(true)
    expect(await detectImageAttachments('u1', [{ file_id: id1 }])).toBe(true)
  })

  test('PDF/txt 附件不触发视觉需求(文本路径可解析)', async () => {
    const pdfId = '1750000000402_paper.pdf'
    const txtId = '1750000000403_note.txt'
    fs.writeFileSync(path.join(uploadsDir, pdfId), 'x')
    fs.writeFileSync(path.join(uploadsDir, txtId), 'x')
    expect(await detectImageAttachments('u1', [pdfId, txtId])).toBe(false)
  })

  test('空/缺失附件 → false', async () => {
    expect(await detectImageAttachments('u1', undefined)).toBe(false)
    expect(await detectImageAttachments('u1', [])).toBe(false)
    expect(await detectImageAttachments('u1', ['1750000000404_missing.pdf'])).toBe(false)
  })
})

describe('pickVisionTurnModel 视觉模型自适应', () => {
  const saved = {
    provider: process.env.DEFAULT_LLM_PROVIDER,
    premium: process.env.DEEPSEEK_PREMIUM_MODEL,
    chat: process.env.DEEPSEEK_CHAT_MODEL,
  }

  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_PREMIUM_MODEL = 'deepseek-reasoner'
    process.env.DEEPSEEK_CHAT_MODEL = 'deepseek-v4-flash'
  })

  afterEach(() => {
    if (saved.provider === undefined) delete process.env.DEFAULT_LLM_PROVIDER; else process.env.DEFAULT_LLM_PROVIDER = saved.provider
    if (saved.premium === undefined) delete process.env.DEEPSEEK_PREMIUM_MODEL; else process.env.DEEPSEEK_PREMIUM_MODEL = saved.premium
    if (saved.chat === undefined) delete process.env.DEEPSEEK_CHAT_MODEL; else process.env.DEEPSEEK_CHAT_MODEL = saved.chat
  })

  test('图片附件 + 纯文本模型(deepseek) → 自动切到视觉模型', () => {
    const res = pickVisionTurnModel({ turnModel: 'deepseek-reasoner', hasImages: true })
    expect(res.switched).toBe(true)
    expect(res.vision).toBe(true)
    expect(res.model).toBe('deepseek-v4-flash')
  })

  test('无图片附件 → 不切换,按模型能力判定', () => {
    const res = pickVisionTurnModel({ turnModel: 'deepseek-reasoner', hasImages: false })
    expect(res.switched).toBe(false)
    expect(res.vision).toBe(false)
    expect(res.model).toBe('deepseek-reasoner')
  })

  test('模型本身支持视觉 → 不切换,vision=true', () => {
    const res = pickVisionTurnModel({ turnModel: 'deepseek-v4-flash', hasImages: true })
    expect(res.switched).toBe(false)
    expect(res.vision).toBe(true)
    expect(res.model).toBe('deepseek-v4-flash')
  })

  test('premium 不支持视觉时依次尝试 chat 模型候选', () => {
    process.env.DEEPSEEK_CHAT_MODEL = 'deepseek-chat'
    const res = pickVisionTurnModel({ turnModel: 'deepseek-reasoner', hasImages: true })
    expect(res.switched).toBe(false)
    expect(res.vision).toBe(false)
    expect(res.model).toBe('deepseek-reasoner')
  })

  test('kimi 等非 deepseek/opencode provider → 不跨端点切换,按文本降级', () => {
    process.env.DEFAULT_LLM_PROVIDER = 'kimi'
    const res = pickVisionTurnModel({ turnModel: 'moonshot-v1-8k', hasImages: true })
    expect(res.switched).toBe(false)
    expect(res.vision).toBe(false)
    expect(res.model).toBe('moonshot-v1-8k')
  })

  test('opencode provider 同样支持安全切换', () => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    const res = pickVisionTurnModel({ turnModel: 'deepseek-chat', hasImages: true })
    expect(res.switched).toBe(true)
    expect(res.vision).toBe(true)
  })
})
