/**
 * Unsplash 图库客户端（服务端；Access Key 只在平台进程里，前端与 AI 都经平台接口搜索）。
 * 遵守 Unsplash API Guidelines：
 * - 署名：每张图带摄影师姓名、主页、照片页链接（加 utm_source=heurion&utm_medium=referral），界面显示「Photo by X on Unsplash」；
 * - 真正使用（插入幻灯片、打包进模板）时调用该照片的 download_location 端点；
 * - 搜索结果的缩略图热链 Unsplash 返回的地址；插入时把图片下载成平台资产（导出 pptx 内嵌，AI 沙箱无外网也能用）。
 */

const API = 'https://api.unsplash.com'
const UTM = 'utm_source=heurion&utm_medium=referral'

export const withUtm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${UTM}`

export interface PhotoCredit {
  /** 摄影师姓名 */
  name: string
  /** 摄影师主页（带 utm） */
  profile: string
  /** 照片页（带 utm） */
  photo_page: string
  /** 「Photo by X on Unsplash」 */
  text: string
}

export interface Photo {
  id: string
  width: number
  height: number
  /** 主色（#RRGGBB） */
  color: string | null
  description: string
  /** 缩略图（热链，约 400 宽）与预览（约 1080 宽） */
  thumb: string
  small: string
  credit: PhotoCredit
}

/** 照片的原始字段（插入时要用 download_location 与 raw 地址，不对外返回）。 */
interface RawPhoto {
  id: string; width: number; height: number; color?: string | null
  description?: string | null; alt_description?: string | null
  urls: { raw: string; regular: string; small: string; thumb: string }
  links: { html: string; download_location: string }
  user: { name: string; links: { html: string } }
}

export class UnsplashError extends Error {
  constructor(readonly code: 'unsplash_unconfigured' | 'unsplash_failed' | 'photo_not_found' | 'bad_query', message: string, readonly status: 400 | 404 | 502 | 503 = 502) { super(message) }
}

export function creditOf(p: { user: { name: string; links: { html: string } }; links: { html: string } }): PhotoCredit {
  const name = p.user.name.trim() || 'Unsplash'
  return { name, profile: withUtm(p.user.links.html), photo_page: withUtm(p.links.html), text: `Photo by ${name} on Unsplash` }
}

/** 署名的 markdown（写进演讲备注）：摄影师与 Unsplash 都带链接。 */
export const creditMarkdown = (c: PhotoCredit) => `Photo by [${c.name}](${c.profile}) on [Unsplash](${withUtm('https://unsplash.com/')})`

function toPhoto(p: RawPhoto): Photo {
  return {
    id: p.id, width: p.width, height: p.height, color: p.color ?? null,
    description: (p.description ?? p.alt_description ?? '').trim().slice(0, 200),
    thumb: p.urls.thumb, small: p.urls.small, credit: creditOf(p),
  }
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>

export class Unsplash {
  constructor(private readonly key: string, private readonly fetchFn: Fetch = fetch as unknown as Fetch) {}

  get configured(): boolean { return this.key.length > 0 }

  private async call(path: string): Promise<any> {
    if (!this.configured) throw new UnsplashError('unsplash_unconfigured', '图库未配置（服务器没有设置 UNSPLASH_ACCESS_KEY）', 503)
    let res
    try {
      res = await this.fetchFn(`${API}${path}`, { headers: { Authorization: `Client-ID ${this.key}`, 'Accept-Version': 'v1' } })
    } catch {
      throw new UnsplashError('unsplash_failed', '连不上 Unsplash，稍后再试')
    }
    if (res.status === 404) throw new UnsplashError('photo_not_found', '找不到这张照片', 404)
    if (!res.ok) throw new UnsplashError('unsplash_failed', res.status === 403 || res.status === 429 ? 'Unsplash 请求太频繁，稍后再试' : `Unsplash 返回错误（${res.status}）`)
    return res.json()
  }

  /** 按关键词搜索（每页 ≤ 30）。 */
  async search(query: string, page = 1, perPage = 20, orientation?: 'landscape' | 'portrait' | 'squarish'): Promise<{ total: number; pages: number; results: Photo[] }> {
    const q = query.trim().slice(0, 100)
    if (!q) throw new UnsplashError('bad_query', '搜索词不能为空', 400)
    const params = new URLSearchParams({ query: q, page: String(Math.max(1, Math.min(50, Math.floor(page)))), per_page: String(Math.max(1, Math.min(30, Math.floor(perPage)))), content_filter: 'high' })
    if (orientation) params.set('orientation', orientation)
    const r = await this.call(`/search/photos?${params}`)
    return { total: r.total ?? 0, pages: r.total_pages ?? 0, results: (r.results ?? []).map(toPhoto) }
  }

  private async raw(id: string): Promise<RawPhoto> {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new UnsplashError('photo_not_found', '找不到这张照片', 404)
    return this.call(`/photos/${encodeURIComponent(id)}`)
  }

  /** 使用一张照片：记一次下载（download_location），下载适合幻灯片的尺寸（最长边 width），返回字节与署名。 */
  async use(id: string, width = 1920): Promise<{ photo: Photo; bytes: Uint8Array; mime: string }> {
    const p = await this.raw(id)
    // Guidelines：使用照片时触发 download_location（它返回下载地址；我们用 raw + 尺寸参数取图，结果相同但体积可控）
    await this.call(`${new URL(p.links.download_location).pathname}${new URL(p.links.download_location).search}`).catch(() => null)
    const url = `${p.urls.raw}${p.urls.raw.includes('?') ? '&' : '?'}w=${width}&q=80&fm=jpg&fit=max`
    let res
    try { res = await this.fetchFn(url) } catch { throw new UnsplashError('unsplash_failed', '下载照片失败，稍后再试') }
    if (!res.ok) throw new UnsplashError('unsplash_failed', `下载照片失败（${res.status}）`)
    return { photo: toPhoto(p), bytes: new Uint8Array(await res.arrayBuffer()), mime: 'image/jpeg' }
  }
}
