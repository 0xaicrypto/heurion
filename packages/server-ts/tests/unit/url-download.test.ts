import { describe, test, expect, vi, afterEach } from 'vitest'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import {
  isPrivateIp,
  assertPublicHttpUrl,
  downloadPdfFromUrl,
  makePinnedLookup,
  UrlDownloadError,
  setUrlDownloadTransportForTest,
  type UrlTransportInit,
} from '../../src/lib/url-download.js'

/**
 * #875 — 受控 URL→文件下载(检索结果 OA 全文入库)。
 * 安全边界:仅 http(s)/SSRF 防护(私网+逐跳重定向校验)/大小上限/PDF magic。
 * #1057 — 校验与连接共用同一次 DNS 解析(钉定):传输层 init 携带钉定 lookup,
 * mock 传输可模拟连接期取址,断言「连接目标 = 校验解析结果」而非二次解析。
 */

/** 从传输 mock 的 init 里模拟连接期取址(钉定 lookup 回调风格)。
 *  #1074-1: 类型收敛到共享包后 lookup 为 `PinnedLookup | null`（worker 有
 *  受信 origin 不钉定的场景；server 路径恒钉定）— 加与 worker 同款守卫。 */
function connectViaPinned(init: UrlTransportInit): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!init.lookup) return reject(new Error('transport 未携带钉定 lookup — #1057 钉定缺失'))
    init.lookup('connect-target', {}, (err, address) => (err ? reject(err) : resolve(address)))
  })
}

afterEach(() => {
  setUrlDownloadTransportForTest(null)
})

describe('isPrivateIp', () => {
  test('IPv4 私网/环回/链路本地/保留段', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '140.82.121.4', '172.32.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  test('#1057 IPv4 补段:CGNAT 100.64.0.0/10 与 198.18.0.0/15', () => {
    for (const ip of ['100.64.0.0', '100.100.1.1', '100.127.255.255', '198.18.0.1', '198.19.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['100.1.2.3', '100.128.0.1', '198.17.255.255', '198.20.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  test('#1057 IPv6 全展开判定:环回/链路本地/ULA/IPv4-mapped(含十六进制变体)', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:0', '::127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    expect(isPrivateIp('2606:4700::1')).toBe(false)
  })
})

describe('P0: makePinnedLookup 兼容 Node ≥20 的 options.all 调用', () => {
  /** net.connect/happy-eyeballs（Node ≥20 默认开启）会以 { all: true } 调
   *  lookup 并要求数组回调；旧实现恒回 (err, address, family) 字符串，
   *  Node 22 下所有钉定连接直接报错（公网图片/OA PDF 下载全挂）。 */
  function callAll(lookup: ReturnType<typeof makePinnedLookup>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      ;(lookup as unknown as (
        host: string,
        opts: { all: boolean },
        cb: (err: Error | null, addresses: unknown) => void,
      ) => void)('ignored', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    })
  }

  test('all:true → 数组形状 [{ address, family }]（IPv4）', async () => {
    expect(await callAll(makePinnedLookup('140.82.121.4'))).toEqual([{ address: '140.82.121.4', family: 4 }])
  })

  test('all:true → family=6（IPv6 钉定）', async () => {
    expect(await callAll(makePinnedLookup('2606:4700::1'))).toEqual([{ address: '2606:4700::1', family: 6 }])
  })

  test('普通调用（无 all）→ 传统 (address, family) 形状', async () => {
    const address = await new Promise<unknown>((resolve, reject) => {
      makePinnedLookup('140.82.121.4')('ignored', {}, ((err: Error | null, addr: string) => (err ? reject(err) : resolve(addr))) as never)
    })
    expect(address).toBe('140.82.121.4')
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

  test('#1057 IP 黑名单缺口字面量 → private_address', async () => {
    await expect(assertPublicHttpUrl('http://100.100.1.1/a.pdf', okLookup)).rejects.toMatchObject({ code: 'private_address' })
    await expect(assertPublicHttpUrl('http://198.18.0.1/a.pdf', okLookup)).rejects.toMatchObject({ code: 'private_address' })
    await expect(assertPublicHttpUrl('http://[::ffff:0:0]/a.pdf', okLookup)).rejects.toMatchObject({ code: 'private_address' })
  })
})

describe('downloadPdfFromUrl', () => {
  function pdfResponse(bytes: Buffer, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(bytes, { status, headers })
  }
  const PDF = Buffer.from('%PDF-1.4\n%fake pdf bytes for test\n%%EOF')
  const okLookup = vi.fn(async () => [{ address: '140.82.121.4' }])

  test('HTTP 非 2xx/3xx → fetch_failed(付费墙/404 诚实报错)', async () => {
    setUrlDownloadTransportForTest(async () => new Response('payment required', { status: 402 }))
    await expect(downloadPdfFromUrl('https://oa.example.com/paywalled.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'fetch_failed' })
  })

  test('非 PDF 内容 → not_pdf', async () => {
    setUrlDownloadTransportForTest(async () => pdfResponse(Buffer.from('<html>landing page</html>')))
    await expect(downloadPdfFromUrl('https://oa.example.com/landing', { lookup: okLookup })).rejects.toMatchObject({ code: 'not_pdf' })
  })

  test('重定向到私网 → private_address(逐跳校验)', async () => {
    setUrlDownloadTransportForTest(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } }))
    await expect(downloadPdfFromUrl('https://oa.example.com/redirect.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'private_address' })
  })

  test('#1057 重定向逐跳重新校验并重新钉定该跳解析', async () => {
    const hopLookup = vi.fn()
      .mockResolvedValueOnce([{ address: '140.82.121.4' }])
      .mockResolvedValueOnce([{ address: '198.51.100.7' }])
    const connectAddrs: string[] = []
    setUrlDownloadTransportForTest(async (_url, init) => {
      connectAddrs.push(await connectViaPinned(init))
      if (connectAddrs.length === 1) return new Response(null, { status: 302, headers: { location: 'https://mirror.example.com/final/paper-v2.pdf' } })
      return pdfResponse(PDF)
    })
    const r = await downloadPdfFromUrl('https://oa.example.com/paper.pdf', { lookup: hopLookup })
    expect(r.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(r.filename).toBe('paper-v2.pdf')
    expect(hopLookup).toHaveBeenCalledTimes(2)
    // 每跳连接目标 = 该跳校验解析结果
    expect(connectAddrs).toEqual(['140.82.121.4', '198.51.100.7'])
  })

  test('#1057 rebinding 时序:lookup 首次回公网、连接期回 127.0.0.1 — 钉定后连接目标只能是校验解析结果', async () => {
    let lookups = 0
    const seqLookup = vi.fn(async () => {
      lookups++
      return lookups === 1 ? [{ address: '140.82.121.4' }] : [{ address: '127.0.0.1' }]
    })
    let connectAddr = ''
    setUrlDownloadTransportForTest(async (_url, init) => {
      connectAddr = await connectViaPinned(init)
      return pdfResponse(PDF)
    })
    const r = await downloadPdfFromUrl('https://evil.example.com/paper.pdf', { lookup: seqLookup })
    expect(r.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(connectAddr).toBe('140.82.121.4') // 连接用的是校验那次解析,不是二次解析
    expect(lookups).toBe(1) // 旧实现 fetch 会二次独立解析
  })

  test('#1057 重定向响应体被 cancel(#1066-6 同源清理)', async () => {
    let cancelled = false
    const stream = new ReadableStream({ cancel() { cancelled = true } })
    setUrlDownloadTransportForTest(async () => new Response(stream, { status: 302, headers: { location: 'http://169.254.169.254/x' } }))
    await expect(downloadPdfFromUrl('https://oa.example.com/redirect.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'private_address' })
    expect(cancelled).toBe(true)
  })

  test('重定向到公网 → 跟随并成功;文件名取自最终 URL', async () => {
    const transportMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://mirror.example.com/final/paper-v2.pdf' } }))
      .mockResolvedValueOnce(pdfResponse(PDF))
    setUrlDownloadTransportForTest(transportMock)
    const r = await downloadPdfFromUrl('https://oa.example.com/paper.pdf', { lookup: okLookup })
    expect(r.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(r.filename).toBe('paper-v2.pdf')
    expect(transportMock).toHaveBeenCalledTimes(2)
  })

  test('Content-Length 超上限 → too_large(不发请求体读取)', async () => {
    setUrlDownloadTransportForTest(async () => pdfResponse(PDF, 200, { 'content-length': String(21 * 1024 * 1024) }))
    await expect(downloadPdfFromUrl('https://oa.example.com/huge.pdf', { lookup: okLookup })).rejects.toMatchObject({ code: 'too_large' })
  })

  test('P1 gzip 炸弹(线缆 ~5KB 展开 5MB) → 解压中途 too_large', async () => {
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x41))
    setUrlDownloadTransportForTest(async () => pdfResponse(bomb, 200, { 'content-encoding': 'gzip' }))
    await expect(downloadPdfFromUrl('https://oa.example.com/bomb.pdf', { lookup: okLookup, maxBytes: 256 * 1024 }))
      .rejects.toMatchObject({ code: 'too_large' })
  })
})

/**
 * P1 防复发锁 — ssrf-guard 的所有 zlib 便捷解压必须显式上限（maxOutputLength），
 * 否则解压炸弹先物化超大 Buffer，二次长度检查只能救"已分配完"的内存峰值。
 */
describe('P1 解压炸弹防复发锁', () => {
  test('decodeContentEncoding 的 gunzip/inflate/br 全部传 zlibOpts(maxOutputLength)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../ssrf-guard/src/index.ts'), 'utf8')
    expect(src).toMatch(/const zlibOpts = \{ maxOutputLength:/)
    expect(src).toMatch(/gunzipSync\(body, zlibOpts\)/)
    expect(src).toMatch(/inflateSync\(body, zlibOpts\)/)
    expect(src).toMatch(/inflateRawSync\(body, zlibOpts\)/)
    expect(src).toMatch(/brotliDecompressSync\(body, zlibOpts\)/)
  })
})
