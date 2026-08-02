import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-chat',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-pro',
}))

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

vi.mock('../src/modules/execution/execution-plane.service.js', () => ({
  createExecutionPlaneService: () => ({
    enqueue: mocks.enqueue,
    getStatus: mocks.getStatus,
    getDownloadUrl: mocks.getDownloadUrl,
  }),
}))

import { deepseekChat } from '../src/common/llm.js'

beforeEach(() => {
  vi.stubEnv('EXECUTION_PLANE_URL', 'http://worker.test')
  vi.stubEnv('WORKER_API_TOKEN', 'test-token')
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('sidecar message metadata persistence (download + knowledge payload after reload)', () => {
  test('assistant_response event stores sidecar/file/knowledgePayload metadata', async () => {
    const app = await getApp()
    // Intent classifier returns "sidecar" directly so no extra LLM routing call is needed.
    vi.mocked(deepseekChat).mockResolvedValue('sidecar')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '请生成一个PPT', session_id: 'sidecar_meta_test' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('sidecar_file')

    // Reload messages — the persisted metadata must restore the download
    // button (sidecar flag + file info) and the knowledge payload.
    const messages = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/messages?session_id=sidecar_meta_test',
      headers: await authHeader(),
    })
    const { messages: msgs } = JSON.parse(messages.payload)
    const asst = msgs.find((m: any) => m.role === 'assistant')
    expect(asst).toBeDefined()

    const meta = asst.metadata
    expect(meta.sidecar).toBe(true)
    expect(meta.plugin).toBe(true)
    expect(meta.file).toEqual({
      fileId: 'file_1',
      fileName: 'presentation.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    expect(meta.knowledgePayload).toBeDefined()
    expect(meta.knowledgePayload.title).toBe('presentation.pptx')
    expect(meta.knowledgePayload.content.length).toBeGreaterThan(0)
  }, 30000)
})
