/**
 * Shared handler plumbing (#686): image resolution and the pdfkit
 * buffer-collection boilerplate were copy-pasted across docx/pptx/pdf/
 * table; the chart palette repeated 3× inside plot.ts.
 */
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { ContentBlock } from '@heurion/contracts'
import { saveFile } from '../storage.js'

export type ImageBlock = ContentBlock & { type: 'image' }

/** #fix 2026-09: PDF 导出中文全是方块 — pdfkit 默认 Helvetica 无 CJK 字形。
 *  注册单面 .ttf 中文字体并设为默认。注意 pdfkit 不能嵌 .ttc 集合
 *  （fonts-noto-cjk 全是 .ttc），必须用 fonts-droid-fallback 的单面 ttf。
 *  #928: 只保留单面 .ttf 候选 — 此前的 .ttc 候选在 pdfkit 里命中即延迟
 *  失败（registerFont 解析 .ttc 集合在渲染期才炸），移除。
 *  返回是否成功注册；找不到字体时保持 Helvetica（拉丁正常,降级为服务器
 *  缺字体的部署），调用方据此决定能否引用 'cjk' 字体名。 */
const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
]
export function applyCjkFont(doc: PDFKit.PDFDocument): boolean {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        doc.registerFont('cjk', p)
        doc.font('cjk')
        return true
      }
    } catch { /* keep probing */ }
  }
  return false
}

/** #1058/#1066-7: 跳块必须有可观测信号 — 此前裸 catch 把 RemoteImageError
 *  携带的 SSRF 拦截/下载失败诊断一并吞掉，缺图不可归因。统一在此留 warn。 */
function logRemoteImageSkip(ref: string, err: unknown): void {
  const detail = err instanceof RemoteImageError
    ? `code=${err.code} ${err.message}`
    : String((err as Error)?.message || err)
  console.warn(`[REMOTE-IMAGE] 图片下载失败，跳过该块: ${ref.slice(0, 120)} — ${detail.slice(0, 200)}`)
}

/** #1058: 相对路径 ref → 绝对 URL。基址 env 约定 SERVER_ORIGIN（首选）/
 *  BACKEND_URL（兼容别名），形如 https://api.example.com。仅接受服务端签发的
 *  /api/v1/files/download/ 前缀路径（web 端 deck 手动插图写入的形态）；
 *  new URL 会规范化 `..`，逃逸出前缀的路径在此必然暴露。 */
const FILE_DOWNLOAD_PATH_PREFIX = '/api/v1/files/download/'
export function resolveRelativeFileRef(ref: string, origin: string): string | null {
  if (!origin) return null
  try {
    const u = new URL(ref, origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.pathname.startsWith(FILE_DOWNLOAD_PATH_PREFIX)) return null
    return u.toString()
  } catch {
    return null
  }
}

/** Resolve an image block: inline base64 data, or asset://name on disk.
 *  Returns null when unresolvable (renders skip it). */
export async function resolveImage(block: ImageBlock): Promise<{ data: Buffer; caption?: string } | null> {
  if (block.data) {
    const base64 = block.data.startsWith('data:') ? block.data.split(',')[1] || '' : block.data
    return { data: Buffer.from(base64, 'base64'), caption: block.caption }
  }
  if (block.ref.startsWith('asset://')) {
    const name = block.ref.slice('asset://'.length)
    // #900: asset name is untrusted input — `../.env` would read arbitrary
    // files from the worker FS. Reject separators/dot-segments/NUL up front,
    // then basename + resolve-inside-dir as a second gate. Unresolvable →
    // null (renders skip the block, same as a missing file).
    const base = path.basename(name)
    if (!base || base === '.' || base === '..' || base.includes('..') || /[/\\\0]/.test(name)) {
      return null
    }
    try {
      const { readFile } = await import('node:fs/promises')
      const dir = path.resolve(process.env.ASSET_DIR || '/opt/heurion/assets')
      const target = path.resolve(dir, base)
      if (!target.startsWith(dir + path.sep)) return null
      const data = await readFile(target)
      return { data, caption: block.caption }
    } catch {
      return null
    }
  }
  // #1053: 托管 http(s) URL 分支 — 下载转 Buffer 后走既有嵌入路径。
  // 任何失败（协议/SSRF/超时/超限/非图片/网络）一律返回 null，
  // 沿用"缺图跳块"语义，不中断整份导出。
  // #1058/#1066-7: 跳块原因经 logRemoteImageSkip 留痕，不再裸吞诊断。
  if (block.ref.startsWith('http://') || block.ref.startsWith('https://')) {
    try {
      const data = await downloadRemoteImage(block.ref)
      return { data, caption: block.caption }
    } catch (err) {
      logRemoteImageSkip(block.ref, err)
      return null
    }
  }
  // #1058: 相对路径 ref — web 端 deck 手动插图由服务端签发相对下载 URL
  // （/api/v1/files/download/<id>?token=...）。按环境基 URL 拼绝对地址后
  // 走既有下载分支；受信 origin（操作员配置的 SERVER_ORIGIN）放行 SSRF
  // IP 校验，使 worker↔server 内网直连部署可用。未配置基址/路径不符 →
  // 可观测日志 + 跳块（不再静默吞图）。
  if (block.ref.startsWith('/')) {
    const origin = process.env.SERVER_ORIGIN || process.env.BACKEND_URL || ''
    const abs = resolveRelativeFileRef(block.ref, origin)
    if (!abs) {
      logRemoteImageSkip(block.ref, new RemoteImageError('invalid_url', `#1058 相对路径 ref 无法解析（SERVER_ORIGIN/BACKEND_URL 未配置或路径非 ${FILE_DOWNLOAD_PATH_PREFIX}*）`))
      return null
    }
    let trustedOrigins: string[] = []
    try {
      trustedOrigins = [new URL(origin).origin] // 操作员配置 → 受信
    } catch { /* 非法 origin 不放行 */ }
    try {
      const data = await downloadRemoteImage(abs, { trustedOrigins })
      return { data, caption: block.caption }
    } catch (err) {
      logRemoteImageSkip(abs, err)
      return null
    }
  }
  return null
}

/* ── #1053: 托管 http(s) URL 图片下载（resolveImage 第三分支）────────────
 * 安全边界（参照 server-ts src/lib/url-download.ts 的思路，worker 侧自包含）：
 *  - 仅 http/https；主机名黑名单（localhost / *.localhost / *.local / *.internal）；
 *  - SSRF 防护：DNS 解析后的全部 IP 必须公网（禁环回/私网/链路本地/组播/保留段，
 *    含 IPv4-mapped IPv6），重定向每一跳都重新校验；
 *  - 重定向不跨协议（每跳 scheme 必须与首跳一致，防 https 降级与 scheme 混淆）；
 *  - 总超时（默认 10s，覆盖响应头与正文全程）+ 大小上限（默认 20MB，
 *    content-length 预检 + 流式累计超限即断）；
 *  - 内容校验：图片 magic bytes（PNG/JPEG/GIF/WebP/BMP/SVG）；
 *  - 全内存处理不落盘；任何失败向上抛，resolveImage 统一捕获返回 null
 *    （沿用"缺图跳块"语义，不中断整份导出）。
 */

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
 *  与 server-ts url-download.ts 的 isPrivateIp 同口径；IPv6 走全展开判定，
 *  覆盖 16 进制书写的 IPv4-mapped（如 ::ffff:7f00:1）与废弃的 IPv4-compatible
 *  （::127.0.0.1）等字符串前缀匹配会漏掉的变体。无法解析的形态 fail-closed。
 *  #1057: 补 CGNAT 100.64.0.0/10 与基准测试保留段 198.18.0.0/15；
 *  并修 ::ffff:0:0（IPv4-mapped 未指定地址，内核语义等同 loopback/未指定）
 *  被旧条件 `groups[6]!==0||groups[7]!==0` 排除在判定外的缺口 — 现统一按
 *  内嵌 IPv4 重新判定（0.0.0.0 → 私网）。 */
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

/** 图片 magic bytes 判定（PNG/JPEG/GIF/WebP/BMP/SVG）— 防止把 HTML 错误页/
 *  任意文件当图片嵌入导出物。 */
export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 4) return false
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return true // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
  const head4 = buf.subarray(0, 4).toString('ascii')
  if (head4 === 'GIF8') return true
  if (head4 === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true // BMP
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return true // SVG
  return false
}

/** #1053: magic bytes → mime。pptxgenjs 的 addImage 仅接受带 base64 头的
 *  字符串（传 Buffer 走 console.error 后被静默丢弃），嵌入前统一转 data URI。 */
export function imageMimeOf(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'image/svg+xml'
}

/** #1053: Buffer → pptxgenjs 可用的 data URI（image/png;base64,...）。 */
export function toBase64DataUri(buf: Buffer): string {
  return `data:${imageMimeOf(buf)};base64,${buf.toString('base64')}`
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>

let overrideLookup: DnsLookup | null = null
const defaultLookup: DnsLookup = (hostname) =>
  (overrideLookup ? overrideLookup(hostname) : dns.promises.lookup(hostname, { all: true })) as Promise<Array<{ address: string }>>

/** 测试钩子：注入 DNS 解析结果（单测无外网）；传 null 还原真实解析。 */
export function setRemoteImageLookupForTest(fn: DnsLookup | null): void {
  overrideLookup = fn
}

export class RemoteImageError extends Error {
  constructor(readonly code: 'invalid_url' | 'private_address' | 'too_large' | 'timeout' | 'not_image' | 'fetch_failed', message: string) {
    super(message)
    this.name = 'RemoteImageError'
  }
}

const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const REMOTE_IMAGE_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

export interface RemoteImageOpts {
  timeoutMs?: number
  maxBytes?: number
  lookup?: DnsLookup
  /** #1058: 受信 origin（操作员配置的 SERVER_ORIGIN，仅供相对路径 ref 使用）
   *  — 命中时跳过 DNS 解析与 IP 黑名单（内网 worker↔server 直连部署）。 */
  trustedOrigins?: string[]
}

/* ── #1057: 校验与连接共用同一次 DNS 解析（钉定）────────────────────────
 * fetch(undici) 对传入 URL 会做第二次独立 DNS 解析 — 校验期解析到公网 IP
 * 过检后、连接期解析回 127.0.0.1/内网即可绕过整套黑名单（TOCTOU）。
 * 修复：校验期解析得到公网 IP 后，连接层改用 node:http(s) 并把该 IP 作为
 * `lookup` 钉定选项 — TCP 连接只能打到校验时的地址，Host 头与 TLS SNI 仍
 * 取自原始域名（证书校验不受影响）；重定向每一跳重新校验并重新钉定。 */

/** node dns.lookup 回调风格的钉定取址函数（作为 http(s) request 的 lookup
 *  选项传入；忽略 hostname，恒返回校验期钉定的 IP）。 */
export type PinnedLookup = (hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => void

/** #1057: 校验解析出的公网 IP → 钉定 lookup。 */
export function makePinnedLookup(ip: string): PinnedLookup {
  const family = isIP(ip) === 6 ? 6 : 4
  return (_hostname, _options, cb) => { cb(null, ip, family) }
}

export interface RemoteTransportInit {
  signal: AbortSignal
  headers: Record<string, string>
  /** 钉定 lookup（校验期解析的 IP）；null = 受信 origin 不钉定（常规解析）。 */
  lookup: PinnedLookup | null
}

/** 传输层签名与 fetch 对齐（入参 (url, init) → Response），便于测试注入。 */
export type RemoteTransport = (url: URL, init: RemoteTransportInit) => Promise<Response>

let overrideTransport: RemoteTransport | null = null

/** 测试钩子：注入传输层（单测无外网）；传 null 还原默认 node:http(s) 传输。 */
export function setRemoteImageTransportForTest(fn: RemoteTransport | null): void {
  overrideTransport = fn
}

/** #1057: 默认传输 — node:http(s) + 钉定 lookup。 */
async function defaultTransport(url: URL, init: RemoteTransportInit): Promise<Response> {
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
  // core 统一按 Response.body.getReader() 消费/取消。
  const bodyless = status === 204 || status === 205 || status === 304
  const body = bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream)
  return new Response(body, { status, headers })
}

/** 校验 URL 可达且公网：协议/受信 origin/主机名黑名单/DNS 解析地址全部公网。
 *  #1057: 返回校验期解析钉定的首个公网 IP（受信 origin 返回 null = 不钉定）。 */
interface PublicTarget { url: URL; address: string | null }
async function resolvePublicHttpUrl(raw: string, lookup: DnsLookup, trustedOrigins: readonly string[] = []): Promise<PublicTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RemoteImageError('invalid_url', 'URL 形式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteImageError('invalid_url', `仅支持 http(s)，收到 ${url.protocol}`)
  }
  // #1058: 操作员显式配置的受信 origin（相对路径 ref 的基址）— 域名黑名单
  // 与 IP 黑名单一并跳过（内网部署时 server 地址本就是私网）。
  if (trustedOrigins.includes(url.origin)) {
    return { url, address: null }
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new RemoteImageError('private_address', `拒绝内网主机: ${host}`)
  }
  const bare = host.replace(/^\[|\]$/g, '')
  let addresses: Array<{ address: string }>
  if (isIP(bare)) {
    addresses = [{ address: bare }] // IP 字面量免解析，直接走 IP 校验
  } else {
    try {
      addresses = await lookup(host)
    } catch {
      throw new RemoteImageError('fetch_failed', `域名解析失败: ${host}`)
    }
  }
  if (!addresses || addresses.length === 0) {
    throw new RemoteImageError('fetch_failed', `域名解析无地址: ${host}`)
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new RemoteImageError('private_address', `拒绝私网地址: ${host} → ${a.address}`)
    }
  }
  return { url, address: addresses[0].address } // #1057: 钉定校验这次解析的结果
}

/** #1066-6: 不读的响应体（重定向/错误状态/超限预检失败）必须 cancel —
 *  否则挂起的响应占住 socket，多图多跳时连接池压力放大。 */
async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel() } catch { /* 已关闭 */ }
}

/** 下载远程图片为 Buffer（全内存，不落盘）：校验（公网 + 钉定解析）→ 逐跳
 *  重定向（每跳重新校验 + 重新钉定 + 不跨协议）→ 流式读正文（超时/超限即断）
 *  → 图片 magic bytes。失败抛 RemoteImageError；resolveImage 捕获后转 null。 */
export async function downloadRemoteImage(raw: string, opts: RemoteImageOpts = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? REMOTE_IMAGE_MAX_BYTES
  const lookup = opts.lookup ?? defaultLookup
  const transport = overrideTransport ?? defaultTransport
  const trustedOrigins = opts.trustedOrigins ?? []
  const first = await resolvePublicHttpUrl(raw, lookup, trustedOrigins)
  const firstScheme = first.url.protocol // #1053: 重定向不跨协议 — 每跳须与首跳一致
  let target = first
  const deadline = Date.now() + timeoutMs

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new RemoteImageError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      let res: Response
      try {
        // #1057: 传入的 lookup 是「校验时解析的那次结果」的钉定版 —
        // 连接期不存在第二次 DNS 解析，rebinding 时序无法切换连接目标。
        res = await transport(target.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Heurion-Worker/1.0 (document export)' },
          lookup: target.address ? makePinnedLookup(target.address) : null,
        })
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          throw new RemoteImageError('timeout', `下载超时(${timeoutMs}ms): ${target.url.hostname}`)
        }
        throw new RemoteImageError('fetch_failed', `下载失败: ${(err as Error).message.slice(0, 120)}`)
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) {
          await discardBody(res)
          throw new RemoteImageError('fetch_failed', `重定向缺少 Location(HTTP ${res.status})`)
        }
        await discardBody(res) // #1066-6
        // #1057: 每跳重新解析并重新钉定该跳那次解析的结果
        target = await resolvePublicHttpUrl(new URL(loc, target.url).toString(), lookup, trustedOrigins)
        if (target.url.protocol !== firstScheme) {
          throw new RemoteImageError('invalid_url', `重定向跨协议已拒绝: ${firstScheme} → ${target.url.protocol}`)
        }
        continue
      }
      if (!res.ok) {
        await discardBody(res) // #1066-6
        throw new RemoteImageError('fetch_failed', `HTTP ${res.status}: ${target.url.hostname}`)
      }

      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) {
        await discardBody(res)
        throw new RemoteImageError('too_large', `文件 ${Math.round(declared / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
      }

      // 流式累计（超限即断 + 逐 chunk deadline 检查），不整块读入内存。
      const reader = res.body?.getReader()
      const chunks: Buffer[] = []
      let total = 0
      if (reader) {
        for (;;) {
          if (Date.now() > deadline) {
            try { await reader.cancel() } catch { /* already closing */ }
            throw new RemoteImageError('timeout', `正文读取超时(${timeoutMs}ms): ${target.url.hostname}`)
          }
          let read: Awaited<ReturnType<typeof reader.read>>
          try {
            read = await reader.read()
          } catch (err) {
            if ((err as Error)?.name === 'AbortError') {
              throw new RemoteImageError('timeout', `正文读取超时(${timeoutMs}ms): ${target.url.hostname}`)
            }
            throw new RemoteImageError('fetch_failed', `正文读取失败: ${(err as Error).message.slice(0, 120)}`)
          }
          if (read.done) break
          total += read.value.length
          if (total > maxBytes) {
            try { await reader.cancel() } catch { /* already closing */ }
            throw new RemoteImageError('too_large', `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB(流式累计 ${total} 字节时中止)`)
          }
          chunks.push(Buffer.from(read.value))
        }
      }

      const buffer = Buffer.concat(chunks)
      if (!looksLikeImage(buffer)) {
        throw new RemoteImageError('not_image', '内容不是图片(magic bytes 校验失败)')
      }
      return buffer
    } finally {
      clearTimeout(timer)
    }
  }
  throw new RemoteImageError('fetch_failed', `重定向超过 ${MAX_REDIRECTS} 次,已中止`)
}

/** Render a pdfkit document and persist it — shared buffer-collection
 *  promise wrapper (was duplicated in pdf.ts and table.ts).
 *  #928: draw 回调第二参数声明 'cjk' 字体是否可用 — 缺字体部署里
 *  doc.font('cjk') 会抛（未注册字体名），调用方须条件使用。 */
export function renderPdf(draw: (doc: PDFKit.PDFDocument, hasCjk: boolean) => void, fileName: string, mimeType = 'application/pdf') {
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  const hasCjk = applyCjkFont(doc)
  const buffers: Buffer[] = []
  doc.on('data', (chunk: Buffer) => buffers.push(chunk))

  return new Promise<any>((resolve, reject) => {
    doc.on('end', async () => {
      try {
        const buffer = Buffer.concat(buffers)
        const result = await saveFile(buffer, fileName, mimeType)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
    doc.on('error', reject)
    draw(doc, hasCjk)
    doc.end()
  })
}

/** Chart palette shared by bar/line/pie SVG generation in plot.ts. */
export const PLOT_COLORS = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']
