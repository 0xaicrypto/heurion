import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (job: any) => ({
    job_id: 'job_1',
    status: 'pending',
    created_at: Date.now(),
    type: job.type,
    payload: job.payload,
  })),
  getStatus: vi.fn(async () => ({
    job_id: 'job_1',
    status: 'completed',
    created_at: Date.now(),
    result: { file_id: 'file_1', file_name: 'presentation.pptx' },
  })),
  getDownloadUrl: vi.fn(async () => ({
    file_id: 'file_1',
    file_name: 'presentation.pptx',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    download_url: 'https://example.test/download/file_1',
    expires_in: 3600,
  })),
}))

vi.mock('../../src/modules/execution/execution-plane.service.js', () => ({
  createExecutionPlaneService: () => ({
    enqueue: mocks.enqueue,
    getStatus: mocks.getStatus,
    getDownloadUrl: mocks.getDownloadUrl,
  }),
}))

import { deepseekChat } from '../../src/common/llm.js'
import { handleSidecarRequest } from '../../src/modules/execution/sidecar-chat-handler.js'

beforeEach(() => {
  vi.stubEnv('EXECUTION_PLANE_URL', 'http://worker.test')
  vi.stubEnv('WORKER_API_TOKEN', 'test-token')
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

const pptxJson = {
  title: 'Immunotherapy Update',
  subtitle: 'Conference 2026',
  slides: [{ title: 'Intro', content: 'Overview of recent trials' }],
}

describe('sidecar chat handler — conversation context injection', () => {
  test('includes conversation history in the PPTX payload prompt', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    const result = await handleSidecarRequest({
      userId: 'u1',
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
    expect(result.file?.fileName).toBe('presentation.pptx')
    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(1)
  })

  test('omits the history block when no history is provided', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    await handleSidecarRequest({
      userId: 'u1',
      text: '请生成一个肺癌主题的PPT',
    })

    const prompt = vi.mocked(deepseekChat).mock.calls[0][0].at(-1).content as string
    expect(prompt).not.toContain('Conversation history')
  })

  test('enqueued payload carries the generated slide content in data.slides', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify(pptxJson))

    await handleSidecarRequest({
      userId: 'u1',
      text: '请生成一个PPT',
    })

    const job = mocks.enqueue.mock.calls[0][0] as any
    expect(job.type).toBe('sidecar.generate_pptx')
    expect(job.payload.data.title).toBe('Immunotherapy Update')
    expect(job.payload.data.slides).toEqual([{ title: 'Intro', content: 'Overview of recent trials' }])
  })
})
