/**
 * #875 — 受控 URL→文件下载(检索结果 OA 全文入库)。
 *
 * 安全边界:
 *  - 仅 http(s);
 *  - SSRF 防护:域名解析后拒绝私网/环回/链路本地地址(dns.lookup → IP 校验;
 *    手动重定向循环,每一跳都重新校验 — 防 OA 链接 302 到内网元数据端点);
 *  - 大小上限(maxBytes,默认 20MB,流式累计超限即断);
 *  - 总超时(timeoutMs,默认 30s,覆盖响应头与正文全程);
 *  - 内容校验:%PDF- magic bytes 才接受(本模块只服务 OA 全文 PDF 入库);
 *  - 付费墙红线:OA 归属校验由调用方完成(有 doi 时经 Unpaywall 验证,
 *    见 oa-pdf-tool.isOaUrlForDoi)。
 */
import dns from 'node:dns'
import { isIP } from 'node:net'
import { sanitizeFilename } from './upload-path.js'

export class UrlDownloadError extends Error {
  constructor(readonly code: 'invalid_url' | 'private_address' | 'too_large' | 'timeout' | 'not_pdf' | 'fetch_failed', message: string) {
    super(message)
    this.name = 'UrlDownloadError'
  }
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

/** 私网/环回/链路本地/保留地址判定(IPv4 段 + IPv6 前缀 + IPv4-mapped)。 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a >= 224) return true // 组播/保留
    return false
  }
  if (raw.startsWith('::ffff:')) return isPrivateIp(raw.slice(7))
  if (raw === '::' || raw === '::1') return true
  if (raw.startsWith('fe80')) return true
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true // ULA
  return false
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>

let overrideLookup: DnsLookup | null = null
const defaultLookup: DnsLookup = (hostname) =>
  (overrideLookup ? overrideLookup(hostname) : dns.promises.lookup(hostname, { all: true })) as Promise<Array<{ address: string }>>

/** 测试钩子:注入 DNS 解析结果(e2e 无外网);传 null 还原真实解析。 */
export function setUrlDownloadLookupForTest(fn: DnsLookup | null): void {
  overrideLookup = fn
}

/** 校验 URL 可达且公网:协议/主机名黑名单/DNS 解析地址全部公网。 */
export async function assertPublicHttpUrl(raw: string, lookup: DnsLookup = defaultLookup): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UrlDownloadError('invalid_url', 'URL 形式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlDownloadError('invalid_url', `仅支持 http(s),收到 ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UrlDownloadError('private_address', `拒绝内网主机: ${host}`)
  }
  let addresses: Array<{ address: string }>
  if (isIP(host.replace(/^\[|\]$/g, ''))) {
    addresses = [{ address: host }]
  } else {
    try {
      addresses = await lookup(host)
    } catch {
      throw new UrlDownloadError('fetch_failed', `域名解析失败: ${host}`)
    }
  }
  if (!addresses || addresses.length === 0) {
    throw new UrlDownloadError('fetch_failed', `域名解析无地址: ${host}`)
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new UrlDownloadError('private_address', `拒绝私网地址: ${host} → ${a.address}`)
    }
  }
  return url
}

/** URL basename → 安全文件名(保 .pdf 后缀)。 */
export function filenameFromUrl(url: URL): string {
  const base = decodeURIComponent(url.pathname.split('/').pop() || '') || 'paper'
  const safe = sanitizeFilename(base) || 'paper'
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`
}

/**
 * 受控下载 PDF:校验(公网)→ 逐跳重定向(每跳重新校验)→ 流式读正文
 * (超限即断)→ %PDF- magic bytes。成功返回 buffer 与派生文件名。
 */
export async function downloadPdfFromUrl(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; lookup?: DnsLookup } = {},
): Promise<{ buffer: Buffer; filename: string }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let url = await assertPublicHttpUrl(raw, opts.lookup)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Heurion/1.0 (medical research agent)' },
      })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new UrlDownloadError('timeout', `下载超时(${timeoutMs}ms): ${url.hostname}`)
      }
      throw new UrlDownloadError('fetch_failed', `下载失败: ${(err as Error).message.slice(0, 120)}`)
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new UrlDownloadError('fetch_failed', `重定向缺少 Location(HTTP ${res.status})`)
      url = await assertPublicHttpUrl(new URL(loc, url).toString(), opts.lookup)
      continue
    }
    if (!res.ok) {
      throw new UrlDownloadError('fetch_failed', `HTTP ${res.status} — 仅接受 OA 开放获取直链(付费墙/受保护链接不可入库)`)
    }

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new UrlDownloadError('too_large', `文件 ${Math.round(declared / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)

    const reader = res.body?.getReader()
    const chunks: Buffer[] = []
    let total = 0
    if (reader) {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>
        try {
          read = await reader.read()
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') throw new UrlDownloadError('timeout', `正文读取超时(${timeoutMs}ms)`)
          throw new UrlDownloadError('fetch_failed', `正文读取失败: ${(err as Error).message.slice(0, 120)}`)
        }
        if (read.done) break
        total += read.value.length
        if (total > maxBytes) {
          try { await reader.cancel() } catch { /* already closing */ }
          throw new UrlDownloadError('too_large', `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB(流式累计 ${total} 字节时中止)`)
        }
        chunks.push(Buffer.from(read.value))
      }
    }
    const buffer = Buffer.concat(chunks)
    if (!(buffer.length > 4 && buffer.slice(0, 5).toString('ascii') === '%PDF-')) {
      throw new UrlDownloadError('not_pdf', '内容不是 PDF(%PDF- magic bytes 校验失败) — 仅支持 OA 全文 PDF 直链入库')
    }
    return { buffer, filename: filenameFromUrl(url) }
  }
  throw new UrlDownloadError('fetch_failed', `重定向超过 ${MAX_REDIRECTS} 次,已中止`)
}
