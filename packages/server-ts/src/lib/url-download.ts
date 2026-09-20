/**
 * #875 — 受控 URL→文件下载(检索结果 OA 全文入库)。
 *
 * #1074-1 — SSRF 校验/钉定 DNS/重定向循环/流式上限核心已收敛到
 * @heurion/ssrf-guard（与 worker common.ts→remote-image.ts 共享单一实现，
 * 消除双实现 drift）。本文件只保留 server 侧薄封装：PDF 内容校验、
 * 文件名派生，以及 server 侧与 worker 的差异参数（按现状显式传入）：
 *  - timeoutMs 30s（worker 10s — OA 全文单文件入库 vs 导出多图快失败）；
 *  - trustedOrigins 恒 []（面向任意用户提供的 URL，不允许任何 origin 绕过
 *    SSRF 校验；worker 的受信 origin 是操作员显式配置的内网直连场景）；
 *  - allowCrossSchemeRedirect: true — 迁移前 server 不校验重定向跨协议，
 *    本批保持现状不改行为；worker 侧拒绝（防 https 降级）。建议后续收紧
 *    为 false 与 worker 统一（#1074-1 报告）。
 * 迁移后本模块自共享核心额外获得（无需 server 侧代码）：重定向每跳 DNS
 * 纳入总 deadline（#1072-3）、Content-Encoding 显式解压后再 %PDF- 判定
 * （#1072-4 — 压缩响应不再被 magic bytes 误判）、解压后二次大小上限
 * （防解压炸弹）。
 */
import { downloadViaGuard, GuardError, isPrivateIp, makePinnedLookup, setGuardLookupForTest, setGuardTransportForTest, type DnsLookup, type GuardTransportInit, type GuardTransport, type PinnedLookup } from '@heurion/ssrf-guard'
import { sanitizeFilename } from './upload-path.js'

/** server 侧错误别名 — 共享核心 GuardError 的同义词（#1074-1）。
 *  既有的 `err instanceof UrlDownloadError` 消费方（doc-import.ts 等）
 *  行为不变。 */
export const UrlDownloadError = GuardError

export { isPrivateIp, makePinnedLookup }
export type UrlTransportInit = GuardTransportInit
export type UrlTransport = GuardTransport
export type { DnsLookup, PinnedLookup }

/** 测试钩子:注入 DNS 解析结果(e2e 无外网);传 null 还原真实解析。 */
export function setUrlDownloadLookupForTest(fn: DnsLookup | null): void {
  setGuardLookupForTest(fn)
}

/** 测试钩子：注入传输层（单测无外网）；传 null 还原默认 node:http(s) 传输。 */
export function setUrlDownloadTransportForTest(fn: UrlTransport | null): void {
  setGuardTransportForTest(fn)
}

/** 校验 URL 可达且公网(兼容旧签名:仅返回 URL,钉定地址供下载层内部使用)。
 *  默认 lookup 与共享核心一致（含测试注入钩子）。 */
export { assertPublicHttpUrl } from '@heurion/ssrf-guard'

/** URL basename → 安全文件名(保 .pdf 后缀)。 */
export function filenameFromUrl(url: URL): string {
  const base = decodeURIComponent(url.pathname.split('/').pop() || '') || 'paper'
  const safe = sanitizeFilename(base) || 'paper'
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
/** #1074-1 drift 显式参数：server 30s（OA 全文单文件入库；worker 导出路径 10s）。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 受控下载 PDF:校验(公网 + 钉定解析)→ 逐跳重定向(每跳重新校验 + 重新钉定)
 * → 流式读正文(超限即断)→ Content-Encoding 解压 → %PDF- magic bytes。
 * 成功返回 buffer 与派生文件名(取自最终 URL)。
 */
export async function downloadPdfFromUrl(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; lookup?: DnsLookup } = {},
): Promise<{ buffer: Buffer; filename: string }> {
  const { buffer, finalUrl } = await downloadViaGuard(raw, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    lookup: opts.lookup,
    // #1074-1 drift：server 无受信 origin 场景 — 恒空（worker 才有）。
    trustedOrigins: [],
    userAgent: 'Heurion/1.0 (medical research agent)',
    // #1074-1 drift：迁移前 server 不校验重定向跨协议 — 保持现状（true），
    // worker 侧拒绝（false）。建议后续统一收紧（见迁移报告）。
    allowCrossSchemeRedirect: true,
    validate: (buf) =>
      buf.length > 4 && buf.slice(0, 5).toString('ascii') === '%PDF-'
        ? null
        : { code: 'not_pdf', message: '内容不是 PDF(%PDF- magic bytes 校验失败) — 仅支持 OA 全文 PDF 直链入库' },
  })
  return { buffer, filename: filenameFromUrl(finalUrl) }
}
