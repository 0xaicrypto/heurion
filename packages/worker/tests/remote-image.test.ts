import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import JSZip from 'jszip'
import http from 'node:http'
import dns from 'node:dns'
import { generatePptx, imageBudgetExceeded, MAX_EMBEDDED_IMAGE_BYTES } from '../src/handlers/pptx.js'
import {
  resolveImage,
  downloadRemoteImage,
  looksLikeImage,
  isPrivateIp,
  setRemoteImageLookupForTest,
  setRemoteImageTransportForTest,
} from '../src/handlers/common.js'

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
 * mock 方式：传输层注入（setRemoteImageTransportForTest，行为对齐旧版全局
 * fetch stub：入参 (url, init) → 返回 Response）+ DNS 解析注入
 * （setRemoteImageLookupForTest，单测无外网）；超时/大小上限通过
 * downloadRemoteImage 的 opts 依赖注入实现快速测试（resolveImage 本身
 * 走默认 10s / 20MB）。
 *
 * #1057 — 传输层 init 携带钉定 lookup（校验那次解析的 IP）：mock 传输可
 * 模拟连接期向钉定 lookup 取址，断言「连接目标 = 校验解析结果」而非二次解析。
 * #1058 — 相对路径 ref（/api/v1/files/download/...）按 SERVER_ORIGIN 拼绝对
 * URL 后走同一下载分支；跳块必须留下可观测日志。
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

/** 从传输 mock 的 init 里模拟连接期取址（钉定 lookup 回调风格）。 */
function connectViaPinned(init: { lookup: ((host: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => void) | null }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!init.lookup) return reject(new Error('transport 未携带钉定 lookup — #1057 钉定缺失'))
    init.lookup('connect-target', {}, (err, address) => (err ? reject(err) : resolve(address)))
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  setRemoteImageTransportForTest(fetchMock)
  // 默认：所有域名解析到公网 IP（SSRF 通过，逐用例覆写）。
  setRemoteImageLookupForTest(async () => [{ address: PUBLIC_IP }])
})

afterEach(() => {
  setRemoteImageLookupForTest(null)
  setRemoteImageTransportForTest(null)
  vi.unstubAllEnvs()
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

describe('#1057 DNS rebinding TOCTOU（校验与连接共用同一次解析）', () => {
  test('用例1: lookup 首次回公网、连接期回 127.0.0.1 — 钉定后连接目标只能是校验解析结果', async () => {
    let lookups = 0
    setRemoteImageLookupForTest(async () => {
      lookups++
      return lookups === 1 ? [{ address: PUBLIC_IP }] : [{ address: '127.0.0.1' }]
    })
    const connectAddrs: Array<string | null> = []
    fetchMock.mockImplementation(async (_url: unknown, init: Parameters<typeof connectViaPinned>[0]) => {
      connectAddrs.push(await connectViaPinned(init))
      return okResponse(PNG)
    })
    const img = await resolveImage({ type: 'image', ref: 'https://evil.example.com/a.png' })
    expect(img?.data.equals(PNG)).toBe(true)
    // 连接期取到的地址 = 校验时那次解析（公网），而非二次解析的 127.0.0.1；
    // 且校验只发生一次 DNS 解析（旧实现 fetch 会二次独立解析）。
    expect(connectAddrs).toEqual([PUBLIC_IP])
    expect(lookups).toBe(1)
  })

  test('用例1b: 真实双解析时序（真实 socket）— 钉定后攻击者本地服务器零请求', async () => {
    setRemoteImageTransportForTest(null) // 走默认 node:http 真实传输
    setRemoteImageLookupForTest(null) // 校验也走「真实」解析器（下方 dns 打补丁）
    let hits = 0
    const attacker = http.createServer((_req, res) => {
      hits++
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    })
    await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve))
    // 伪造真实 DNS：首次解析回公网 IP（过检），之后一律回 127.0.0.1（attacker）。
    // 旧实现（校验与连接各自解析）会连进 attacker；钉定后不可能。
    let lookups = 0
    const fake = () => (++lookups === 1 ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
    const realPromisesLookup = dns.promises.lookup
    const realLookup = dns.lookup
    ;(dns.promises as any).lookup = async () => fake()
    ;(dns as any).lookup = (host: string, opts: any, cb: any) => {
      const r = fake()
      if (typeof opts === 'function') return opts(null, r[0].address, r[0].family)
      if (opts?.all) return cb(null, r)
      return cb(null, r[0].address, r[0].family)
    }
    try {
      const port = (attacker.address() as { port: number }).port
      // 钉定到公网 IP → 连不回 attacker（受 timeoutMs 约束，快速失败或超时都算拒绝）。
      await expect(
        downloadRemoteImage(`http://rebind.example.com:${port}/fig.png`, { timeoutMs: 900 }),
      ).rejects.toThrow()
      expect(hits).toBe(0)
      expect(lookups).toBeGreaterThanOrEqual(1) // 校验确实解析过一次
    } finally {
      ;(dns.promises as any).lookup = realPromisesLookup
      ;(dns as any).lookup = realLookup
      await new Promise<void>((resolve) => attacker.close(() => resolve()))
    }
  }, 10_000)

  test('用例2: IP 黑名单缺口字面量（CGNAT/基准测试段/::ffff:0:0）→ 全部拒绝', async () => {
    for (const ref of [
      'http://100.100.1.1/a.png', // CGNAT 100.64.0.0/10
      'http://198.18.0.1/a.png', // 198.18.0.0/15 基准测试保留段
      'http://[::ffff:0:0]/a.png', // IPv4-mapped 未指定地址
    ]) {
      expect(await resolveImage({ type: 'image', ref }), ref).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('用例3: 重定向到新域名 — 每跳重新解析并钉定该跳那次解析', async () => {
    const seq: Record<string, string> = { 'cdn.example.com': PUBLIC_IP, 'other.example.com': '198.51.100.7' }
    setRemoteImageLookupForTest(async (host) => {
      const ip = seq[host]
      if (!ip) throw new Error(`unexpected host ${host}`)
      return [{ address: ip }]
    })
    const connectAddrs: string[] = []
    fetchMock
      .mockImplementationOnce(async (_url: unknown, init: Parameters<typeof connectViaPinned>[0]) => {
        connectAddrs.push(await connectViaPinned(init))
        return redirectResponse('https://other.example.com/real.png')
      })
      .mockImplementationOnce(async (_url: unknown, init: Parameters<typeof connectViaPinned>[0]) => {
        connectAddrs.push(await connectViaPinned(init))
        return okResponse(PNG)
      })
    const img = await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })
    expect(img?.data.equals(PNG)).toBe(true)
    // 第二跳连接目标 = 第二跳校验解析结果（不是第一跳的 IP，也不是二次解析）。
    expect(connectAddrs).toEqual([PUBLIC_IP, '198.51.100.7'])
  })

  test('用例4: 重定向到私网字面量（回归）→ 仍拒绝', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('http://100.100.1.1/secret.png'))
    expect(await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('#1058 相对路径 ref（deck 手动插图不再静默丢失）', () => {
  test('用例1: /api/v1/files/download/... 相对路径 → 按 SERVER_ORIGIN 拼绝对 URL 下载嵌入', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'https://files.example.com')
    fetchMock.mockResolvedValue(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: '/api/v1/files/download/abc123?token=t', caption: 'Fig' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(img?.caption).toBe('Fig')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://files.example.com/api/v1/files/download/abc123?token=t')
  })

  test('用例2: 相对路径指向不存在文件（404）→ 跳块 + 可观测日志，不中断', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'https://files.example.com')
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveImage({ type: 'image', ref: '/api/v1/files/download/gone?token=t' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REMOTE-IMAGE'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetch_failed'))
    warn.mockRestore()
  })

  test('用例3: 绝对 URL 回归 — 行为不变（SSRF 校验照常）', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'https://files.example.com')
    fetchMock.mockResolvedValue(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cdn.example.com/fig.png')
  })

  test('未配置 SERVER_ORIGIN/BACKEND_URL → 跳块 + 可观测日志（不静默吞图）', async () => {
    delete process.env.SERVER_ORIGIN
    delete process.env.BACKEND_URL
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveImage({ type: 'image', ref: '/api/v1/files/download/abc' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REMOTE-IMAGE'))
    warn.mockRestore()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('非下载前缀的相对路径（如 /etc/passwd）→ null + 日志，不发起请求', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'https://files.example.com')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveImage({ type: 'image', ref: '/etc/passwd' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REMOTE-IMAGE'))
    warn.mockRestore()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('SERVER_ORIGIN 为私网地址（内网部署）→ 受信 origin 放行 SSRF IP 校验', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'http://127.0.0.1:8000')
    fetchMock.mockResolvedValue(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: '/api/v1/files/download/x' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8000/api/v1/files/download/x')
  })

  test('绝对 URL 不受受信 origin 影响 — 私网仍拒绝（信任只给相对路径派生）', async () => {
    vi.stubEnv('SERVER_ORIGIN', 'http://127.0.0.1:8000')
    expect(await resolveImage({ type: 'image', ref: 'http://127.0.0.1:8000/api/v1/files/download/x' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('BACKEND_URL 兼容别名同样生效', async () => {
    vi.stubEnv('BACKEND_URL', 'https://api.example.net')
    fetchMock.mockResolvedValue(okResponse(PNG))
    expect(await resolveImage({ type: 'image', ref: '/api/v1/files/download/y' })).not.toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.net/api/v1/files/download/y')
  })
})

describe('#1066 worker 可观测性/资源清理', () => {
  test('子项6: 重定向响应体被 cancel（不悬挂 socket）', async () => {
    let cancelled = false
    const stream = new ReadableStream({ cancel() { cancelled = true } })
    fetchMock
      .mockResolvedValueOnce(new Response(stream, { status: 302, headers: { location: 'https://cdn.example.com/real.png' } }))
      .mockResolvedValueOnce(okResponse(PNG))
    const img = await resolveImage({ type: 'image', ref: 'https://cdn.example.com/fig.png' })
    expect(img?.data.equals(PNG)).toBe(true)
    expect(cancelled).toBe(true)
  })

  test('子项7: SSRF 拦截也留下可观测日志（原因含 RemoteImageError code）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveImage({ type: 'image', ref: 'http://127.0.0.1/a.png' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('private_address'))
    warn.mockRestore()
  })

  test('子项8: 超内嵌图片预算 → 后续图片块跳过 + 可观测日志，导出不中断', async () => {
    vi.stubEnv('PPTX_IMAGE_BUDGET_BYTES', '1200')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bigPng = Buffer.concat([PNG, Buffer.alloc(800, 1)]) // 816 字节
    const res = await generatePptx({
      schema_version: 1,
      content_type: 'sidecar.generate_pptx',
      data: {
        schemaVersion: 1,
        title: '图片预算',
        slides: [
          { title: '一', layout: 'bullets+image', content: [{ type: 'image', ref: 'x', data: bigPng.toString('base64') }] },
          { title: '二', layout: 'bullets+image', content: [{ type: 'image', ref: 'y', data: bigPng.toString('base64') }] },
          { title: '三', layout: 'bullets+image', content: [{ type: 'image', ref: 'z', data: bigPng.toString('base64') }] },
        ],
      },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1066-8'))
    warn.mockRestore()
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/') && !n.endsWith('/'))
    expect(media.length).toBe(1) // 第一张 816B 内嵌；第二张起 816+816 > 1200 超预算跳过
  })

  test('子项8: imageBudgetExceeded 边界（预算内不超、恰好等于不超、超 1 字节即超）', () => {
    expect(imageBudgetExceeded(0, 100, 100)).toBe(false)
    expect(imageBudgetExceeded(100, 1, 100)).toBe(true)
    expect(imageBudgetExceeded(50, 50, 100)).toBe(false)
    expect(imageBudgetExceeded(0, MAX_EMBEDDED_IMAGE_BYTES + 1)).toBe(true)
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
  test('isPrivateIp 覆盖组播/保留/IPv4-mapped/ULA/#1057 CGNAT 与 198.18.0.0/15', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1', 'ff02::1',
      // #1057: CGNAT 100.64.0.0/10 与基准测试保留段 198.18.0.0/15
      '100.64.0.0', '100.100.1.1', '100.127.255.255', '198.18.0.1', '198.19.255.255',
      // #1057: IPv4-mapped 未指定地址（内核语义等同 ::/0.0.0.0）
      '::ffff:0:0']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.255.255', '100.1.2.3', '100.128.0.1', '198.17.255.255', '198.20.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
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
