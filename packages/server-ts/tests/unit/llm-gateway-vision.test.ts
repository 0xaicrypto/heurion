import { describe, test, expect, vi } from 'vitest'

describe('vision 注册表与图片剥离 (#fix 2026-09 — 纯文本上游 400 自愈)', () => {
  test('isImageUnsupportedError — 仅 400 且上游文案命中才触发剥离重试', async () => {
    const { isImageUnsupportedError } = await import('../../src/common/llm-gateway.js')
    expect(isImageUnsupportedError(400, 'Model only supports text input; received unsupported content type \'image_url\'.')).toBe(true)
    expect(isImageUnsupportedError(400, 'invalid content type: multimodal input not enabled')).toBe(true)
    expect(isImageUnsupportedError(400, 'some other 400 error')).toBe(false)
    expect(isImageUnsupportedError(500, 'Model only supports text input')).toBe(false)
    expect(isImageUnsupportedError(401, 'unauthorized')).toBe(false)
  })

  test('stripImageParts — 图片 part 降级为文字占位,文本 part 与纯字符串消息原样保留', async () => {
    const { stripImageParts } = await import('../../src/common/llm-gateway.js')
    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '看这张图' },
          { type: 'image' as const, mime: 'image/png', dataBase64: 'AAAA' },
          { type: 'text' as const, text: '描述内容' },
        ],
      },
    ]
    const out = stripImageParts(messages)
    expect(out[0].content).toBe('system prompt')
    const parts = out[1].content as Array<{ type: string; text?: string }>
    expect(parts).toHaveLength(3)
    expect(parts[0].text).toBe('看这张图')
    expect(parts[1].type).toBe('text')
    expect(parts[1].text).toContain('image/png')
    expect(parts[2].text).toBe('描述内容')
    expect(JSON.stringify(out)).not.toContain('dataBase64')
  })

  test('LLM_TEXT_ONLY_MODELS env 覆盖注册表 — v4-flash 可标记为纯文本', async () => {
    vi.resetModules()
    process.env.LLM_TEXT_ONLY_MODELS = 'deepseek-v4-flash'
    try {
      const mod = await import('../../src/common/llm-gateway.js')
      expect(mod.modelSupportsVision('deepseek-v4-flash')).toBe(false)
      expect(mod.modelSupportsVision('deepseek-chat')).toBe(false)
      expect(mod.modelSupportsVision('glm-5.3-flash')).toBe(true)
    } finally {
      delete process.env.LLM_TEXT_ONLY_MODELS
      vi.resetModules()
    }
  })

  test('默认注册表(无 env)— v4 家族按视觉处理', async () => {
    vi.resetModules()
    delete process.env.LLM_TEXT_ONLY_MODELS
    try {
      const mod = await import('../../src/common/llm-gateway.js')
      expect(mod.modelSupportsVision('deepseek-v4-flash')).toBe(true)
    } finally {
      vi.resetModules()
    }
  })
})
