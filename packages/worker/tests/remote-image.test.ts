import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generatePptx } from '../src/handlers/pptx.js'
import { resolveImage, downloadRemoteImage, looksLikeImage, isPrivateIp, setRemoteImageLookupForTest } from '../src/handlers/common.js'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

// resolveImage 的 asset:// 分支内部 `await import('node:fs/promises')` —
// 拦截 readFile 以隔离本地文件系统（同 asset-ref.test.ts 口径）。
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => Buffer.from('asset-svg-bytes')),
}))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))

/**
 * #1053 — 托管 http(s) URL 图片导出：resolveImage 补 url→Buffer 下载分支，
 * 不再静默丢图。安全约束（SSRF 防护）与"失败返回 null、缺图跳块不中断导出"
 * 语义是本文件的核心验证点。
 *
 * mock 方式：全局 fetch stub（vi.stubGlobal）+ DNS 解析注入
 * （setRemoteImageLookupForTest，单测无外网）；超时/大小上限通过
 * downloadRemoteImage 的 opts 依赖注入实现快速测试（resolveImage 本身
 * 走默认 10s / 20MB）。
 */

// 16 字节最小 PNG 头（同 generators.test.ts 口径）。
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PUBLIC_IP = '93.184.216.34'

let fetchMock: ReturnType<typeof vi.fn>

function okResponse(body: Buffer | ReadableStream, headers: Record<string, string> = {}): Response {
  return new Response(body as any, { status: 200, headers })
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // 默认：所有域名解析到公网 IP（SSRF 通过，逐用例覆写）。
  setRemoteImageLookupForTest(async () => [{ address: PUBLIC_IP }])
})

afterEach(() => {
  setRemoteImageLookupForTest(null)
  vi.unstubAllGlobals()
})

describe('#1053 resolveImage http(s) 分支（用例 1）', () => {
  test('ref 为 https URL：下载成功 → 返回 Buffer + caption', async () => {
    fetchMock.mockResolvedValue(okResponse(PNG, { 'content-length': String(PNG.length) }))
    const img = await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png', caption: 'Fig 1' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(img?.caption).toBe('Fig 1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cdn.example.com/fig.png')
  })

  test('http 明文 URL 同样支持（公网 IP 直连）', async () => {
    fetchMock.mockResolvedValue(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: `http://${PUBLIC_IP}/a.png` })
    expect(img?.data.equals(PNG)).toBe(true)
  })

  test('合法重定向（同协议同 scheme）→ 跟随并嵌入最终图片', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse('https://cdn.example.com/real.png'))
      .mockResolvedValueOnce(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://cdn.example.com/real.png')
  })
})

describe('#1053 SSRF 负例（用例 2）', () => {
  test('内网主机名 → null 且未发起任何请求', async () => {
    for (const ref of [
      'http://localhost/a.png',
      'http://sub.localhost/a.png',
      'http://api.internal/a.png',
      'http://x.local/a.png',
    ]) {
      expect(await resolveImage({ type: 'image', ref }), ref).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('私网/环回/链路本地/组播 IP 字面量 → null 且未发起请求', async () => {
    for (const ref of [
      'http://127.0.0.1/a.png',
      'http://10.0.0.5/a.png',
      'http://192.168.1.1/a.png',
      'http://172.16.0.1/a.png',
      'http://169.254.169.254/latest/meta-data', // 云厂商元数据端点
      'http://0.0.0.0/a.png',
      'http://224.0.0.1/a.png', // 组播
      'http://255.255.255.255/a.png', // 广播/保留
      'http://[::1]/a.png',
      'http://[fe80::1]/a.png', // IPv6 链路本地
      'http://[fd00::1]/a.png', // IPv6 ULA
      'http://[::ffff:127.0.0.1]/a.png', // IPv4-mapped（点分十进制形式）
      'http://[::ffff:7f00:1]/a.png', // IPv4-mapped（16 进制书写形式）
      'http://[::127.0.0.1]/a.png', // 废弃的 IPv4-compatible 形式
    ]) {
      expect(await resolveImage({ type: 'image', ref }), ref).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('非 http(s) 协议 → null', async () => {
    for (const ref of ['ftp://cdn.example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA']) {
      expect(await resolveImage({ type: 'image', ref }), ref).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('DNS rebinding：域名解析为私网 IP → null 且未发起请求', async () => {
    setRemoteImageLookupForTest(async () => [{ address: '192.168.0.9' }])
    expect(await resolveImage({ type: 'image', ref: 'https://evil.example.com/a.png' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('重定向跳到私网地址 → null（每一跳重新校验）', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('http://127.0.0.1/secret.png'))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('重定向跨协议（https → http 降级）→ null', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('http://cdn.example.com/fig.png'))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('重定向超过 5 跳 → null', async () => {
    fetchMock.mockImplementation(async () => redirectResponse('https://cdn.example.com/next.png'))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })).toBeNull()
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6)
  })
})

describe('#1053 超时/超限/非图片负例（用例 3）', () => {
  test('下载超时 → 失败（AbortController 触发）', async () => {
    fetchMock.mockImplementation((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
    )
    await expect(downloadRemoteImage('https://cdn.example.com/slow.png', { timeoutMs: 80 })).rejects.toThrow(/超时/)
  })

  test('正文读取超过总超时 → 中止（流间 deadline 检查）', async () => {
    const chunk = new Uint8Array(8192)
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(chunk) },
      // 定时吐块：让事件循环得以推进，deadline（Date.now）检查可触发。
      pull(c) { setTimeout(() => { try { c.enqueue(chunk) } catch { /* cancelled */ } }, 5) },
    }), { status: 200 }))
    // maxBytes 放开（Infinity），单独验证 deadline 维度。
    await expect(downloadRemoteImage('https://cdn.example.com/trickle.png', { timeoutMs: 80, maxBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/超时/)
  })

  test('content-length 超上限 → 不读正文直接失败（默认 20MB）', async () => {
    fetchMock.mockResolvedValue(okResponse(PNG, { 'content-length': String(21 * 1024 * 1024) }))
    await expect(downloadRemoteImage('https://cdn.example.com/big.png')).rejects.toThrow(/上限/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('流式累计超上限 → 中止读取', async () => {
    const chunk = new Uint8Array(1024)
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(chunk) },
      pull(c) { c.enqueue(chunk) },
    }), { status: 200 }))
    await expect(downloadRemoteImage('https://cdn.example.com/big.png', { maxBytes: 4096 })).rejects.toThrow(/上限/)
  })

  test('非图片内容（HTML 错误页）→ resolveImage 返回 null', async () => {
    fetchMock.mockResolvedValue(okResponse(Buffer.from('<html><body>404 not found</body></html>'), { 'content-type': 'text/html' }))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/a.png' })).toBeNull()
  })

  test('HTTP 404 / 网络异常 / DNS 解析失败 → null，不中断', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/a.png' })).toBeNull()

    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/a.png' })).toBeNull()

    setRemoteImageLookupForTest(async () => { throw new Error('NXDOMAIN') })
    expect(await resolveImage({ type: 'image', ref: 'https://nope.example.com/a.png' })).toBeNull()
  })
})

describe('#1053 既有路径回归（用例 4）', () => {
  test('inline base64 data 不走网络', async () => {
    const img = await resolveImage({ type: 'image', ref: 'inline', data: PNG.toString('base64') })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('data: URL 形式的 inline base64', async () => {
    const img = await resolveImage({ type: 'image', ref: 'inline', data: `data:image/png;base64,${PNG.toString('base64')}` })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('asset:// 走本地文件读取，不走网络', async () => {
    const img = await resolveImage({ type: 'image', ref: 'asset://chart.svg', caption: 'Fig' })
    expect(img?.data.toString()).toBe('asset-svg-bytes')
    expect(img?.caption).toBe('Fig')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('#1053 deck 导出整链路（用例 5）', () => {
  test('URL 图片 deck → pptx media 中含图片对象（解 zip 断言）', async () => {
    fetchMock.mockResolvedValue(okResponse(PNG, { 'content-length': String(PNG.length) }))
    const res = await generatePptx({
      schema_version: 1,
      content_type: 'sidecar.generate_pptx',
      data: {
        schemaVersion: 1,
        title: 'URL 图片导出',
        slides: [
          { title: '结果', layout: 'bullets+image', content: [{ type: 'image', ref: 'https://cdn.example.com/fig.png' }] },
        ],
      },
    })
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer)
    // pptxgenjs 总会写一个空的 ppt/media/ 目录条目 — 只看其中的文件。
    const mediaNames = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/') && !n.endsWith('/'))
    expect(mediaNames.length).toBeGreaterThan(0)
    let embedded = false
    for (const n of mediaNames) {
      const bytes = await zip.files[n].async('nodebuffer')
      if (bytes.subarray(0, 8).equals(PNG.subarray(0, 8))) embedded = true
    }
    expect(embedded).toBe(true)
  })

  test('URL 图片下载失败（内网）→ 块跳过，导出仍成功且无 media', async () => {
    const res = await generatePptx({
      schema_version: 1,
      content_type: 'sidecar.generate_pptx',
      data: {
        schemaVersion: 1,
        title: '内网图不中断',
        slides: [
          { title: '结果', layout: 'bullets+image', content: [{ type: 'image', ref: 'http://localhost/fig.png' }] },
        ],
      },
    })
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer)
    expect(Object.keys(zip.files).some((n) => n.startsWith('ppt/media/') && !n.endsWith('/'))).toBe(false)
  })
})

describe('#1053 单元：isPrivateIp / looksLikeImage', () => {
  test('isPrivateIp 覆盖组播/保留/IPv4-mapped/ULA', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1', 'ff02::1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.255.255', '100.1.2.3', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  test('looksLikeImage 按 magic bytes 识别 png/jpeg/gif/webp/bmp/svg，拒绝 HTML', () => {
    expect(looksLikeImage(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true) // PNG
    expect(looksLikeImage(Buffer.from('ffd8ffe000104a46', 'hex'))).toBe(true) // JPEG
    expect(looksLikeImage(Buffer.from('GIF89a'))).toBe(true) // GIF
    expect(looksLikeImage(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '))).toBe(true) // WebP
    expect(looksLikeImage(Buffer.from('BM\x00\x00\x00\x00'))).toBe(true) // BMP
    expect(looksLikeImage(Buffer.from('  <?xml version="1.0"?><svg xmlns=""/>\n'))).toBe(true) // SVG
    expect(looksLikeImage(Buffer.from('<svg viewBox="0 0 1 1"/>'))).toBe(true) // SVG 无 xml 头
    expect(looksLikeImage(Buffer.from('<html><body>nope</body></html>'))).toBe(false)
    expect(looksLikeImage(Buffer.from('%PDF-1.4'))).toBe(false)
    expect(looksLikeImage(Buffer.from('hi'))).toBe(false)
    expect(looksLikeImage(Buffer.alloc(0))).toBe(false)
  })
})
