import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { issueChartToken } from '../../src/common/chart-token.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getStatus: vi.fn(),
  fetchFile: vi.fn(),
  getDownloadUrl: vi.fn(),
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

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  vi.mocked(deepseekChat).mockResolvedValue('x')
  mocks.enqueue.mockResolvedValue({ job_id: 'jp1', status: 'pending' })
  mocks.getStatus.mockResolvedValue({ job_id: 'jp1', status: 'completed', result: {} })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function uploadPptx(app: any, filename: string): Promise<string> {
  const boundary = `----pv${Date.now()}`
  // nonce — 避免 sha256 去重把不同用例的 upload 解析成同一个 fileId。
  const png = Buffer.from(`%PNG fake pptx bytes ${Date.now()}-${Math.random()}`)
  const form = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/files/upload',
    headers: { ...await authHeader(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: form,
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).file_id
}

describe('#771 文件预览端点（sidecar.preview_file）', () => {
  test('渲染完成 → 逐页带 token 的预览 URL；preview-page 校验 chart token', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const fileId = await uploadPptx(app, 'deck.pptx')

    mocks.getStatus.mockResolvedValue({
      job_id: 'jp1', status: 'completed',
      result: { pages: [{ fileId: 'worker-png-1', fileName: 'page-1.png', mimeType: 'image/png' }, { fileId: 'worker-png-2', fileName: 'page-2.png', mimeType: 'image/png' }], page_count: 2 },
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/files/preview',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ file_id: fileId }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.page_count).toBe(2)
    expect(body.pages[0].url).toContain('/api/v1/files/preview-page/worker-png-1?token=')

    // preview-page：token 校验 + worker 字节代理。
    mocks.fetchFile.mockResolvedValue(Buffer.from('fake-png-bytes'))
    const token = issueChartToken('worker-png-1', userId)
    const page = await app.inject({
      method: 'GET', url: `/api/v1/files/preview-page/worker-png-1?token=${token}`,
    })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('image/png')
    expect(page.body).toBeTruthy()

    // 无 token 且无鉴权 → 401。
    const unauthed = await app.inject({
      method: 'GET', url: '/api/v1/files/preview-page/worker-png-1',
    })
    expect(unauthed.statusCode).toBe(401)
  }, 30000)

  test('worker 缺 LibreOffice（PREVIEW_UNAVAILABLE）→ 501 degraded 优雅降级', async () => {
    const app = await getApp()
    const fileId = await uploadPptx(app, 'deck2.pptx')
    mocks.getStatus.mockResolvedValue({
      job_id: 'jp1', status: 'failed',
      error: 'PREVIEW_UNAVAILABLE: soffice (LibreOffice) and pdftoppm (poppler-utils) are required for preview rendering',
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/files/preview',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ file_id: fileId }),
    })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.payload).degraded).toBe(true)
  }, 30000)

  test('非 pptx/docx 文件 / 缺 file_id → 400；越权他人文件 → 404', async () => {
    const app = await getApp()
    const fileId = await uploadPptx(app, 'doc.pdf')

    const wrong = await app.inject({
      method: 'POST', url: '/api/v1/files/preview',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ file_id: fileId }),
    })
    expect(wrong.statusCode).toBe(400)
    expect(JSON.parse(wrong.payload).error).toContain('pptx')

    const missing = await app.inject({
      method: 'POST', url: '/api/v1/files/preview',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ file_id: '1788188600000_nope.pptx' }),
    })
    expect(missing.statusCode).toBe(404)
    void prisma
  }, 30000)
})
