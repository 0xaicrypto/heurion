import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider, INTENT_PROMPT_MARKER } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (job: any) => ({
    job_id: 'job_776',
    status: 'pending',
    created_at: Date.now(),
    type: job.type,
    payload: job.payload,
  })),
  getStatus: vi.fn(async () => ({
    job_id: 'job_776',
    status: 'completed',
    created_at: Date.now(),
    result: { file_id: 'file_776', file_name: 'deck.pptx' },
  })),
  fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake-pptx')),
  getDownloadUrl: vi.fn(async () => ({
    file_id: 'file_776',
    file_name: 'deck.pptx',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    download_url: 'https://example.test/download/file_776',
    expires_in: 3600,
  })),
}))

vi.mock('../../src/modules/execution/execution-plane.service.js', () => ({
  createExecutionPlaneService: () => ({
    enqueue: mocks.enqueue,
    getStatus: mocks.getStatus,
    fetchFile: mocks.fetchFile,
    getDownloadUrl: mocks.getDownloadUrl,
  }),
}))

import { deepseekChat } from '../../src/common/llm.js'

function parseEvents(payload: string): any[] {
  return payload
    .split('\n\n')
    .flatMap((block: string) =>
      block
        .split('\n')
        .filter((line: string) => line.startsWith('data: '))
        .map((line: string) => {
          try {
            return JSON.parse(line.slice('data: '.length))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
}

async function createDoc(app: any, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { title: 'Takeover Test' },
  })
  const docId = JSON.parse(res.payload).id
  await app.inject({
    method: 'PUT', url: `/api/v1/docs/${docId}`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { body },
  })
  return docId
}

async function installPptxPlugin(app: any): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/plugins/install',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: JSON.stringify({ pluginId: 'heurion/pptx' }),
  })
  expect(res.statusCode).toBe(200)
}

beforeEach(() => {
  vi.stubEnv('EXECUTION_PLANE_URL', 'http://worker.test')
  vi.stubEnv('WORKER_API_TOKEN', 'test-token')
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('#776 doc- 会话路由收编（旁路只服务主 chat）', () => {
  test('doc chat "把这篇文章做成 PPT" → 工具循环承接（insert_asset export），旁路不参与', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    await installPptxPlugin(app)
    const docId = await createDoc(app, '# EGFR 研究\n\n## 结果\n\n中位 PFS 5.2 个月。')

    const adjudicatorCalls = vi.fn()
    let contentCalls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes(INTENT_PROMPT_MARKER)) {
        adjudicatorCalls()
        return Promise.resolve('generate')
      }
      contentCalls++
      if (contentCalls === 1) {
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'insert_asset', arguments: { asset_type: 'export', format: 'pptx', summary: '导出 PPT' } })}</tool_call>`)
      }
      return Promise.resolve('已导出 PPT。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '把这篇文章做成 PPT', session_id: `doc-${docId}` }),
    })
    expect(res.statusCode).toBe(200)

    // 收编：旁路裁决（每次 turn 一次 LLM）不再发生。
    expect(adjudicatorCalls).not.toHaveBeenCalled()

    // 工具循环承接：export 产物以 sidecar_file 下发 + knowledge_payload 平价迁移。
    expect(res.payload).toContain('"type":"sidecar_file"')
    const sidecar = parseEvents(res.payload).find((e: any) => e.type === 'sidecar_file')
    expect(sidecar).toBeDefined()
    expect(sidecar.file_name).toMatch(/\.pptx$/)
    expect(sidecar.knowledge_payload).toBeDefined()
    expect(sidecar.knowledge_payload.title).toBe(sidecar.file_name)
    expect(sidecar.knowledge_payload.content).toContain('中位 PFS 5.2 个月')

    // 下载卡片写回草稿。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(doc.body).toContain('[下载 PPT 版')

    // 不再出现旁路渲染的 plugin 标记（历史重载无 plugin metadata）。
    const messages = await app.inject({
      method: 'GET',
      url: `/api/v1/agent/messages?session_id=doc-${docId}`,
      headers: await authHeader(),
    })
    const { messages: msgs } = JSON.parse(messages.payload)
    expect(msgs.some((m: any) => m.metadata?.plugin === true)).toBe(false)

    // 遥测：旁路 verdict 记 taken_over_by_tool_loop 供回归对比。
    const tel = await (prisma as any).telemetryEvent.findMany({
      where: { userId, category: 'sidecar', action: 'intent' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })
    const verdicts = tel.map((t: any) => {
      const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata
      return meta?.verdict
    })
    expect(verdicts).toContain('taken_over_by_tool_loop')
  }, 30000)

  test('主 chat "生成一份 PPT" → 旁路照常工作（回归）', async () => {
    const app = await getApp()
    await installPptxPlugin(app)

    // 裁决与 payload LLM 均返回 'sidecar'（= generate），插件管线照常。
    vi.mocked(deepseekChat).mockResolvedValue('sidecar')

    // 唯一文本避开 sidecar 决策缓存。
    const text = `请生成一个PPT ${Date.now()}`
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text, session_id: `takeover_main_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('sidecar_file')

    // 主 chat 保留旁路裁决：intent classifier LLM 被调用。
    const adjudicatorCalled = vi.mocked(deepseekChat).mock.calls.some(
      (c: any) => JSON.stringify(c[0]).includes(INTENT_PROMPT_MARKER),
    )
    expect(adjudicatorCalled).toBe(true)
  }, 30000)
})
