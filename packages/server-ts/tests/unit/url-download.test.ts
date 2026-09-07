import { describe, test, expect, vi } from 'vitest'
import { isPrivateIp, assertPublicHttpUrl, downloadPdfFromUrl, UrlDownloadError } from '../../src/lib/url-download.js'

/**
 * #875 — 受控 URL→文件下载(检索结果 OA 全文入库)。
 * 安全边界:仅 http(s)/SSRF 防护(私网+逐跳重定向校验)/大小上限/PDF magic。
 */

describe('isPrivateIp', () => {
  test('IPv4 私网/环回/链路本地/保留段', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '140.82.121.4', '172.32.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  test('IPv6 环回/链路本地/ULA/IPv4-mapped', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    expect(isPrivateIp('2606:4700::1')).toBe(false)
  })
})

describe('assertPublicHttpUrl', () => {
  const okLookup = vi.fn(async () => [{ address: '140.82.121.4' }])
  const privateLookup = vi.fn(async () => [{ address: '10.1.2.3' }])

  test('非 http(s) → invalid_url', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/a.pdf', okLookup)).rejects.toMatchObject({ code: 'invalid_url' })
  })

  test('localhost/.local 主机名 → private_address(不发起 DNS)', async () => {
    await expect(assertPublicHttpUrl('http://localhost/a.pdf', okLookup)).rejects.toMatchObject({ code: 'private_address' })
    await expect(assertPublicHttpUrl('http://metadata.local/a.pdf', okLookup)).rejects.toMatchObject({ code: 'private_address' })
  })

  test('域名解析到私网 → private_address;公网 → 通过', async () => {
    await expect(assertPublicHttpUrl('http://internal.example.com/a.pdf', privateLookup)).rejects.toMatchObject({ code: 'private_address' })
    const url = await assertPublicHttpUrl('https://oa.example.com/a.pdf', okLookup)
    expect(url.hostname).toBe('oa.example.com')
  })

  test('IP 字面量私网 → private_address(不查 DNS)', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data', okLookup)).rejects.toMatchObject({ code: 'private_address' })
  })
})

describe('downloadPdfFromUrl', () => {
  function pdfResponse(bytes: Buffer, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(bytes, { status, headers })
  }
  const PDF = Buffer.from('%PDF-1.4\n%fake pdf bytes for test\n%%EOF')
  const okLookup = vi.fn(async () => [{ address: '140.82.121.4' }])

  test('HTTP 非 2xx/3xx → fetch_failed(付费墙/404 诚实报错)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('payment required', { status: 402 })))
    await expect(downloadPdfFromUrl('https://oa.example.com/paywalled.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'fetch_failed' })
  })

  test('非 PDF 内容 → not_pdf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse(Buffer.from('<html>landing page</html>'))))
    await expect(downloadPdfFromUrl('https://oa.example.com/landing', { lookup: okLookup })).rejects.toMatchObject({ code: 'not_pdf' })
  })

  test('重定向到私网 → private_address(逐跳校验)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } })))
    await expect(downloadPdfFromUrl('https://oa.example.com/redirect.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'private_address' })
  })

  test('重定向到公网 → 跟随并成功;文件名取自最终 URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://mirror.example.com/final/paper-v2.pdf' } }))
      .mockResolvedValueOnce(pdfResponse(PDF))
    vi.stubGlobal('fetch', fetchMock)
    const r = await downloadPdfFromUrl('https://oa.example.com/paper.pdf', { lookup: okLookup })
    expect(r.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(r.filename).toBe('paper-v2.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('Content-Length 超上限 → too_large(不发请求体读取)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse(PDF, 200, { 'content-length': String(21 * 1024 * 1024) })))
    await expect(downloadPdfFromUrl('https://oa.example.com/huge.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'too_large' })
  })
})
