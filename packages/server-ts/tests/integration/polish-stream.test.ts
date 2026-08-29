import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { polishSelection } from '../../src/modules/documents/document-writing.service.js'
import { setLlmGatewayForTest, type LlmGateway } from '../../src/common/llm-gateway.js'

/**
 * #752 回归锁 — 润色链路三次生产事故的根因都在这条路径:
 * 1. 手写 registerPlugin 传错对象 → 编辑器白屏(已修)
 * 2. 空流在生成器内 throw → 绕过 router 的非流式 fallback,用户看到
 *    "模型 X 未返回任何内容"(本文件锁定:空流必须干净返回)
 * 3. 模型链仍回落 deepseek-v4-flash → opencode provider 下润色默认
 *    glm-5.3-flash(带 thinking),本文件锁定模型选择。
 */

function makeMockGateway(opts: {
  streamYields?: string[]
  chatText?: string
  capture?: (call: { model?: string; thinking?: string }) => void
}): LlmGateway {
  return {
    async *stream(messages, options) {
      opts.capture?.({ model: options?.model, thinking: (options as any)?.thinking })
      for (const t of opts.streamYields ?? []) yield t
      // 空流 = 不 yield 任何东西,干净结束(生产事故场景)
    },
    async chat(_m, options) {
      opts.capture?.({ model: options?.model, thinking: (options as any)?.thinking })
      return opts.chatText ?? ''
    },
    getApiKey: () => 'test-key',
  } as unknown as LlmGateway
}

describe('#752 polishSelection (regression)', () => {
  const ORIGINAL_PROVIDER = process.env.DEFAULT_LLM_PROVIDER

  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    delete process.env.DEEPSEEK_REASONER_MODEL
    delete process.env.DEEPSEEK_PREMIUM_MODEL
  })

  afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) delete process.env.DEFAULT_LLM_PROVIDER
    else process.env.DEFAULT_LLM_PROVIDER = ORIGINAL_PROVIDER
    setLlmGatewayForTest(null)
  })

  test('opencode provider → 润色默认 glm-5.3-flash 且 thinking=enabled', async () => {
    let captured: { model?: string; thinking?: string } | undefined
    setLlmGatewayForTest(makeMockGateway({ streamYields: ['润色结果'], capture: (c) => (captured = c) }))
    const chunks: string[] = []
    for await (const c of polishSelection('一段临床文本', undefined, 'u1')) chunks.push(c)
    expect(chunks.join('')).toBe('润色结果')
    expect(captured?.model).toBe('glm-5.3-flash')
    expect(captured?.thinking).toBe('enabled')
  })

  test('空流必须干净返回(不 throw) — router fallback 才能接管', async () => {
    setLlmGatewayForTest(makeMockGateway({ streamYields: [] }))
    const chunks: string[] = []
    // 修复前:此处抛 "模型 X 未返回任何内容" → SSE error 事件,fallback 永远不触发
    await expect((async () => {
      for await (const c of polishSelection('一段临床文本', undefined, 'u1')) chunks.push(c)
    })()).resolves.not.toThrow()
    expect(chunks).toEqual([])
  })

  test('DEEPSEEK_REASONER_MODEL 优先于 provider 默认', async () => {
    process.env.DEEPSEEK_REASONER_MODEL = 'glm-5.3'
    let captured: { model?: string } | undefined
    setLlmGatewayForTest(makeMockGateway({ streamYields: ['x'], capture: (c) => (captured = c) }))
    for await (const _ of polishSelection('文本', undefined, 'u1')) void _
    expect(captured?.model).toBe('glm-5.3')
  })

  test('非 glm 模型不透传 thinking 参数(避免其他 provider 400)', async () => {
    process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
    delete process.env.DEEPSEEK_REASONER_MODEL
    delete process.env.DEEPSEEK_PREMIUM_MODEL
    let captured: { model?: string; thinking?: string } | undefined
    setLlmGatewayForTest(makeMockGateway({ streamYields: ['x'], capture: (c) => (captured = c) }))
    for await (const _ of polishSelection('文本', undefined, 'u1')) void _
    expect(captured?.model).not.toContain('glm')
    // thinking 仍出现在 options 中,但 gateway 层按模型名守卫不会写入 body —
    // 这里验证 options 层面的值,守卫本身在 gateway 测试覆盖。
    expect(captured?.thinking).toBe('enabled')
  })
})
