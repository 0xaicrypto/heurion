/**
 * Shared handler plumbing (#686): image resolution and the pdfkit
 * buffer-collection boilerplate were copy-pasted across docx/pptx/pdf/
 * table; the chart palette repeated 3× inside plot.ts.
 */
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import dns from 'node:dns'
import { isIP } from 'node:net'
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
  if (block.ref.startsWith('http://') || block.ref.startsWith('https://')) {
    try {
      const data = await downloadRemoteImage(block.ref)
      return { data, caption: block.caption }
    } catch {
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
 *  （::127.0.0.1）等字符串前缀匹配会漏掉的变体。无法解析的形态 fail-closed。 */
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
  const groups = expandIpv6(raw)
  if (!groups) return true // #1053: 解析不了就拒绝（fail-closed）
  if (groups.every((g) => g === 0)) return true // '::' 未指定地址
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1 环回
  // ::/96 内嵌 IPv4（::ffff: 映射 / IPv4-compatible）→ 按内嵌 IPv4 重新判定
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff) && (groups[6] !== 0 || groups[7] !== 0)) {
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
}

/** 校验 URL 可达且公网：协议/主机名黑名单/DNS 解析地址全部公网。 */
async function assertPublicHttpUrl(raw: string, lookup: DnsLookup): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RemoteImageError('invalid_url', 'URL 形式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteImageError('invalid_url', `仅支持 http(s)，收到 ${url.protocol}`)
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
  return url
}

/** 下载远程图片为 Buffer（全内存，不落盘）：校验（公网）→ 逐跳重定向
 *  （每跳重新校验 + 不跨协议）→ 流式读正文（超时/超限即断）→ 图片 magic bytes。
 *  失败抛 RemoteImageError；resolveImage 捕获后转 null。 */
export async function downloadRemoteImage(raw: string, opts: RemoteImageOpts = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? REMOTE_IMAGE_MAX_BYTES
  const lookup = opts.lookup ?? defaultLookup
  const first = await assertPublicHttpUrl(raw, lookup)
  const firstScheme = first.protocol // #1053: 重定向不跨协议 — 每跳须与首跳一致
  let url = first
  const deadline = Date.now() + timeoutMs

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new RemoteImageError('timeout', `下载超时(${timeoutMs}ms): ${url.hostname}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      let res: Response
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Heurion-Worker/1.0 (document export)' },
        })
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          throw new RemoteImageError('timeout', `下载超时(${timeoutMs}ms): ${url.hostname}`)
        }
        throw new RemoteImageError('fetch_failed', `下载失败: ${(err as Error).message.slice(0, 120)}`)
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) throw new RemoteImageError('fetch_failed', `重定向缺少 Location(HTTP ${res.status})`)
        const next = await assertPublicHttpUrl(new URL(loc, url).toString(), lookup)
        if (next.protocol !== firstScheme) {
          throw new RemoteImageError('invalid_url', `重定向跨协议已拒绝: ${firstScheme} → ${next.protocol}`)
        }
        url = next
        continue
      }
      if (!res.ok) {
        throw new RemoteImageError('fetch_failed', `HTTP ${res.status}: ${url.hostname}`)
      }

      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) {
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
            throw new RemoteImageError('timeout', `正文读取超时(${timeoutMs}ms): ${url.hostname}`)
          }
          let read: Awaited<ReturnType<typeof reader.read>>
          try {
            read = await reader.read()
          } catch (err) {
            if ((err as Error)?.name === 'AbortError') {
              throw new RemoteImageError('timeout', `正文读取超时(${timeoutMs}ms): ${url.hostname}`)
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
