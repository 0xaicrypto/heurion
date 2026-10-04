import type { Node as PMNode } from 'prosemirror-model'
import { pt } from '../model/deck-schema.ts'
import { layoutSpec } from '../model/deck-templates.ts'
import type { Documents } from '../model/runtime.ts'
import type { OpService } from '../ops/service.ts'
import type { Actor } from '../store/db.ts'
import { allows, type Access } from '../research/access.ts'
import { creditMarkdown, Unsplash, UnsplashError, type Photo } from './unsplash.ts'

/**
 * 图库照片进幻灯片（界面「图片 ▾ → 从 Unsplash 搜索」与 MCP image_search / slide_add_photo 走同一个方法）：
 * 下载照片 → 存成文档所有者的资产 → add_image（图文版式放进图片区，其他版式居中）→ 署名追加到这一页的演讲备注。
 */
export class ImageService {
  /** 访问判定（研究共享的幻灯片：可编辑成员也能插图）；没接上时只认主人。 */
  access: Access | null = null

  constructor(private readonly docs: Documents, private readonly ops: OpService, private readonly unsplash: Unsplash) {}

  get configured(): boolean { return this.unsplash.configured }

  search(query: string, page = 1): Promise<{ total: number; pages: number; results: Photo[] }> {
    return this.unsplash.search(query, page, 24)
  }

  async addToSlide(user: string, input: { doc_id: string; slide_id: string; photo_id: string; x?: number; y?: number; w?: number }, meta: { actor: Actor; turnId: string | null }) {
    const row = this.docs.store.getDoc(input.doc_id)
    const role = row && !row.deleted_at ? (this.access ? this.access.docRole(user, row) : row.owner === user ? 'owner' : null) : null
    if (!row || !role) throw new UnsplashError('photo_not_found', '文档不存在', 404)
    if (!allows(role, 'write')) throw new UnsplashError('photo_not_found', '你在这个研究里是只读成员，不能修改', 403)
    if (row.kind !== 'deck') throw new UnsplashError('bad_query', '只能插入幻灯片', 400)
    let slide: PMNode | null = null
    this.docs.get(input.doc_id).forEach(s => { if (s.attrs.id === input.slide_id) slide = s })
    if (!slide) throw new UnsplashError('photo_not_found', `找不到幻灯片 ${input.slide_id}`, 404)
    const { photo, bytes, mime } = await this.unsplash.use(input.photo_id)
    const asset = this.docs.store.putAsset({ owner: user, mime, name: `unsplash-${photo.id}.jpg`, bytes })
    const box = input.x !== undefined && input.y !== undefined && input.w !== undefined ? { x: input.x, y: input.y, w: input.w, h: input.w * photo.height / photo.width } : placement(slide, photo)
    const result = this.ops.edit({
      doc_id: input.doc_id, base_rev: this.docs.rev(input.doc_id), mode: 'apply',
      ops: [{ op: 'add_image', slide_id: input.slide_id, asset_id: asset.id, ...box, description: photo.credit.text, credit: creditMarkdown(photo.credit) }],
    }, { ...meta, user })
    return { shape_id: result.results[0]?.ids[0] ?? null, asset_id: asset.id, rev: result.rev, credit: photo.credit }
  }
}

/** 默认位置：图文版式按图片区等比裁切进去（覆盖图片区），其他版式宽 400pt 居中。 */
function placement(slide: PMNode, photo: Photo): { x: number; y: number; w: number; h: number } {
  const ratio = photo.height / photo.width
  let pic: { x: number; y: number; w: number; h: number } | null = null
  slide.forEach(s => { if (/^deco:.*:picture$/.test(String(s.attrs.name))) pic = { x: pt(s.attrs.x), y: pt(s.attrs.y), w: pt(s.attrs.w), h: pt(s.attrs.h) } })
  if (!pic && slide.attrs.layout_name === '图文') {
    const b = layoutSpec(slide.attrs.theme as string | null, 'image_text').find(s => s.type === 'pic')!.box
    pic = { x: b[0], y: b[1], w: b[2], h: b[3] }
  }
  if (pic) {
    const p = pic as { x: number; y: number; w: number; h: number }
    // 等比缩放到刚好放进图片区（contain），居中
    const w = Math.min(p.w, p.h / ratio)
    const h = w * ratio
    return { x: Math.round(p.x + (p.w - w) / 2), y: Math.round(p.y + (p.h - h) / 2), w: Math.round(w), h: Math.round(h) }
  }
  const w = 400
  return { x: 280, y: Math.max(40, Math.round((540 - w * ratio) / 2)), w, h: Math.round(w * ratio) }
}
