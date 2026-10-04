import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { isDecoName } from '../src/model/deck-templates.ts'
import { DECK_THEMES } from '../src/model/deck-themes.ts'
import { PRESET_AHSLYY, resetOrgTemplates } from '../src/model/org-templates.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

/** 占位院徽（自己画的，不是任何机构的真实院徽）。 */
const placeholderLogo = (w = 240, h = 120) => new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="16" fill="#004098"/><circle cx="${h / 2}" cy="${h / 2}" r="${h / 3}" fill="#C90304"/></svg>`).render().asPng())

function env() {
  resetOrgTemplates()
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))), accounts, devMode: false, devUser: 'dev',
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }) => {
    if (/^\/api\/auth\/(register|login)$/.test(path) && body && typeof body === 'object') {
      body = { ...body, pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? Buffer.from(raw.bytes) : body !== undefined ? JSON.stringify(body) : undefined,
    })
    const buf = new Uint8Array(await res.arrayBuffer())
    let data: any = new TextDecoder().decode(buf)
    try { data = JSON.parse(data) } catch { /* 非 JSON */ }
    return { status: res.status, data, buf, type: res.headers.get('content-type') }
  }
  const register = async (username: string, invite?: string) => {
    const r = await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })
    if (r.status !== 201) throw new Error(`${username}: ${JSON.stringify(r.data)}`)
    return { id: r.data.user.id as string, token: r.data.token as string }
  }
  return { store, docs, call, register }
}

/** 平台运营建机构，管理员凭邀请加入，再邀请一位普通成员。 */
async function hospital(t: ReturnType<typeof env>, op: { token: string }, name: string, prefix: string) {
  const created = await t.call('POST', '/api/platform/tenants', op.token, { name })
  const admin = await t.register(`${prefix}_admin`, created.data.invite.code)
  const inv = await t.call('POST', '/api/tenant/invites', admin.token, { role: 'member' })
  const member = await t.register(`${prefix}_doc`, inv.data.code)
  return { admin, member }
}

describe('机构幻灯片模板', () => {
  it('管理员按预设建模板、上传院徽；本机构成员在模板列表最前面看到它，别的机构看不到；成员不能管理', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '安徽省立医院', 'ah')
    const b = await hospital(t, op, '别的医院', 'bb')

    const meta = await t.call('GET', '/api/tenant/templates', a.admin.token)
    expect(meta.data.presets[0]).toMatchObject({ label: '安徽省立医院', colors: { title: '004098', accent: 'C90304', accent2: '00ADA9' } })
    expect(meta.data.bases.map((x: { key: string }) => x.key)).toContain('clinical')

    const created = await t.call('POST', '/api/tenant/templates', a.admin.token, { ...PRESET_AHSLYY, footer: '安徽省立医院 · 心血管内科' })
    expect(created.status).toBe(201)
    const tpl = created.data
    expect(tpl).toMatchObject({ key: `org_${tpl.id}`, base: 'clinical', has_logo: false, colors: { title: '004098', accent: 'C90304' } })

    // 成员能看列表，不能新建 / 编辑 / 删除 / 上传院徽
    expect((await t.call('GET', '/api/tenant/templates', a.member.token)).data.templates).toHaveLength(1)
    expect((await t.call('POST', '/api/tenant/templates', a.member.token, PRESET_AHSLYY)).status).toBe(403)
    expect((await t.call('PATCH', `/api/tenant/templates/${tpl.id}`, a.member.token, { label: 'x' })).status).toBe(403)
    expect((await t.call('DELETE', `/api/tenant/templates/${tpl.id}`, a.member.token)).status).toBe(403)
    expect((await t.call('PUT', `/api/tenant/templates/${tpl.id}/logo`, a.member.token, undefined, { bytes: placeholderLogo(), type: 'image/png' })).status).toBe(403)
    // 别的机构的管理员：看不到、改不了
    expect((await t.call('GET', '/api/tenant/templates', b.admin.token)).data.templates).toHaveLength(0)
    expect((await t.call('PATCH', `/api/tenant/templates/${tpl.id}`, b.admin.token, { label: 'x' })).status).toBe(404)
    expect((await t.call('DELETE', `/api/tenant/templates/${tpl.id}`, b.admin.token)).status).toBe(404)

    // 院徽：PNG 原样；SVG 转 PNG；不是图片 / 超过 1 MB 拒绝
    const up = await t.call('PUT', `/api/tenant/templates/${tpl.id}/logo`, a.admin.token, undefined, { bytes: placeholderLogo(), type: 'image/png' })
    expect(up.data).toMatchObject({ has_logo: true, logo_url: `/api/assets/ol_${tpl.id}` })
    expect((await t.call('PUT', `/api/tenant/templates/${tpl.id}/logo`, a.admin.token, undefined, { bytes: new TextEncoder().encode('hello'), type: 'text/plain' })).status).toBe(400)
    expect((await t.call('PUT', `/api/tenant/templates/${tpl.id}/logo`, a.admin.token, undefined, { bytes: new Uint8Array(1024 * 1024 + 1).fill(0x89), type: 'image/png' })).status).toBe(400)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#00ADA9"/></svg>')
    const tpl2 = (await t.call('POST', '/api/tenant/templates', a.admin.token, { label: '第二套', org_name: '安徽省立医院', base: 'swiss' })).data
    expect((await t.call('PUT', `/api/tenant/templates/${tpl2.id}/logo`, a.admin.token, undefined, { bytes: svg, type: 'image/svg+xml' })).data.has_logo).toBe(true)

    // 院徽图片只给本机构成员
    const logo = await t.call('GET', `/api/assets/ol_${tpl.id}`, a.member.token)
    expect([logo.status, logo.type]).toEqual([200, 'image/png'])
    expect((await t.call('GET', `/api/assets/ol_${tpl.id}`, b.member.token)).status).toBe(404)

    // 模板列表：本机构在前（标本机构），别的机构看不到
    const mine = (await t.call('GET', '/api/deck-templates', a.member.token)).data
    expect(mine.slice(0, 2).map((x: { key: string }) => x.key).sort()).toEqual([`org_${tpl.id}`, `org_${tpl2.id}`].sort())
    expect(mine[0]).toMatchObject({ org: true, tags: ['本机构'] })
    const other = (await t.call('GET', '/api/deck-templates', b.member.token)).data
    expect(other.some((x: { key: string }) => x.key.startsWith('org_'))).toBe(false)
    expect(Object.keys((await t.call('GET', '/api/deck-themes', b.member.token)).data).some(k => k.startsWith('org_'))).toBe(false)

    // 校验：坏颜色、骨架不能是带图模板
    expect((await t.call('PATCH', `/api/tenant/templates/${tpl.id}`, a.admin.token, { colors: { accent: 'red' } })).status).toBe(400)
    expect((await t.call('PATCH', `/api/tenant/templates/${tpl.id}`, a.admin.token, { base: 'lab' })).status).toBe(400)
  })

  it('用机构模板新建 deck：封面院徽、内容页页脚（主色线 + 机构名称 + 小院徽）；换模板整体替换；导出 pptx 内嵌院徽；别的机构不能套用', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '安徽省立医院', 'ah')
    const b = await hospital(t, op, '别的医院', 'bb')
    const tpl = (await t.call('POST', '/api/tenant/templates', a.admin.token, { ...PRESET_AHSLYY, footer: '安徽省立医院 · 心血管内科' })).data
    const key = `org_${tpl.id}`
    await t.call('PUT', `/api/tenant/templates/${tpl.id}/logo`, a.admin.token, undefined, { bytes: placeholderLogo(), type: 'image/png' })

    const d = (await t.call('POST', '/api/docs', a.member.token, { title: '科室会', kind: 'deck', template: key })).data
    const doc = () => t.docs.get(d.id)
    const shapesOf = (i: number) => { const out: any[] = []; doc().child(i).forEach(s => { if (s.type.name === 'shape') out.push(s) }); return out }
    expect(doc().child(0).attrs).toMatchObject({ theme: key, bg: 'FFFFFF' })
    const cover = shapesOf(0)
    const coverLogo = cover.find(s => isDecoName(s.attrs.name) && s.attrs.asset_id === `ol_${tpl.id}`)
    expect(coverLogo?.attrs.kind).toBe('image')
    // 院徽按原图比例（240×120 → 高 72pt、宽 144pt），在右上角
    expect([Math.round(coverLogo.attrs.w / 12700), Math.round(coverLogo.attrs.h / 12700)]).toEqual([144, 72])

    const edit = async (ops: unknown[], token = a.member.token) => t.call('POST', `/api/docs/${d.id}/edit`, token, { base_rev: t.docs.rev(d.id), ops })
    const added = await edit([{ op: 'add_slide', after: doc().child(0).attrs.id, layout: '标题和内容', title: '研究设计', body: '- 多中心\n- 随机双盲' }])
    expect(added.status).toBe(200)
    const content = shapesOf(1)
    const footer = content.find(s => s.attrs.name?.endsWith(':footer-name'))
    expect(footer?.textContent).toBe('安徽省立医院 · 心血管内科')
    expect(content.find(s => s.attrs.name?.endsWith(':footer-rule'))?.attrs.fill).toBe('004098')
    expect(content.some(s => s.attrs.asset_id === `ol_${tpl.id}`)).toBe(true)
    // 机构名称是装饰：不能写字
    expect((await edit([{ op: 'set_text', shape_id: footer.attrs.id, markdown: '改掉' }])).status).toBe(409)

    // 导出 pptx：院徽内嵌，主题强调色是机构红
    const pptx = await t.call('GET', `/api/docs/${d.id}/export.pptx`, a.member.token)
    expect(pptx.status).toBe(200)
    const files = unzipSync(pptx.buf)
    const logoBytes = placeholderLogo()
    expect(Object.entries(files).some(([name, bytes]) => name.startsWith('ppt/media/') && bytes.length === logoBytes.length)).toBe(true)
    expect(new TextDecoder().decode(files['ppt/theme/theme1.xml']!)).toContain('C90304')

    // 换成内置模板：机构装饰全部拿掉
    expect((await edit([{ op: 'apply_theme', theme: 'paper' }])).status).toBe(200)
    expect([0, 1].flatMap(i => shapesOf(i)).some(s => String(s.attrs.name).includes(key) || s.attrs.asset_id === `ol_${tpl.id}`)).toBe(false)
    // 再换回来：装饰回来
    expect((await edit([{ op: 'apply_theme', theme: key }])).status).toBe(200)
    expect(shapesOf(1).some(s => s.attrs.name?.endsWith(':footer-name'))).toBe(true)

    // 别的机构：不能新建（回落到默认模板），不能套用
    const other = (await t.call('POST', '/api/docs', b.member.token, { title: '汇报', kind: 'deck', template: key })).data
    expect(t.docs.get(other.id).child(0).attrs.theme).toBe('clinical')
    const r = await t.call('POST', `/api/docs/${other.id}/edit`, b.member.token, { base_rev: t.docs.rev(other.id), ops: [{ op: 'apply_theme', theme: key }] })
    expect([r.status, r.data.code]).toEqual([409, 'theme_not_found'])
  })

  it('没上传院徽时不放院徽、其余照常；删除模板后旧 deck 仍能打开和导出', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '安徽省立医院', 'ah')
    const tpl = (await t.call('POST', '/api/tenant/templates', a.admin.token, PRESET_AHSLYY)).data
    const key = `org_${tpl.id}`
    const d = (await t.call('POST', '/api/docs', a.member.token, { title: '汇报', kind: 'deck', template: key })).data
    const add = await t.call('POST', `/api/docs/${d.id}/edit`, a.member.token, { base_rev: t.docs.rev(d.id), ops: [{ op: 'add_slide', after: t.docs.get(d.id).child(0).attrs.id, layout: '两栏', title: '对比' }] })
    expect(add.status).toBe(200)
    const all: any[] = []
    t.docs.get(d.id).forEach(sl => sl.forEach(s => { all.push(s) }))
    expect(all.some(s => s.attrs.kind === 'image')).toBe(false)
    expect(all.find(s => s.attrs.name?.endsWith(':footer-name'))?.textContent).toBe(PRESET_AHSLYY.org_name)

    expect((await t.call('DELETE', `/api/tenant/templates/${tpl.id}`, a.admin.token)).status).toBe(200)
    expect(DECK_THEMES[key]).toBeUndefined()
    expect((await t.call('GET', `/api/docs/${d.id}/export.pptx`, a.member.token)).status).toBe(200)
    // 删除后再套用这个 key：参数校验就拒绝（没有这个模板）
    const r = await t.call('POST', `/api/docs/${d.id}/edit`, a.member.token, { base_rev: t.docs.rev(d.id), ops: [{ op: 'apply_theme', theme: key }] })
    expect([r.status, r.data.code]).toEqual([400, 'validation_error'])
  })

  it('重启后从平台库重新登记', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '安徽省立医院', 'ah')
    const tpl = (await t.call('POST', '/api/tenant/templates', a.admin.token, PRESET_AHSLYY)).data
    resetOrgTemplates()
    expect(DECK_THEMES[`org_${tpl.id}`]).toBeUndefined()
    const { OrgTemplateService } = await import('../src/auth/org-templates.ts')
    const { TenantService } = await import('../src/auth/tenants.ts')
    expect(new OrgTemplateService(t.store, new TenantService(t.store, { devMode: false })).loadAll()).toBe(1)
    expect(DECK_THEMES[`org_${tpl.id}`]?.accent).toBe('C90304')
  })
})
