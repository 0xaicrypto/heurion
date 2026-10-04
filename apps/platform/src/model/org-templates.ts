import type { TenantTemplateRow } from '../store/db.ts'
import { DECK_THEMES, type DeckTheme } from './deck-themes.ts'

/**
 * 机构幻灯片模板的运行时登记（静态模板 + 机构模板）。
 * - 机构模板存在平台库（tenant_templates），启动时全部登记进来，增删改时同步（OrgTemplateService 负责），
 *   登记 = 往 DECK_THEMES 里放一条 org_<id>，所以按 key 取主题的地方（配色、版式、装饰、导出）都不用区分来源。
 * - 版式几何与装饰骨架沿用一套内置模板（base），再加机构装饰：院徽、页脚机构名称。
 * - 谁能用：只有模板所属机构的成员（列表、新建、换模板、院徽图片都按调用者机构过滤）。
 */

export const ORG_PREFIX = 'org_'
export const ORG_LOGO_PREFIX = 'ol_'
/** 内置模板的 key（机构模板登记前的快照）。 */
export const BUILTIN_THEME_KEYS: readonly string[] = Object.keys(DECK_THEMES)
/** 机构模板能沿用的骨架（带图模板不行：照片装饰属于那套模板）。 */
export const ORG_BASES = BUILTIN_THEME_KEYS.filter(k => !DECK_THEMES[k]!.photo)

export interface OrgMeta {
  id: string
  tenant_id: string
  org_name: string
  footer: string
  base: string
  /** 院徽（PNG / JPEG）与像素尺寸（装饰按比例放置） */
  logo: { mime: string; bytes: Uint8Array; width: number; height: number } | null
}

const META = new Map<string, OrgMeta>()
let tenantOf: ((userId: string) => string | null) | null = null

export const isOrgThemeKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith(ORG_PREFIX)
export const orgThemeKey = (id: string) => `${ORG_PREFIX}${id}`
export const orgLogoId = (id: string) => `${ORG_LOGO_PREFIX}${id}`
export const orgMeta = (key: string | null | undefined): OrgMeta | null => (key && META.get(key)) || null
/** 版式与装饰按哪套内置模板（机构模板 → 它的骨架；内置模板 → 自己）。 */
export const baseOf = (key: string): string => META.get(key)?.base ?? key

/** 调用者 → 所属机构（index.ts 启动时接上 TenantService；测试里可换）。 */
export function setOrgTenantResolver(fn: ((userId: string) => string | null) | null): void {
  tenantOf = fn
}

function tenantOfUser(userId: string): string | null {
  try { return tenantOf?.(userId) ?? null } catch { return null }
}

/** 这个用户能不能用这套模板（内置模板都能用；机构模板只给本机构成员）。 */
export function themeAllowed(key: string, userId: string): boolean {
  if (!isOrgThemeKey(key)) return !!DECK_THEMES[key]
  const m = META.get(key)
  return !!m && tenantOfUser(userId) === m.tenant_id
}

/** 用户能用的模板 key：本机构模板在前，再是内置模板。 */
export function themeKeysFor(userId: string | null): string[] {
  const tid = userId ? tenantOfUser(userId) : null
  const org = tid ? [...META.values()].filter(m => m.tenant_id === tid).map(m => orgThemeKey(m.id)) : []
  return [...org, ...BUILTIN_THEME_KEYS]
}

/** PNG / JPEG 头里读像素尺寸（院徽按比例放置用；读不出时当正方形）。 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue }
      const marker = bytes[i + 1]!
      const len = dv.getUint16(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) }
      i += 2 + len
    }
  }
  return { width: 1, height: 1 }
}

function parse<T>(json: string, fallback: T): T {
  try { return { ...fallback, ...(JSON.parse(json) as T) } } catch { return fallback }
}

/** 登记（或更新）一套机构模板。 */
export function registerOrgTemplate(row: TenantTemplateRow): void {
  const key = orgThemeKey(row.id)
  const base = DECK_THEMES[row.base] && !DECK_THEMES[row.base]!.photo && !isOrgThemeKey(row.base) ? row.base : 'clinical'
  const b = DECK_THEMES[base]!
  const colors = parse<Partial<DeckTheme>>(row.colors, {})
  const fonts = parse<{ titleFont?: string; bodyFont?: string; serif?: boolean }>(row.fonts, {})
  const pick = (k: 'bg' | 'surface' | 'soft' | 'title' | 'body' | 'muted' | 'accent' | 'accent2') => typeof colors[k] === 'string' && /^[0-9A-F]{6}$/i.test(colors[k] as string) ? (colors[k] as string).toUpperCase() : b[k]
  const theme: DeckTheme = {
    label: row.label, description: row.description || `${row.org_name}的机构模板`,
    bg: pick('bg'), surface: pick('surface'), soft: pick('soft'), title: pick('title'), body: pick('body'), muted: pick('muted'), accent: pick('accent'), accent2: pick('accent2'),
    titleFont: fonts.titleFont || b.titleFont, bodyFont: fonts.bodyFont || b.bodyFont, ...(fonts.serif ?? b.serif ? { serif: true } : {}),
    frame: b.frame, tags: ['本机构'],
  }
  DECK_THEMES[key] = theme
  const logo = row.logo && row.logo_mime ? { mime: row.logo_mime, bytes: new Uint8Array(row.logo), ...imageSize(new Uint8Array(row.logo)) } : null
  META.set(key, { id: row.id, tenant_id: row.tenant_id, org_name: row.org_name, footer: row.footer, base, logo })
}

export function unregisterOrgTemplate(id: string): void {
  const key = orgThemeKey(id)
  META.delete(key)
  delete DECK_THEMES[key]
}

/** 院徽图片（资产 id ol_<模板 id>）；userId 给出时只给本机构成员。 */
export function orgLogo(assetId: string, userId?: string): { mime: string; bytes: Uint8Array } | null {
  if (typeof assetId !== 'string' || !assetId.startsWith(ORG_LOGO_PREFIX)) return null
  const m = META.get(orgThemeKey(assetId.slice(ORG_LOGO_PREFIX.length)))
  if (!m?.logo) return null
  if (userId !== undefined && tenantOfUser(userId) !== m.tenant_id) return null
  return { mime: m.logo.mime, bytes: m.logo.bytes }
}

/** 测试用：清空登记。 */
export function resetOrgTemplates(): void {
  for (const key of [...META.keys()]) { META.delete(key); delete DECK_THEMES[key] }
}

/** 安徽省立医院（中国科学技术大学附属第一医院）官网标准色：藏蓝 #004098、红 #C90304、青 #00ADA9。院徽由机构用官方文件上传。 */
export const PRESET_AHSLYY = {
  label: '安徽省立医院', org_name: '中国科学技术大学附属第一医院（安徽省立医院）', base: 'clinical',
  colors: { bg: 'FFFFFF', surface: 'F2F5FA', soft: 'E2EAF5', title: '004098', body: '1F2937', muted: '5F6B7A', accent: 'C90304', accent2: '00ADA9' },
}
