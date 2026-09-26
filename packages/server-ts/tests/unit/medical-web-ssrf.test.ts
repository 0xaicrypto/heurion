import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { setGuardTransportForTest, setGuardLookupForTest } from '@heurion/ssrf-guard'

/**
 * P0 Rule 4 — visit_medical_site 直连抓取接 SSRF 护栏。
 *
 * 修复前：directFetchMarkdown 直接 fetch(模型给的 url, redirect:'follow')，
 * 无公网校验、无大小上限 — 可被诱导读取云元数据（169.254.169.254）或内网
 * 服务。修复后统一走 @heurion/ssrf-guard（钉定 DNS + 逐跳校验 + 流式上限）。
 *
 * 测试通过 guard 的传输注入钩子断言「私网/超限 URL 在发请求前被拒」，
 * 并同时 stub global fetch 证明旧路径不再被使用。
 */
import { VisitMedicalSiteTool } from '../../src/tools/medical-web-tools.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'

const PUBLIC_IP = '140.82.121.4'

function htmlResponse(body: string): Response {
  return new Response(`<html><body>${body}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function ctx(): ToolContext {
  return { userId: 'u1', sessionId: 's1', eventLog: { append: vi.fn(), query: () => [] } } as unknown as ToolContext
}

beforeEach(() => {
  vi.stubEnv('URL_CACHE_ENABLED', 'false')
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '')
})

afterEach(() => {
  setGuardTransportForTest(null)
  setGuardLookupForTest(null)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('P0 SSRF: visit_medical_site 直连抓取护栏', () => {
  test('云元数据私网字面量 → 校验阶段拒绝，guard 传输与 global fetch 都不发请求', async () => {
    const globalFetch = vi.fn(async () => htmlResponse('SECRET-CLOUD-METADATA'))
    vi.stubGlobal('fetch', globalFetch)
    const transport = vi.fn(async () => htmlResponse('SECRET-CLOUD-METADATA'))
    setGuardTransportForTest(transport)

    const res = await new VisitMedicalSiteTool(ctx()).execute({ url: 'http://169.254.169.254/latest/meta-data' })

    expect(res.success).toBe(false)
    expect(res.output ?? '').not.toContain('SECRET-CLOUD-METADATA')
    expect(transport).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  test('响应超过大小上限（5MB）→ 流式读取中止，不落成 markdown', async () => {
    setGuardLookupForTest(async () => [{ address: PUBLIC_IP }])
    const big = `<html><body>${'x'.repeat(6 * 1024 * 1024)}</body></html>`
    setGuardTransportForTest(async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }))
    const globalFetch = vi.fn(async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', globalFetch)

    const res = await new VisitMedicalSiteTool(ctx()).execute({ url: 'https://huge.example.com/page' })

    expect(res.success).toBe(false)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  test('公网页面仍正常抓取（护栏不误伤），请求带 UA/Accept', async () => {
    setGuardLookupForTest(async () => [{ address: PUBLIC_IP }])
    const transport = vi.fn(async () => htmlResponse(`<h1>Guideline</h1>${'content '.repeat(200)}`))
    setGuardTransportForTest(transport)
    const globalFetch = vi.fn(async () => htmlResponse('legacy-path'))
    vi.stubGlobal('fetch', globalFetch)

    const res = await new VisitMedicalSiteTool(ctx()).execute({ url: 'https://guideline.example.com/page' })

    expect(res.success).toBe(true)
    expect(res.output).toContain('Guideline')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
    const init = transport.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['User-Agent']).toMatch(/Mozilla/)
    expect(init.headers.Accept).toMatch(/text\/html/)
  })
})
