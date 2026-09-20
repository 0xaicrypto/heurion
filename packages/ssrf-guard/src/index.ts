/**
 * @heurion/ssrf-guard — #1074-1 共享 SSRF 加固下载核心。
 *
 * 此前 worker/src/handlers/common.ts 与 server-ts/src/lib/url-download.ts
 * 逐字重复维护同一套安全边界（校验/钉定/重定向循环/流式上限），已现 drift
 * （超时 10s vs 30s、worker 多受信 origin 白名单、worker 拒绝重定向跨协议而
 * server 不校验）。安全关键代码靠人肉同步是架构风险 — 本包把两边收敛为
 * 单一实现，差异项以显式参数传入（见 GuardDownloadOptions 注释），两消费方
 * 只留薄封装。
 *
 * 安全边界（两消费方共用）：
 *  - 仅 http/https；
 *  - 主机名黑名单（localhost / *.localhost / *.local / *.internal）；
 *  - SSRF 防护：DNS 解析后的全部 IP 必须公网（禁环回/私网/链路本地/CGNAT/
 *    组播/保留段，含 IPv4-mapped IPv6 全展开判定），重定向每一跳都重新校验；
 *  - #1057 校验与连接共用同一次 DNS 解析（钉定 lookup）— DNS rebinding
 *    TOCTOU（校验回公网、连接回内网）无法绕过；重定向逐跳重新钉定；
 *  - #1072-3 重定向每跳的 DNS 解析纳入总 deadline（lookup 支持信号，
 *    慢/挂起 DNS 在 deadline 处被中止，不能把单请求拖过 timeoutMs）；
 *  - 总超时（覆盖每跳 DNS、响应头与正文全程）+ 大小上限
 *    （content-length 预检 + 流式累计超限即断 + 解压后二次上限防炸弹）；
 *  - #1072-4 显式 Content-Encoding 处理 — 裸 node:http 传输不像 fetch
 *    那样自动解压，gzip/deflate/br 响应体先解压再做 magic bytes 判定；
 *  - 不读的响应体（重定向/错误状态/超限预检失败）必须 cancel（#1066-6，
 *    防挂起响应占住 socket）；
 *  - 全内存处理不落盘。
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib'
import { Readable } from 'node:stream'

/** #1074-1: 两消费方共享的错误类型。worker 侧以 RemoteImageError 别名导出、
 *  server 侧以 UrlDownloadError 别名导出（既有的 instanceof 消费方不受影响）；
 *  code 并集包含两侧词汇（worker 产出 not_image、server 产出 not_pdf）。 */
export class GuardError extends Error {
  constructor(readonly code: 'invalid_url' | 'private_address' | 'too_large' | 'timeout' | 'not_image' | 'not_pdf' | 'fetch_failed', message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

/* ── IP 私网判定 ─────────────────────────────────────────────────────── */

/** IPv6 → 8 组 16-bit 展开形式；非法输入返回 null。支持零压缩（::）与
 *  嵌入 IPv4 尾段；仅供 isPrivateIp 处理已通过 isIP 校验的受控输入。 */
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

/** 私网/环回/链路本地/组播/保留地址判定（IPv4 段 + IPv6 前缀 + 内嵌 IPv4）。
 *  原 worker common.ts 与 server-ts url-download.ts 双实现收敛（#1074-1）。
 *  IPv6 走全展开判定，覆盖 16 进制书写的 IPv4-mapped（如 ::ffff:7f00:1）与
 *  废弃的 IPv4-compatible（::127.0.0.1）等字符串前缀匹配会漏掉的变体。
 *  #1057: 含 CGNAT 100.64.0.0/10 与基准测试保留段 198.18.0.0/15；并修
 *  ::ffff:0:0（IPv4-mapped 未指定地址，内核语义等同 loopback/未指定）
 *  被旧条件排除在判定外的缺口 — 现统一按内嵌 IPv4 重新判定（0.0.0.0 → 私网）。
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
  if (!groups) return true // #1053: 解析不了就拒绝（fail-closed）
  if (groups.every((g) => g === 0)) return true // '::' 未指定地址
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1 环回
  // ::/96 内嵌 IPv4（::ffff: 映射 / IPv4-compatible）→ 按内嵌 IPv4 重新判定。
  // #1057: 去掉「内嵌地址非零」门槛 — ::ffff:0:0 的内嵌 0.0.0.0 同样判私网。
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isPrivateIp(`${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`)
  }
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // 链路本地 fe80::/10
  if ((first >> 8) === 0xff) return true // 组播 ff00::/8
  return false
}

/* ── DNS 解析（#1072-3: 支持总 deadline 信号）────────────────────────── */

export type DnsLookup = (hostname: string, opts?: { signal?: AbortSignal }) => Promise<Array<{ address: string }>>

let overrideLookup: DnsLookup | null = null

/** 测试钩子：注入 DNS 解析结果（单测/CI 无外网）；传 null 还原真实解析。 */
export function setGuardLookupForTest(fn: DnsLookup | null): void {
  overrideLookup = fn
}

/** 把已 started 的 promise 与 abort 信号竞速 — 信号触发即以 timeout 拒绝。
 *  底层解析线程无法真正取消，但等待方不再被挂起（结果被丢弃）。 */
function raceDeadline<T>(p: Promise<T>, signal: AbortSignal, host: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new GuardError('timeout', `DNS 解析超出总 deadline，已中止(慢 DNS 不能逃出 timeoutMs) — ${host}`))
      return
    }
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(new GuardError('timeout', `DNS 解析超出总 deadline，已中止(慢 DNS 不能逃出 timeoutMs) — ${host}`))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { if (!settled) { settled = true; cleanup(); resolve(v) } },
      (e) => { if (!settled) { settled = true; cleanup(); reject(e) } },
    )
  })
}

/** 默认解析器：node dns.promises.lookup(all)。#1072-3: 传入 deadline 信号时
 *  与解析竞速 — 慢/挂起 DNS 在总 deadline 处被中止，不再逃出 timeoutMs。 */
export function defaultDnsLookup(hostname: string, opts?: { signal?: AbortSignal }): Promise<Array<{ address: string }>> {
  if (overrideLookup) return overrideLookup(hostname, opts)
  const p = dns.promises.lookup(hostname, { all: true }) as Promise<Array<{ address: string }>>
  if (!opts?.signal) return p
  return raceDeadline(p, opts.signal, hostname)
}

/* ── 钉定（#1057: 校验与连接共用同一次 DNS 解析）──────────────────────── */

/** node dns.lookup 回调风格的钉定取址函数（作为 http(s) request 的 lookup
 *  选项传入；忽略 hostname，恒返回校验期钉定的 IP）。 */
export type PinnedLookup = (hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => void

/** #1057: 校验解析出的公网 IP → 钉定 lookup。 */
export function makePinnedLookup(ip: string): PinnedLookup {
  const family = isIP(ip) === 6 ? 6 : 4
  return (_hostname, _options, cb) => { cb(null, ip, family) }
}

/* ── 传输层 ──────────────────────────────────────────────────────────── */

export interface GuardTransportInit {
  signal: AbortSignal
  headers: Record<string, string>
  /** 钉定 lookup（校验期解析的 IP）；null = 受信 origin 不钉定（常规解析）。 */
  lookup: PinnedLookup | null
}

/** 传输层签名与 fetch 对齐（入参 (url, init) → Response），便于测试注入。 */
export type GuardTransport = (url: URL, init: GuardTransportInit) => Promise<Response>

let overrideTransport: GuardTransport | null = null

/** 测试钩子：注入传输层（单测无外网）；传 null 还原默认 node:http(s) 传输。 */
export function setGuardTransportForTest(fn: GuardTransport | null): void {
  overrideTransport = fn
}

/** #1057/#1074-1: 默认（生产）传输 — 裸 node:http(s) + 钉定 lookup。
 *  #1072-4: e2e 直达本函数（不经测试注入钩子）验证生产路径。注意本传输
 *  不会自动解压 Content-Encoding（与 fetch 行为不同）— 解压由下载核心
 *  统一显式处理。 */
export async function defaultTransport(url: URL, init: GuardTransportInit): Promise<Response> {
  const mod = url.protocol === 'https:' ? https : http
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      lookup: (init.lookup ?? undefined) as http.RequestOptions['lookup'],
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
  // 下载核心统一按 Response.body.getReader() 消费/取消。
  const bodyless = status === 204 || status === 205 || status === 304
  const body = bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream)
  return new Response(body, { status, headers })
}

/* ── URL 校验 ────────────────────────────────────────────────────────── */

/** 校验 URL 可达且公网：协议/受信 origin/主机名黑名单/DNS 解析地址全部公网。
 *  #1057: 返回校验期解析钉定的首个公网 IP（受信 origin 返回 null = 不钉定）。
 *  #1072-3: 可传入总 deadline 信号 — DNS 解析被纳入 deadline（见
 *  defaultDnsLookup 的竞速；注入的 lookup 也按约定接收信号）。 */
export interface PublicTarget { url: URL; address: string | null }

export async function resolvePublicHttpUrl(
  raw: string,
  opts: { lookup?: DnsLookup; trustedOrigins?: readonly string[]; signal?: AbortSignal } = {},
): Promise<PublicTarget> {
  const lookup = opts.lookup ?? defaultDnsLookup
  const trustedOrigins = opts.trustedOrigins ?? []
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new GuardError('invalid_url', 'URL 形式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GuardError('invalid_url', `仅支持 http(s)，收到 ${url.protocol}`)
  }
  // #1058: 操作员显式配置的受信 origin（worker 相对路径 ref 的基址）— 域名
  // 黑名单与 IP 黑名单一并跳过（内网部署时 server 地址本就是私网）。
  // #1074-1 drift：server 侧恒传 []（无受信 origin 场景，行为不变）。
  if (trustedOrigins.includes(url.origin)) {
    return { url, address: null }
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new GuardError('private_address', `拒绝内网主机: ${host}`)
  }
  const bare = host.replace(/^\[|\]$/g, '')
  let addresses: Array<{ address: string }>
  if (isIP(bare)) {
    addresses = [{ address: bare }] // IP 字面量免解析，直接走 IP 校验
  } else {
    try {
      addresses = await lookup(host, { signal: opts.signal })
    } catch {
      // #1072-3: deadline 信号已触发 → 无论底层错误形态（竞速败者的
      // GuardError timeout / 注入 lookup 的 AbortError / 真实解析错误），
      // 一律按超时上报 — 慢/挂起 DNS 不能逃出 timeoutMs。
      if (opts.signal?.aborted) {
        throw new GuardError('timeout', `DNS 解析超出总 deadline，已中止(慢 DNS 不能逃出 timeoutMs) — ${host}`)
      }
      throw new GuardError('fetch_failed', `域名解析失败: ${host}`)
    }
  }
  if (!addresses || addresses.length === 0) {
    throw new GuardError('fetch_failed', `域名解析无地址: ${host}`)
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new GuardError('private_address', `拒绝私网地址: ${host} → ${a.address}`)
    }
  }
  return { url, address: addresses[0].address } // #1057: 钉定校验这次解析的结果
}

/** 校验 URL 可达且公网（server 侧旧签名兼容：仅返回 URL，钉定地址供下载层
 *  内部使用）。#1074-1: 实现已收敛到本包。 */
export async function assertPublicHttpUrl(raw: string, lookup: DnsLookup = defaultDnsLookup): Promise<URL> {
  return (await resolvePublicHttpUrl(raw, { lookup })).url
}

/* ── 下载核心 ────────────────────────────────────────────────────────── */

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

export interface GuardValidateError { code: 'not_image' | 'not_pdf'; message: string }

export interface GuardDownloadOptions {
  /** #1074-1 drift 显式参数：worker 10s（快失败，导出路径多图）；server 30s
   *  （OA 全文入库，单文件大）。两消费方按现状各传；是否统一由维护者评估
   *  （建议：保持差异 — 场景 SLO 不同，见迁移报告）。 */
  timeoutMs?: number
  /** 默认 20MB；两消费方现状一致。 */
  maxBytes?: number
  lookup?: DnsLookup
  /** #1074-1 drift 显式参数（白名单策略）：worker 传操作员配置的
   *  SERVER_ORIGIN origin（仅供相对路径 ref 的下载使用 — 命中时跳过 DNS
   *  解析与 IP 黑名单，支持 worker↔server 内网直连部署）；server 恒传 []
   *  （面向任意用户提供的 URL，不允许任何 origin 绕过校验）。是否统一：
   *  建议不统一 — worker 的放行对象是操作员显式配置（信任级别等同于部署
   *  配置而非用户输入），server 无等价场景；收敛成同一策略只会二选一地
   *  削弱某一方（详见迁移报告）。 */
  trustedOrigins?: readonly string[]
  /** 每消费方 User-Agent（现状不同：worker 导出器 / server 研究代理）。 */
  userAgent?: string
  /** #1074-1 drift 显式参数：worker 拒绝重定向跨协议（防 https 降级与
   *  scheme 混淆，false）；server 迁移前不校验跨协议（true，保持现状）。
   *  建议后续把 server 也收紧为 false（见迁移报告）— 本批不改 server
   *  行为，只显式化差异。 */
  allowCrossSchemeRedirect?: boolean
  /** 内容校验（magic bytes）— worker 图片格式 / server %PDF-。返回 null
   *  表示通过；返回错误形状则核心按该 code/message 抛 GuardError。
   *  收到的 buffer 已经过 Content-Encoding 解压（#1072-4）。 */
  validate: (buf: Buffer) => GuardValidateError | null
}

export interface GuardDownloadResult {
  buffer: Buffer
  /** 最终（重定向链尾）URL — server 侧据此派生文件名。 */
  finalUrl: URL
}

/** #1072-4: 按 Content-Encoding 显式解压响应体 — 裸 node:http 传输不像
 *  fetch 会自动解压，压缩响应若不解压会被 magic bytes 误判（gzip 头
 *  1f8b 开头既不是图片也不是 %PDF-）。identity/缺省原样返回；解压失败
 *  fail-closed（内容无法用于校验，按 fetch_failed 处理）。 */
function decodeContentEncoding(body: Buffer, encodingHeader: string | null): Buffer {
  const encoding = (encodingHeader || '').trim().toLowerCase()
  if (!encoding || encoding === 'identity') return body
  try {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body)
      case 'deflate':
        // 容错：deflate 实现常混淆 zlib 头与裸 deflate — 先按 zlib 头试，
        // 失败再试 raw。
        try { return inflateSync(body) } catch { return inflateRawSync(body) }
      case 'deflate-raw':
        return inflateRawSync(body)
      case 'br':
        return brotliDecompressSync(body)
      default:
        throw new Error(`不支持的 content-encoding: ${encoding}`)
    }
  } catch (err) {
    throw new GuardError('fetch_failed', `响应体解码失败(content-encoding: ${encoding}): ${(err as Error).message.slice(0, 120)}`)
  }
}

/** #1066-6: 不读的响应体（重定向/错误状态/超限预检失败）必须 cancel —
 *  否则挂起的响应占住 socket，多图多跳时连接池压力放大。 */
async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel() } catch { /* 已关闭 */ }
}

/** #1074-1 共享下载核心：校验（公网 + 钉定解析 + 总 deadline 覆盖 DNS）→
 *  逐跳重定向（每跳重新校验 + 重新钉定 + 可选拒绝跨协议）→ 流式读正文
 *  （超时/超限即断）→ Content-Encoding 解压（#1072-4）→ 消费方内容校验
 *  （magic bytes）。失败抛 GuardError；消费方薄封装各自捕获转语义。 */
export async function downloadViaGuard(raw: string, opts: GuardDownloadOptions): Promise<GuardDownloadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const lookup = opts.lookup ?? defaultDnsLookup
  const transport = overrideTransport ?? defaultTransport
  const trustedOrigins = opts.trustedOrigins ?? []
  const userAgent = opts.userAgent ?? 'Heurion-SSRF-Guard/1.0'
  const allowCrossScheme = opts.allowCrossSchemeRedirect ?? false

  // #1072-3: 总 deadline 信号 — 每一跳的 DNS 解析（resolvePublicHttpUrl
  // 内）都挂在这个信号上，慢/挂起 DNS 在 deadline 处被中止。
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineController.abort(), timeoutMs)
  try {
    const first = await resolvePublicHttpUrl(raw, { lookup, trustedOrigins, signal: deadlineController.signal })
    const firstScheme = first.url.protocol // worker 现状：重定向不跨协议 — 每跳须与首跳一致
    let target = first
    const deadline = Date.now() + timeoutMs

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const budget = deadline - Date.now()
      if (budget <= 0) throw new GuardError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), budget)
      try {
        let res: Response
        try {
          // #1057: 传入的 lookup 是「校验时解析的那次结果」的钉定版 —
          // 连接期不存在第二次 DNS 解析，rebinding 时序无法切换连接目标。
          res = await transport(target.url, {
            signal: controller.signal,
            headers: { 'User-Agent': userAgent },
            lookup: target.address ? makePinnedLookup(target.address) : null,
          })
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') {
            throw new GuardError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
          }
          throw new GuardError('fetch_failed', `下载失败: ${(err as Error).message.slice(0, 120)}`)
        }

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location')
          if (!loc) {
            await discardBody(res)
            throw new GuardError('fetch_failed', `重定向缺少 Location(HTTP ${res.status})`)
          }
          await discardBody(res) // #1066-6
          // #1057: 每跳重新解析并重新钉定该跳那次解析的结果
          // #1072-3: DNS 解析挂在总 deadline 信号上
          target = await resolvePublicHttpUrl(new URL(loc, target.url).toString(), { lookup, trustedOrigins, signal: deadlineController.signal })
          if (!allowCrossScheme && target.url.protocol !== firstScheme) {
            throw new GuardError('invalid_url', `重定向跨协议已拒绝: ${firstScheme} → ${target.url.protocol}`)
          }
          continue
        }
        if (!res.ok) {
          await discardBody(res) // #1066-6
          throw new GuardError('fetch_failed', `HTTP ${res.status}: ${target.url.hostname}`)
        }

        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > maxBytes) {
          await discardBody(res)
          throw new GuardError('too_large', `文件 ${Math.round(declared / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
        }

        // 流式累计（超限即断 + 逐 chunk deadline 检查），不整块读入内存。
        const reader = res.body?.getReader()
        const chunks: Buffer[] = []
        let total = 0
        if (reader) {
          for (;;) {
            if (Date.now() > deadline) {
              try { await reader.cancel() } catch { /* already closing */ }
              throw new GuardError('timeout', `正文读取超时(${timeoutMs}ms): ${target.url.hostname}`)
            }
            let read: Awaited<ReturnType<typeof reader.read>>
            try {
              read = await reader.read()
            } catch (err) {
              if ((err as Error)?.name === 'AbortError') {
                throw new GuardError('timeout', `正文读取超时(${timeoutMs}ms): ${target.url.hostname}`)
              }
              throw new GuardError('fetch_failed', `正文读取失败: ${(err as Error).message.slice(0, 120)}`)
            }
            if (read.done) break
            total += read.value.length
            if (total > maxBytes) {
              try { await reader.cancel() } catch { /* already closing */ }
              throw new GuardError('too_large', `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB(流式累计 ${total} 字节时中止)`)
            }
            chunks.push(Buffer.from(read.value))
          }
        }

        const wire = Buffer.concat(chunks)
        // #1072-4: 显式 Content-Encoding 处理 — gzip/deflate/br 解压后再做
        // magic bytes 判定；解压后二次上限（防解压炸弹：线缆字节小、展开大）。
        const content = decodeContentEncoding(wire, res.headers.get('content-encoding'))
        if (content.length > maxBytes) {
          throw new GuardError('too_large', `解压后 ${Math.round(content.length / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
        }
        const verdict = opts.validate(content)
        if (verdict) throw new GuardError(verdict.code, verdict.message)
        return { buffer: content, finalUrl: target.url }
      } finally {
        clearTimeout(timer)
      }
    }
    throw new GuardError('fetch_failed', `重定向超过 ${MAX_REDIRECTS} 次,已中止`)
  } finally {
    clearTimeout(deadlineTimer)
  }
}
