import { Unsplash, type Fetch } from '../src/images/unsplash.ts'

/** 假的 Unsplash（测试不打真实接口）：记录请求，搜索返回两张照片，下载返回一个小 JPEG。 */
export function fakeUnsplash() {
  const calls: string[] = []
  const photo = (id: string, name: string) => ({
    id, width: 1600, height: 1000, color: '#0c73a6', description: null, alt_description: `photo ${id}`,
    urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=x`, regular: 'r', small: `https://images.unsplash.com/small-${id}`, thumb: `https://images.unsplash.com/thumb-${id}` },
    links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download?ixid=x` },
    user: { name, links: { html: `https://unsplash.com/@${name.toLowerCase().replace(/\s+/g, '')}` } },
  })
  const PHOTOS: Record<string, ReturnType<typeof photo>> = { abc123: photo('abc123', 'Ada Lab'), def456: photo('def456', 'Ben Hill') }
  // 最小的 JPEG 头（SOI + APP0 + SOF0 1×1 + EOI），够 imageSize 读尺寸
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9])
  const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => (body instanceof Uint8Array ? body : new Uint8Array()).buffer as ArrayBuffer, headers: { get: () => null } })
  const fetchFn: Fetch = async (url, init) => {
    calls.push(url)
    const u = new URL(url)
    if (u.hostname === 'images.unsplash.com') return res(200, jpeg)
    if (!init?.headers?.Authorization?.startsWith('Client-ID ')) return res(401, {})
    if (u.pathname === '/search/photos') return res(200, { total: 2, total_pages: 1, results: Object.values(PHOTOS) })
    const dl = /^\/photos\/([^/]+)\/download$/.exec(u.pathname)
    if (dl) return res(200, { url: `https://images.unsplash.com/photo-${dl[1]}` })
    const one = /^\/photos\/([^/]+)$/.exec(u.pathname)
    if (one) return PHOTOS[one[1]!] ? res(200, PHOTOS[one[1]!]) : res(404, {})
    return res(404, {})
  }
  return { unsplash: new Unsplash('test-key', fetchFn), calls }
}
