import { Resvg } from '@resvg/resvg-js'
import { DECK_THEMES } from '../model/deck-themes.ts'
import { imageSize, ORG_BASES, orgLogoId, orgThemeKey, registerOrgTemplate, unregisterOrgTemplate } from '../model/org-templates.ts'
import type { Store, TenantTemplateRow } from '../store/db.ts'
import { TenantError, type TenantService } from './tenants.ts'

/**
 * 机构幻灯片模板（机构设置的一部分）：机构管理员新建 / 编辑 / 删除、上传院徽；本机构成员在模板选择器里看到并使用。
 * 存平台库 tenant_templates，改动后立即同步到运行时登记（org-templates.ts）。
 * 院徽：PNG / JPEG 原样保存，SVG 转成 PNG；≤ 1 MB。平台不内置任何机构的院徽，由机构用官方文件上传。
 */

export const LOGO_MAX = 1024 * 1024
const COLOR_KEYS = ['bg', 'surface', 'soft', 'title', 'body', 'muted', 'accent', 'accent2'] as const
type ColorKey = (typeof COLOR_KEYS)[number]

export interface OrgTemplateView {
  id: string; key: string; label: string; description: string; org_name: string; footer: string; base: string
  colors: Record<ColorKey, string>; fonts: { titleFont: string; bodyFont: string; serif: boolean }
  has_logo: boolean; logo_url: string | null; created_at: string; updated_at: string
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export class OrgTemplateService {
  constructor(private readonly store: Store, private readonly tenants: TenantService) {}

  /** 启动时把全部机构模板登记进运行时。 */
  loadAll(): number {
    const rows = this.store.listTenantTemplates()
    for (const r of rows) registerOrgTemplate(r)
    return rows.length
  }

  private view(r: TenantTemplateRow): OrgTemplateView {
    const t = DECK_THEMES[orgThemeKey(r.id)]!
    return {
      id: r.id, key: orgThemeKey(r.id), label: r.label, description: r.description, org_name: r.org_name, footer: r.footer, base: r.base,
      colors: Object.fromEntries(COLOR_KEYS.map(k => [k, t[k]])) as Record<ColorKey, string>,
      fonts: { titleFont: t.titleFont, bodyFont: t.bodyFont, serif: !!t.serif },
      has_logo: !!r.logo, logo_url: r.logo ? `/api/assets/${orgLogoId(r.id)}` : null, created_at: r.created_at, updated_at: r.updated_at,
    }
  }

  private requireAdmin(actor: string) {
    const t = this.tenants.of(actor)
    if (this.tenants.roleOf(actor) !== 'admin') throw new TenantError('forbidden', '只有机构管理员能管理机构模板', 403)
    return t
  }

  /** 本机构的模板（成员都能看）。 */
  list(actor: string): OrgTemplateView[] {
    const t = this.tenants.of(actor)
    return this.store.listTenantTemplates(t.id).map(r => this.view(r))
  }

  private own(actor: string, id: string): TenantTemplateRow {
    const t = this.requireAdmin(actor)
    const r = this.store.getTenantTemplate(id)
    if (!r || r.tenant_id !== t.id) throw new TenantError('not_found', '模板不存在', 404)
    return r
  }

  create(actor: string, input: Record<string, unknown>): OrgTemplateView {
    const t = this.requireAdmin(actor)
    const label = clean(input.label, 40)
    const org_name = clean(input.org_name, 80)
    if (!label) throw new TenantError('bad_label', '模板名称不能为空')
    if (!org_name) throw new TenantError('bad_org_name', '机构名称不能为空')
    if (this.store.listTenantTemplates(t.id).length >= 20) throw new TenantError('too_many', '一个机构最多 20 套模板', 409)
    const row = this.store.addTenantTemplate({
      tenant_id: t.id, label, org_name, description: clean(input.description, 200), footer: clean(input.footer, 80),
      base: base(input.base) ?? 'clinical', colors: JSON.stringify(colors(input.colors)), fonts: JSON.stringify(fonts(input.fonts)), created_by: actor,
    })
    registerOrgTemplate(row)
    return this.view(row)
  }

  update(actor: string, id: string, patch: Record<string, unknown>): OrgTemplateView {
    const r = this.own(actor, id)
    const next: Parameters<Store['updateTenantTemplate']>[1] = {}
    if (patch.label !== undefined) { const v = clean(patch.label, 40); if (!v) throw new TenantError('bad_label', '模板名称不能为空'); next.label = v }
    if (patch.org_name !== undefined) { const v = clean(patch.org_name, 80); if (!v) throw new TenantError('bad_org_name', '机构名称不能为空'); next.org_name = v }
    if (patch.description !== undefined) next.description = clean(patch.description, 200)
    if (patch.footer !== undefined) next.footer = clean(patch.footer, 80)
    if (patch.base !== undefined) { const b = base(patch.base); if (!b) throw new TenantError('bad_base', `基础风格只能是 ${ORG_BASES.join(' / ')}`); next.base = b }
    if (patch.colors !== undefined) next.colors = JSON.stringify({ ...JSON.parse(r.colors || '{}'), ...colors(patch.colors) })
    if (patch.fonts !== undefined) next.fonts = JSON.stringify({ ...JSON.parse(r.fonts || '{}'), ...fonts(patch.fonts) })
    this.store.updateTenantTemplate(id, next)
    const row = this.store.getTenantTemplate(id)!
    registerOrgTemplate(row)
    return this.view(row)
  }

  remove(actor: string, id: string): void {
    this.own(actor, id)
    this.store.deleteTenantTemplate(id)
    unregisterOrgTemplate(id)
  }

  /** 上传院徽：PNG / JPEG 原样保存，SVG 转 PNG（高 512 像素）。 */
  setLogo(actor: string, id: string, bytes: Uint8Array, mime: string): OrgTemplateView {
    this.own(actor, id)
    if (bytes.length === 0) throw new TenantError('bad_logo', '院徽文件是空的')
    if (bytes.length > LOGO_MAX) throw new TenantError('logo_too_large', '院徽文件不能超过 1 MB')
    let out = bytes
    let type: string
    const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart()
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) type = 'image/png'
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) type = 'image/jpeg'
    else if (mime === 'image/svg+xml' || /^(<\?xml[^>]*>\s*)?<svg\b/i.test(head)) {
      try { out = new Uint8Array(new Resvg(Buffer.from(bytes), { fitTo: { mode: 'height', value: 512 }, background: 'rgba(0,0,0,0)' }).render().asPng()) } catch { throw new TenantError('bad_logo', 'SVG 读不出来，换成 PNG 试试') }
      type = 'image/png'
      if (out.length > LOGO_MAX) throw new TenantError('logo_too_large', 'SVG 转成图片后超过 1 MB')
    } else throw new TenantError('bad_logo', '院徽只支持 PNG、JPEG 或 SVG')
    const size = imageSize(out)
    if (size.width < 16 || size.height < 16) throw new TenantError('bad_logo', '院徽图片太小（至少 16×16 像素）')
    this.store.updateTenantTemplate(id, { logo: out, logo_mime: type })
    const row = this.store.getTenantTemplate(id)!
    registerOrgTemplate(row)
    return this.view(row)
  }

  clearLogo(actor: string, id: string): OrgTemplateView {
    this.own(actor, id)
    this.store.updateTenantTemplate(id, { logo: null, logo_mime: null })
    const row = this.store.getTenantTemplate(id)!
    registerOrgTemplate(row)
    return this.view(row)
  }
}

function base(v: unknown): string | null {
  return typeof v === 'string' && ORG_BASES.includes(v) ? v : null
}

function colors(v: unknown): Partial<Record<ColorKey, string>> {
  const out: Partial<Record<ColorKey, string>> = {}
  if (!v || typeof v !== 'object') return out
  for (const k of COLOR_KEYS) {
    const c = (v as Record<string, unknown>)[k]
    if (typeof c !== 'string') continue
    const hex = c.trim().replace(/^#/, '')
    if (!/^[0-9a-f]{6}$/i.test(hex)) throw new TenantError('bad_color', `颜色 ${k} 要写成 6 位十六进制，如 004098`)
    out[k] = hex.toUpperCase()
  }
  return out
}

function fonts(v: unknown): { titleFont?: string; bodyFont?: string; serif?: boolean } {
  if (!v || typeof v !== 'object') return {}
  const f = v as Record<string, unknown>
  return {
    ...(clean(f.titleFont, 40) ? { titleFont: clean(f.titleFont, 40) } : {}),
    ...(clean(f.bodyFont, 40) ? { bodyFont: clean(f.bodyFont, 40) } : {}),
    ...(typeof f.serif === 'boolean' ? { serif: f.serif } : {}),
  }
}
