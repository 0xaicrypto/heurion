import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * AI 以用户身份调用平台接口（docs/design/AI_PERMISSIONS.md）：MCP 的管理类工具不另写一套权限逻辑，
 * 而是在进程内把请求交给同一个 HTTP 应用——鉴权、机构 / 研究 / 患者的权限判定、审计全部与界面一致。
 * 进程内请求带一个只存在于本进程内存里的密钥（每次启动随机生成，不落盘、不出进程），网络上的请求伪造不了。
 */
export const INTERNAL_SECRET = randomBytes(32).toString('hex')
export const H_INTERNAL = 'x-heurion-internal'
export const H_AS = 'x-heurion-as'
export const H_VIA = 'x-heurion-via'
export const H_CONFIRMED = 'x-heurion-confirmed-by'

/** 来源：ai = AI 直接做的；ai-confirmed = AI 发起、用户在确认卡上确认后执行的。 */
export type Via = 'ai' | 'ai-confirmed'
export interface ViaInfo { via: Via; confirmedBy: string | null }

/** 请求是否来自进程内的 AI 调用（是则返回来源信息）。密钥不对 → 视为伪造。 */
export function internalVia(header: (name: string) => string | undefined): ViaInfo | 'forged' | null {
  const secret = header(H_INTERNAL)
  if (secret === undefined) return null
  const a = Buffer.from(secret), b = Buffer.from(INTERNAL_SECRET)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'forged'
  const via = header(H_VIA) === 'ai-confirmed' ? 'ai-confirmed' : 'ai'
  return { via, confirmedBy: header(H_CONFIRMED) ?? null }
}

export type InvokeBody =
  | { json: unknown }
  | { bytes: Uint8Array; mime: string }
  | { form: Record<string, string>; file?: { bytes: Uint8Array; name: string; mime: string } }

export interface InvokeResult { status: number; ok: boolean; json: unknown; text: string; bytes: Uint8Array; contentType: string }
export type Invoke = (user: string, method: string, path: string, body?: InvokeBody, opts?: { via?: Via; confirmedBy?: string | null }) => Promise<InvokeResult>

/** 进程内调用 HTTP 应用（app.request 不经网络）。 */
export function makeInvoker(app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }): Invoke {
  return async (user, method, path, body, opts = {}) => {
    const headers: Record<string, string> = { [H_INTERNAL]: INTERNAL_SECRET, [H_AS]: user, [H_VIA]: opts.via ?? 'ai' }
    if (opts.confirmedBy) headers[H_CONFIRMED] = opts.confirmedBy
    let payload: BodyInit | undefined
    if (body && 'json' in body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body.json ?? {}) }
    else if (body && 'bytes' in body) { headers['Content-Type'] = body.mime; payload = new Blob([body.bytes as BlobPart]) }
    else if (body && 'form' in body) {
      const form = new FormData()
      for (const [k, v] of Object.entries(body.form)) form.append(k, v)
      if (body.file) form.append('file', new File([body.file.bytes as BlobPart], body.file.name, { type: body.file.mime }))
      payload = form
    }
    const res = await app.request(path, { method, headers, body: payload })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? ''
    const text = /json|text/.test(contentType) ? new TextDecoder().decode(bytes) : ''
    let json: unknown = null
    if (/json/.test(contentType)) { try { json = JSON.parse(text) } catch { /* 非 JSON */ } }
    return { status: res.status, ok: res.ok, json, text, bytes, contentType }
  }
}
