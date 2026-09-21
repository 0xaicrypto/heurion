/**
 * #1074-2: remote-image 职责从 common.ts 拆出 — common.ts 回归 PDF 渲染/
 * 调色板职责；本文件承载全部远程图片解析逻辑（asset:// 本地资产 + 托管
 * http(s) 下载 + SSRF 校验 + data URI 生成）。
 *
 * #1074-1: SSRF 校验/钉定/重定向下载核心已收敛到 @heurion/ssrf-guard
 * （与 server-ts url-download.ts 共享单一实现）；本文件只保留 worker 侧
 * 薄封装，与 server 的差异项（timeoutMs/trustedOrigins/跨协议重定向/UA/
 * 内容校验）按现状显式传入（详见各参数注释与 #1074-1 迁移报告）。
 */
import fs from 'fs'
import path from 'path'
import type { ContentBlock } from '@heurion/contracts'
import {
  downloadViaGuard,
  GuardError,
  isPrivateIp,
  makePinnedLookup,
  setGuardLookupForTest,
  setGuardTransportForTest,
  type DnsLookup,
  type GuardTransport,
  type GuardTransportInit,
  type PinnedLookup,
} from '@heurion/ssrf-guard'

export type ImageBlock = ContentBlock & { type: 'image' }

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
  // #1090-2: 显式拒绝 `//host/path` 协议相对形式 — new URL(ref, origin) 会把
  // 该形态解析到 ref 自带的 host（逃逸出 origin 的信任边界，pathname 前缀
  // 校验照样通过）。与 ssrf-guard resolvePublicHttpUrl 口径统一（后者无 base
  // 的 new URL(raw) 对 `//` 形态直接抛 invalid_url，见包内注释）。
  if (ref.startsWith('//')) return null
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
    } catch (err) {
      // #1073-1: asset:// 读取失败不能继续裸吞 — 与"跳块必须可观测"原则
      // 一致（同 download 分支），否则缺图不可归因（权限/缺失/IO 错误）。
      logRemoteImageSkip(block.ref, err)
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
 * 安全核心（校验/钉定/重定向/超限）在 @heurion/ssrf-guard（#1074-1 收敛）；
 * worker 侧差异按现状显式传入：
 *  - 内容校验：图片 magic bytes（PNG/JPEG/GIF/WebP/BMP/SVG）；
 *  - 超时 10s（server 30s — 场景 SLO 不同，见 GuardDownloadOptions 注释）；
 *  - trustedOrigins 由调用方（相对路径 ref 分支）按操作员配置传入；
 *  - 重定向不跨协议（每跳 scheme 必须与首跳一致，防 https 降级与 scheme
 *    混淆 — server 现状不校验，#1074-1 报告建议 server 后续收紧同款）；
 *  - 任何失败向上抛，resolveImage 统一捕获返回 null（沿用"缺图跳块"
 *    语义，不中断整份导出）。
 */

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

/** #1072-1: Buffer → base64 data URI 后的真实字节上界 — base64 编码按
 *  3 字节→4 字符膨胀（ceil(n/3)*4），加 `data:<mime>;base64,` 前缀。
 *  导出内存预算必须按该值计（而非原始字节）：图片以 data URI 字符串
 *  全驻留 pptxgenjs，实际峰值由膨胀后字节决定（旧口径少计 ~25%+）。 */
export function base64InflatedBytes(buf: Buffer): number {
  return Math.ceil(buf.length / 3) * 4 + imageMimeOf(buf).length + 'data:;base64,'.length
}

/** worker 侧错误别名 — 共享核心 GuardError 的同义词（#1074-1）。
 *  既有的 `err instanceof RemoteImageError` 消费方（logRemoteImageSkip/
 *  测试断言）行为不变；code 并集额外含 server 侧 not_pdf（worker 不产出）。 */
export const RemoteImageError = GuardError

/** #1057 钉定/传输类型与测试注入钩子 — 全部收敛到共享包（#1074-1），
 *  这里保留 worker 历史命名做薄转发，既有测试 import 不受影响。 */
export type RemoteTransportInit = GuardTransportInit
export type RemoteTransport = GuardTransport
export { isPrivateIp, makePinnedLookup }
export type { DnsLookup, PinnedLookup }

/** 测试钩子：注入 DNS 解析结果（单测无外网）；传 null 还原真实解析。 */
export function setRemoteImageLookupForTest(fn: DnsLookup | null): void {
  setGuardLookupForTest(fn)
}

/** 测试钩子：注入传输层（单测无外网）；传 null 还原默认 node:http(s) 传输
 *  （#1072-4 e2e 直达生产传输时用 null）。 */
export function setRemoteImageTransportForTest(fn: RemoteTransport | null): void {
  setGuardTransportForTest(fn)
}

const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** #1074-1 drift 显式参数：worker 10s（导出路径多图，快失败）；
 *  server 30s（OA 全文单文件入库）。 */
const REMOTE_IMAGE_TIMEOUT_MS = 10_000

export interface RemoteImageOpts {
  timeoutMs?: number
  maxBytes?: number
  lookup?: DnsLookup
  /** #1058: 受信 origin（操作员配置的 SERVER_ORIGIN，仅供相对路径 ref 使用）
   *  — 命中时跳过 DNS 解析与 IP 黑名单（内网 worker↔server 直连部署）。 */
  trustedOrigins?: string[]
}

/** 下载远程图片为 Buffer（全内存，不落盘）：校验（公网 + 钉定解析）→ 逐跳
 *  重定向（每跳重新校验 + 重新钉定 + 不跨协议）→ 流式读正文（超时/超限即断）
 *  → Content-Encoding 解压（#1072-4）→ 图片 magic bytes。失败抛
 *  RemoteImageError；resolveImage 捕获后转 null。 */
export async function downloadRemoteImage(raw: string, opts: RemoteImageOpts = {}): Promise<Buffer> {
  const { buffer } = await downloadViaGuard(raw, {
    timeoutMs: opts.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS, // #1074-1 drift：worker 10s / server 30s
    maxBytes: opts.maxBytes ?? REMOTE_IMAGE_MAX_BYTES,
    lookup: opts.lookup,
    trustedOrigins: opts.trustedOrigins ?? [], // #1074-1 drift：worker 有受信 origin 白名单，server 恒 []
    userAgent: 'Heurion-Worker/1.0 (document export)',
    // #1074-1 drift：worker 现状拒绝跨协议重定向（server 不校验，待收紧）
    allowCrossSchemeRedirect: false,
    validate: (buf) => looksLikeImage(buf) ? null : { code: 'not_image', message: '内容不是图片(magic bytes 校验失败)' },
  })
  return buffer
}
