/**
 * #875 — 受控 URL→文件下载(检索结果 OA 全文入库)。
 *
 * 安全边界:
 *  - 仅 http(s);
 *  - SSRF 防护:域名解析后拒绝私网/环回/链路本地地址(dns.lookup → IP 校验;
 *    手动重定向循环,每一跳都重新校验 — 防 OA 链接 302 到内网元数据端点);
 *  - #1057 校验与连接共用同一次 DNS 解析:校验解析出公网 IP 后用 node:http(s)
 *    的 lookup 选项钉定直连(Host/SNI 保留原域名),重定向逐跳重新钉定 —
 *    DNS rebinding TOCTOU(低 TTL 域名校验回公网、连接回内网)无法绕过;
 *  - 大小上限(maxBytes,默认 20MB,流式累计超限即断);
 *  - 总超时(timeoutMs,默认 30s,覆盖响应头与正文全程);
 *  - 内容校验:%PDF- magic bytes 才接受(本模块只服务 OA 全文 PDF 入库);
 *  - 付费墙红线:OA 归属校验由调用方完成(有 doi 时经 Unpaywall 验证,
 *    见 oa-pdf-tool.isOaUrlForDoi)。
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
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

/** IPv6 → 8 组 16-bit 展开形式；非法输入返回 null。支持零压缩（::）与
 *  嵌入 IPv4 尾段；仅供 isPrivateIp 处理已通过 isIP 校验的受控输入。
 *  #1057: 与 worker common.ts 同口径（全展开判定，覆盖 16 进制书写的
 *  IPv4-mapped 变体）。 */
function expandIpv6(addr: string): number[] | null {
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const groups: number[] = []
    const segs = s.split(':')
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg.includes('.')) {
        // 末段嵌入 IPv4（点分十进制）
        if (i !== segs.length - 1) return null
        const v4 = seg.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
        if (!v4) return null
        const o = v4.slice(1).map(Number)
        if (o.some((n) => n > 255)) return null
        groups.push(((o[0] << 8) | o[1]) & 0xffff, ((o[2] << 8) | o[3]) & 0xffff)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(seg)) return null
        groups.push(parseInt(seg, 16))
      }
    }
    return groups
  }
  const head = parseGroups(halves[0])
  if (!head) return null
  if (halves.length === 2) {
    const tail = parseGroups(halves[1])
    if (tail === null) return null
    if (head.length + tail.length > 7) return null
    return [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail]
  }
  return head.length === 8 ? head : null
}

/** 私网/环回/链路本地/保留地址判定(IPv4 段 + IPv6 前缀 + IPv4-mapped)。
 *  #1057: 与 worker common.ts 同口径 — 全展开判定替代字符串前缀匹配；
 *  补 CGNAT 100.64.0.0/10 与 198.18.0.0/15;修 ::ffff:0:0（IPv4-mapped
 *  未指定地址）旧 `::ffff:` 前缀递归对十六进制尾段（'0:0'）漏判的问题。
 *  无法解析的形态 fail-closed。 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // #1057: CGNAT 100.64.0.0/10
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true // #1057: 198.18.0.0/15
    if (a === 169 && b === 254) return true
    if (a >= 224) return true // 组播/保留
    return false
  }
  const groups = expandIpv6(raw)
  if (!groups) return true // #1057: 解析不了就拒绝（fail-closed）
  if (groups.every((g) => g === 0)) return true // '::' 未指定地址
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1 环回
  // ::/96 内嵌 IPv4（::ffff: 映射 / IPv4-compatible）→ 按内嵌 IPv4 重新判定
  // （含 ::ffff:0:0 → 0.0.0.0 → 私网）
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isPrivateIp(`${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`)
  }
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // 链路本地 fe80::/10
  if ((first >> 8) === 0xff) return true // 组播 ff00::/8
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

/* ── #1057: 校验与连接共用同一次 DNS 解析（钉定）───────────────────────
 * fetch(undici) 对传入 URL 会做第二次独立 DNS 解析 — 校验期解析到公网 IP
 * 过检后、连接期解析回 127.0.0.1/内网即可绕过整套黑名单（TOCTOU，与 worker
 * common.ts 同洞同修）。连接层改用 node:http(s) 并把校验解析出的公网 IP
 * 作为 `lookup` 钉定选项：TCP 连接只能打到校验时的地址，Host 头与 TLS SNI
 * 仍取自原始域名（证书校验不受影响）；重定向每一跳重新校验并重新钉定。 */

/** node dns.lookup 回调风格的钉定取址函数（作为 http(s) request 的 lookup
 *  选项传入；忽略 hostname，恒返回校验期钉定的 IP）。 */
export type PinnedLookup = (hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => void

/** #1057: 校验解析出的公网 IP → 钉定 lookup。 */
export function makePinnedLookup(ip: string): PinnedLookup {
  const family = isIP(ip) === 6 ? 6 : 4
  return (_hostname, _options, cb) => { cb(null, ip, family) }
}

export interface UrlTransportInit {
  signal: AbortSignal
  headers: Record<string, string>
  /** 钉定 lookup（校验期解析的 IP）；恒非 null（服务端无受信 origin 场景）。 */
  lookup: PinnedLookup
}

/** 传输层签名与 fetch 对齐（入参 (url, init) → Response），便于测试注入。 */
export type UrlTransport = (url: URL, init: UrlTransportInit) => Promise<Response>

let overrideTransport: UrlTransport | null = null

/** 测试钩子：注入传输层（单测无外网）；传 null 还原默认 node:http(s) 传输。 */
export function setUrlDownloadTransportForTest(fn: UrlTransport | null): void {
  overrideTransport = fn
}

/** #1057: 默认传输 — node:http(s) + 钉定 lookup。 */
async function defaultTransport(url: URL, init: UrlTransportInit): Promise<Response> {
  const mod = url.protocol === 'https:' ? https : http
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      lookup: init.lookup as unknown as http.RequestOptions['lookup'],
    }, resolve)
    req.on('error', reject)
    req.end()
  })
  const status = res.statusCode ?? 0
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers)) {
    if (v == null) continue
    for (const part of Array.isArray(v) ? v : [v]) headers.append(k, part)
  }
  // 204/205/304 不允许 body；其余把 IncomingMessage 转 web 流，
  // 调用方统一按 Response.body.getReader() 消费/取消。
  const bodyless = status === 204 || status === 205 || status === 304
  const body = bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream)
  return new Response(body, { status, headers })
}

/** 校验 URL 可达且公网:协议/主机名黑名单/DNS 解析地址全部公网。
 *  #1057: 返回值同时携带校验期钉定的首个公网 IP（连接层用它直连）。 */
interface PublicTarget { url: URL; address: string }
async function resolvePublicHttpUrl(raw: string, lookup: DnsLookup): Promise<PublicTarget> {
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
  const bare = host.replace(/^\[|\]$/g, '')
  let addresses: Array<{ address: string }>
  if (isIP(bare)) {
    addresses = [{ address: bare }] // IP 字面量免解析，直接走 IP 校验
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
  return { url, address: addresses[0].address } // #1057: 钉定校验这次解析的结果
}

/** 校验 URL 可达且公网(兼容旧签名:仅返回 URL,钉定地址供下载层内部使用)。 */
export async function assertPublicHttpUrl(raw: string, lookup: DnsLookup = defaultLookup): Promise<URL> {
  return (await resolvePublicHttpUrl(raw, lookup)).url
}

/** #1066-6: 不读的响应体（重定向/错误状态/超限预检失败）必须 cancel —
 *  否则挂起的响应占住 socket，多跳下载时连接池压力放大。 */
async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel() } catch { /* 已关闭 */ }
}

/** URL basename → 安全文件名(保 .pdf 后缀)。 */
export function filenameFromUrl(url: URL): string {
  const base = decodeURIComponent(url.pathname.split('/').pop() || '') || 'paper'
  const safe = sanitizeFilename(base) || 'paper'
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`
}

/**
 * 受控下载 PDF:校验(公网 + 钉定解析)→ 逐跳重定向(每跳重新校验 + 重新钉定)
 * → 流式读正文(超限即断)→ %PDF- magic bytes。成功返回 buffer 与派生文件名。
 */
export async function downloadPdfFromUrl(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; lookup?: DnsLookup } = {},
): Promise<{ buffer: Buffer; filename: string }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lookup = opts.lookup ?? defaultLookup
  const transport = overrideTransport ?? defaultTransport
  const first = await resolvePublicHttpUrl(raw, lookup)
  let target = first
  const deadline = Date.now() + timeoutMs

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new UrlDownloadError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    let res: Response
    try {
      res = await transport(target.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Heurion/1.0 (medical research agent)' },
        // #1057: lookup 是「校验时解析的那次结果」的钉定版 — 连接期不存在
        // 第二次 DNS 解析，rebinding 时序无法切换连接目标。
        lookup: makePinnedLookup(target.address),
      })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new UrlDownloadError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
      }
      throw new UrlDownloadError('fetch_failed', `下载失败: ${(err as Error).message.slice(0, 120)}`)
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) {
        await discardBody(res)
        throw new UrlDownloadError('fetch_failed', `重定向缺少 Location(HTTP ${res.status})`)
      }
      await discardBody(res) // #1066-6
      // #1057: 每跳重新解析并重新钉定该跳那次解析的结果
      target = await resolvePublicHttpUrl(new URL(loc, target.url).toString(), lookup)
      continue
    }
    if (!res.ok) {
      await discardBody(res) // #1066-6
      throw new UrlDownloadError('fetch_failed', `HTTP ${res.status} — 仅接受 OA 开放获取直链(付费墙/受保护链接不可入库)`)
    }

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) {
      await discardBody(res)
      throw new UrlDownloadError('too_large', `文件 ${Math.round(declared / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
    }

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
    return { buffer, filename: filenameFromUrl(target.url) }
  }
  throw new UrlDownloadError('fetch_failed', `重定向超过 ${MAX_REDIRECTS} 次,已中止`)
}
