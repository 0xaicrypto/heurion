import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { strFromU8, unzipSync } from 'fflate'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { pptxFor } from '../src/convert/exports.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { ImageService } from '../src/images/service.ts'
import { Unsplash, UnsplashError, withUtm } from '../src/images/unsplash.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { pt } from '../src/model/deck-schema.ts'
import { Documents } from '../src/model/runtime.ts'
import { newTemplateDeck } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'
import { fakeUnsplash } from './fake-unsplash.ts'

function env(configured = true) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const fake = fakeUnsplash()
  const images = new ImageService(docs, ops, configured ? fake.unsplash : new Unsplash(''))
  const row = docs.create({ owner: 'dev', title: '汇报', kind: 'deck', content: newTemplateDeck('SELECT 试验', 'mist') })
  store.putPackage(row.id, 'pptx', pptxTemplate('mist'))
  const cover = docs.get(row.id).child(0).attrs.id as string
  const r = ops.edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: [{ op: 'add_slide', after: cover, layout: '图文', title: '典型病例' }, { op: 'add_slide', after: cover, layout: '标题和内容', title: '研究设计' }] }, { actor: 'user', turnId: null })
  const [picSlide, contentSlide] = [r.results[0]!.ids[0]!, r.results[1]!.ids[0]!]
  const slide = (id: string) => { let out: any = null; docs.get(row.id).forEach(s => { if (s.attrs.id === id) out = s }); return out }
  return { store, docs, ops, images, fake, docId: row.id, picSlide, contentSlide, slide }
}

describe('Unsplash 客户端', () => {
  it('搜索：署名带 utm，key 只在请求头里', async () => {
    const { unsplash, calls } = fakeUnsplash()
    const r = await unsplash.search('mountain', 1)
    expect(r.results.map(p => p.id)).toEqual(['abc123', 'def456'])
    expect(r.results[0]!.credit).toEqual({ name: 'Ada Lab', profile: 'https://unsplash.com/@adalab?utm_source=heurion&utm_medium=referral', photo_page: 'https://unsplash.com/photos/abc123?utm_source=heurion&utm_medium=referral', text: 'Photo by Ada Lab on Unsplash' })
    expect(calls.every(u => !u.includes('test-key'))).toBe(true)
    expect(withUtm('https://unsplash.com/?a=1')).toBe('https://unsplash.com/?a=1&utm_source=heurion&utm_medium=referral')
  })

  it('使用照片：先触发 download_location，再按尺寸下载', async () => {
    const { unsplash, calls } = fakeUnsplash()
    const used = await unsplash.use('abc123')
    expect(used.mime).toBe('image/jpeg')
    expect(calls.some(u => u.startsWith('https://api.unsplash.com/photos/abc123/download'))).toBe(true)
    expect(calls.at(-1)).toMatch(/^https:\/\/images\.unsplash\.com\/photo-abc123\?ixid=x&w=1920&q=80&fm=jpg&fit=max$/)
    await expect(unsplash.use('nope')).rejects.toMatchObject({ code: 'photo_not_found' })
  })

  it('未配置：明确报「未配置」，不发请求', async () => {
    await expect(new Unsplash('').search('x')).rejects.toBeInstanceOf(UnsplashError)
    await expect(new Unsplash('').search('x')).rejects.toMatchObject({ code: 'unsplash_unconfigured', status: 503 })
  })
})

describe('照片插入幻灯片', () => {
  it('图文版式放进图片区；资产属于文档所有者；署名进图片说明与演讲备注；导出 pptx 内嵌并保留署名', async () => {
    const t = env()
    const r = await t.images.addToSlide('dev', { doc_id: t.docId, slide_id: t.picSlide, photo_id: 'abc123' }, { actor: 'user', turnId: null })
    expect(t.store.getAsset(r.asset_id)).toMatchObject({ owner: 'dev', mime: 'image/jpeg', name: 'unsplash-abc123.jpg' })
    const slide = t.slide(t.picSlide)
    let pic: any = null, img: any = null
    slide.forEach((s: any) => { if (/:picture$/.test(s.attrs.name)) pic = s; if (s.attrs.id === r.shape_id) img = s })
    expect(img.attrs).toMatchObject({ kind: 'image', asset_id: r.asset_id, description: 'Photo by Ada Lab on Unsplash' })
    // 等比放进图片区（1600×1000 → 宽占满）
    expect(pt(img.attrs.x)).toBeGreaterThanOrEqual(pt(pic.attrs.x))
    expect(pt(img.attrs.x) + pt(img.attrs.w)).toBeLessThanOrEqual(pt(pic.attrs.x) + pt(pic.attrs.w) + 1)
    expect(pt(img.attrs.y) + pt(img.attrs.h)).toBeLessThanOrEqual(pt(pic.attrs.y) + pt(pic.attrs.h) + 1)
    expect(slide.lastChild.type.name).toBe('notes')
    expect(slide.lastChild.textContent).toContain('Photo by Ada Lab on Unsplash')
    // 再插一张：署名追加，不覆盖
    await t.images.addToSlide('dev', { doc_id: t.docId, slide_id: t.picSlide, photo_id: 'def456' }, { actor: 'ai', turnId: null })
    expect(t.slide(t.picSlide).lastChild.textContent).toMatch(/Ada Lab[\s\S]*Ben Hill/)
    const files = unzipSync(pptxFor(t.docs, t.docId).bytes)
    expect(Object.keys(files).some(f => /^ppt\/media\/.*\.(jpe?g)$/.test(f))).toBe(true)
    // 导出：署名在图片的替代文字（descr）里（新增页的备注暂不导出，见 pptx-export）
    expect(Object.entries(files).filter(([f]) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map(([, b]) => strFromU8(b)).join('')).toContain('descr="Photo by Ben Hill on Unsplash"')
  })

  it('其他版式居中；别人的文档、不存在的页都拒绝', async () => {
    const t = env()
    const r = await t.images.addToSlide('dev', { doc_id: t.docId, slide_id: t.contentSlide, photo_id: 'abc123' }, { actor: 'user', turnId: null })
    let img: any = null
    t.slide(t.contentSlide).forEach((s: any) => { if (s.attrs.id === r.shape_id) img = s })
    expect([pt(img.attrs.x), pt(img.attrs.w)]).toEqual([280, 400])
    await expect(t.images.addToSlide('eve', { doc_id: t.docId, slide_id: t.contentSlide, photo_id: 'abc123' }, { actor: 'user', turnId: null })).rejects.toMatchObject({ status: 404 })
    await expect(t.images.addToSlide('dev', { doc_id: t.docId, slide_id: 'nope', photo_id: 'abc123' }, { actor: 'user', turnId: null })).rejects.toMatchObject({ status: 404 })
  })
})

describe('接口与 MCP（人机同一个服务）', () => {
  const app = (t: ReturnType<typeof env>) => buildApi({
    docs: t.docs, ops: t.ops, turns: new TurnService(t.docs, {} as HarnessPool, new TurnRegistry()), postcheck: new PostCheck(t.docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-'))), accounts: new Accounts(t.store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev' }), devMode: true, devUser: 'dev', images: t.images,
  })
  const mcp = async (t: ReturnType<typeof env>) => {
    const claims = verifyToken('s', issueToken('s', { u: 'dev', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs: t.docs, ops: t.ops, turns: new TurnRegistry(), secret: 's', claims: new ClaimService(t.docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => tmpdir(), isLiveSession: () => true, images: t.images,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'img', version: '0' })
    await client.connect(b)
    return client
  }
  const H = { Authorization: 'Bearer dev', 'Content-Type': 'application/json' }
  const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join('')

  it('配置了：界面搜索、插入（写审计）；AI 搜索、插入', async () => {
    const t = env()
    const api = app(t)
    expect(await (await api.request('/api/images', { headers: H })).json()).toEqual({ configured: true, source: 'unsplash' })
    const s = await (await api.request('/api/images/search?q=lab', { headers: H })).json()
    expect(s.results[0]).toMatchObject({ id: 'abc123', credit: { text: 'Photo by Ada Lab on Unsplash' } })
    const res = await api.request(`/api/docs/${t.docId}/slides/${t.picSlide}/photo`, { method: 'POST', headers: H, body: JSON.stringify({ photo_id: 'def456' }) })
    expect(res.status).toBe(201)
    expect(t.store.listAudit({}).some(a => a.action === 'deck.add_photo')).toBe(true)
    const client = await mcp(t)
    expect(text(await client.callTool({ name: 'image_search', arguments: { query: 'mountain' } }))).toContain('Photo by Ben Hill on Unsplash')
    const r = JSON.parse(text(await client.callTool({ name: 'slide_add_photo', arguments: { doc_id: t.docId, slide_id: t.contentSlide, photo_id: 'abc123' } })))
    expect(r.credit.text).toBe('Photo by Ada Lab on Unsplash')
  })

  it('没配置：界面隐藏入口（configured=false）、接口 503、MCP 返回 unsplash_unconfigured', async () => {
    const t = env(false)
    const api = app(t)
    expect(await (await api.request('/api/images', { headers: H })).json()).toEqual({ configured: false, source: 'unsplash' })
    expect((await api.request('/api/images/search?q=lab', { headers: H })).status).toBe(503)
    expect((await api.request(`/api/docs/${t.docId}/slides/${t.picSlide}/photo`, { method: 'POST', headers: H, body: JSON.stringify({ photo_id: 'abc123' }) })).status).toBe(503)
    const client = await mcp(t)
    expect(text(await client.callTool({ name: 'image_search', arguments: { query: 'x' } }))).toContain('unsplash_unconfigured')
    expect(text(await client.callTool({ name: 'slide_add_photo', arguments: { doc_id: t.docId, slide_id: t.picSlide, photo_id: 'abc123' } }))).toContain('unsplash_unconfigured')
  })

  it('带图模板的内置照片：登录用户可取', async () => {
    const t = env()
    const r = await app(t).request('/api/assets/tp_mist_cover', { headers: H })
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'image/jpeg'])
    expect((await app(t).request('/api/assets/tp_mist_cover')).status).toBe(401)
  })
})
