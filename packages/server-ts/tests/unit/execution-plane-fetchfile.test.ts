import { describe, test, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/common/prisma.js', () => ({ default: {} }))

import { createExecutionPlaneService } from '../../src/modules/execution/execution-plane.service.js'

/**
 * #785 回归: worker 本地存储模式返回的 download_url 是相对路径
 * (/api/v1/files/:id/content) — undici fetch 无法解析相对 URL,
 * 预览页代理 100% 抛 TypeError。修复后必须锚定 EXECUTION_PLANE_URL。
 */
describe('ExecutionPlane.fetchFile relative URL (#785)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function stubDownloadAndFetch() {
    return vi.fn(async (input: any) => {
      if (String(input).endsWith('/download')) {
        return new Response(JSON.stringify({ file_id: 'f1', download_url: '/api/v1/files/f1/content' }), { status: 200 })
      }
      return new Response(Buffer.from('png-bytes'), { status: 200 })
    })
  }

  test('相对 download_url 锚定到 worker 基地址并携带 token', async () => {
    vi.stubEnv('EXECUTION_PLANE_URL', 'http://worker:8001')
    vi.stubEnv('WORKER_API_TOKEN', 'tok-123')
    const fetchMock = stubDownloadAndFetch()
    vi.stubGlobal('fetch', fetchMock as any)

    const svc = createExecutionPlaneService()
    const buf = await svc.fetchFile('f1')
    expect(buf?.toString()).toBe('png-bytes')
    const [calledUrl, calledInit] = fetchMock.mock.calls[1] as [string, any]
    expect(calledUrl).toBe('http://worker:8001/api/v1/files/f1/content')
    expect(calledInit.headers['x-worker-token']).toBe('tok-123')
  })

  test('绝对 download_url 原样使用', async () => {
    vi.stubEnv('EXECUTION_PLANE_URL', 'http://worker:8001')
    vi.stubEnv('WORKER_API_TOKEN', 'tok-123')
    const fetchMock = vi.fn(async (input: any) => {
      if (String(input).endsWith('/download')) {
        return new Response(JSON.stringify({ file_id: 'f2', download_url: 'https://s3.example.com/presigned' }), { status: 200 })
      }
      return new Response(Buffer.from('bytes'), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock as any)

    const svc = createExecutionPlaneService()
    const buf = await svc.fetchFile('f2')
    expect(buf).not.toBeNull()
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://s3.example.com/presigned')
  })
})
