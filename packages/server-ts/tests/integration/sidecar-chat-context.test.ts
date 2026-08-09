import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'
import { buildPayload } from '../../src/modules/plugins/plugin-capability.service.js'
import { seedOfficialCatalog } from '../../src/modules/plugins/plugin-catalog.service.js'
import prisma from '../../src/common/prisma'

beforeEach(async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  await seedOfficialCatalog().catch(() => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await prisma.pluginCatalog.deleteMany({ where: { source: 'official' } }).catch(() => {})
})

const pptxJson = {
  schemaVersion: 1,
  title: 'Immunotherapy Update',
  subtitle: 'Conference 2026',
  slides: [{ title: 'Intro', content: [{ type: 'paragraph', text: 'Overview of recent trials' }] }],
}

describe('#451 plugin render payload — conversation context injection + content guarantee', () => {
  test('includes conversation history in the PPTX payload prompt', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    await buildPayload('heurion/pptx', 'generate_pptx', {
      text: '请基于我们之前讨论的内容生成一个PPT汇报',
      history: [
        { role: 'user', content: '我们讨论了肺癌免疫治疗的进展' },
        { role: 'assistant', content: '好的，主要涉及 PD-1 抑制剂联合化疗的 III 期数据。' },
      ],
    })

    const prompt = vi.mocked(deepseekChat).mock.calls[0][0].at(-1).content as string
    expect(prompt).toContain('Conversation history')
    expect(prompt).toContain('我们讨论了肺癌免疫治疗的进展')
    expect(prompt).toContain('PD-1 抑制剂联合化疗的 III 期数据')
    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(1)
  })

  test('omits the history block when no history is provided', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    await buildPayload('heurion/pptx', 'generate_pptx', {
      text: '请生成一个肺癌主题的PPT',
    })

    const prompt = vi.mocked(deepseekChat).mock.calls[0][0].at(-1).content as string
    expect(prompt).not.toContain('Conversation history')
  })

  test('valid payload passes through unchanged (data.slides + schemaVersion)', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    const payload = await buildPayload('heurion/pptx', 'generate_pptx', { text: '请生成一个PPT' })

    expect(payload.content_type).toBe('sidecar.generate_pptx')
    expect(payload.schema_version).toBe(1)
    expect((payload.data as any).title).toBe('Immunotherapy Update')
    expect((payload.data as any).slides[0].title).toBe('Intro')
    expect((payload.data as any).slides[0].content[0]).toEqual({ type: 'paragraph', text: 'Overview of recent trials' })
    expect((payload.data as any).schemaVersion).toBe(1)
  })

  test('invalid LLM output triggers one correction retry, then a valid fallback', async () => {
    // First attempt: malformed (missing slides). Second attempt: still invalid.
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(JSON.stringify({ schemaVersion: 1, title: 'Bad' }))
      .mockResolvedValueOnce('not json at all')

    const payload = await buildPayload('heurion/pptx', 'generate_pptx', { text: '请生成一个肺癌PPT' })

    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(2)
    // Correction retry prompt carries the schema errors.
    const retryPrompt = vi.mocked(deepseekChat).mock.calls[1][0].at(-1).content as string
    expect(retryPrompt).toContain('未通过校验')
    // Fallback content is schema-valid and non-empty.
    const data = payload.data as any
    expect(data.slides.length).toBeGreaterThanOrEqual(2)
    expect(data.slides[0].title).toBeDefined()
  })

  test('official renderer plugins require no catalog seed (fallback is schema-safe)', async () => {
    await prisma.pluginCatalog.deleteMany({ where: { source: 'official' } }).catch(() => {})
    await seedOfficialCatalog()
    const payload = await buildPayload('heurion/docx', 'generate_docx', { text: '出院小结：肺癌术后患者' })
    expect(payload.content_type).toBe('sidecar.generate_docx')
    expect((payload.data as any).sections.length).toBeGreaterThanOrEqual(1)
    await prisma.pluginCatalog.deleteMany({ where: { source: 'official' } }).catch(() => {})
  })
})
