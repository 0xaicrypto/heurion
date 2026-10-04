import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 带图模板的照片（来自 Unsplash，见 theme-photos/ATTRIBUTION.md）：随平台打包，不是用户资产。
 * 在 deck 里以内置资产 id 引用：`tp_<模板>_cover`（全幅压暗版，封面 / 致谢）、`tp_<模板>_panel`（竖幅，早期章节页）、`tp_<模板>_wash`（与模板底色混合到很淡的全幅版，章节页背景）。
 * 查看器、导出、AI 读到的与普通图片一致；任何登录用户都能取（公开授权的照片），不占用户空间。
 */

const DIR = fileURLToPath(new URL('../../theme-photos/', import.meta.url))
export const THEME_PHOTO_PREFIX = 'tp_'

export interface ThemePhotoCredit { slug: string; unsplash_id: string; photographer: string; photographer_url: string; photo_url: string; credit: string; color: string | null }

let credits: ThemePhotoCredit[] | null = null
export function themePhotoCredits(): ThemePhotoCredit[] {
  credits ??= existsSync(`${DIR}attribution.json`) ? JSON.parse(readFileSync(`${DIR}attribution.json`, 'utf8')) as ThemePhotoCredit[] : []
  return credits
}

export const themePhotoId = (slug: string, variant: 'cover' | 'panel' | 'wash') => `${THEME_PHOTO_PREFIX}${slug}_${variant}`
export const isThemePhotoId = (id: unknown): id is string => typeof id === 'string' && /^tp_[a-z]+_(cover|panel|wash)$/.test(id)

const cache = new Map<string, Uint8Array>()
/** 内置照片的字节（id 不是内置照片或文件不在时为 null）。 */
export function themePhoto(id: string): { mime: string; bytes: Uint8Array } | null {
  if (!isThemePhotoId(id)) return null
  const [, slug, variant] = /^tp_([a-z]+)_(cover|panel|wash)$/.exec(id)!
  const file = `${DIR}${slug}-${variant}.jpg`
  if (!cache.has(id)) {
    if (!existsSync(file)) return null
    cache.set(id, new Uint8Array(readFileSync(file)))
  }
  return { mime: 'image/jpeg', bytes: cache.get(id)! }
}

/** 照片的署名（按模板） */
export const themePhotoCredit = (slug: string) => themePhotoCredits().find(c => c.slug === slug) ?? null
