/**
 * deck 主题（C1）：一组配色与字体。apply_theme 把它落到每页的背景、标题与正文文字颜色上（模型里都是显式颜色，
 * 查看器、导出、AI 读到的都一致）；导出时同时写进 pptx 主题的强调色与字体，PowerPoint 里新建的页也匹配。
 * 颜色参数可写主题记号（accent / accent2 / title / body / muted / bg / surface），按该页所用主题换成色值。
 */
export interface DeckTheme {
  label: string
  description: string
  bg: string
  /** 卡片、色块底色。 */
  surface: string
  title: string
  body: string
  muted: string
  accent: string
  accent2: string
  titleFont: string
  bodyFont: string
}

export const DECK_THEMES: Record<string, DeckTheme> = {
  clinical: { label: '临床蓝', description: '白底、墨蓝标题、天蓝强调，适合学术汇报', bg: 'FFFFFF', surface: 'F1F5F9', title: '0F172A', body: '334155', muted: '64748B', accent: '0EA5E9', accent2: '0284C7', titleFont: 'Microsoft YaHei', bodyFont: 'DengXian' },
  teal: { label: '学术青', description: '白底、深青标题、青绿强调，适合文献解读', bg: 'FFFFFF', surface: 'F0FDFA', title: '134E4A', body: '1F2937', muted: '6B7280', accent: '14B8A6', accent2: '0F766E', titleFont: 'Microsoft YaHei', bodyFont: 'DengXian' },
  midnight: { label: '深夜蓝', description: '深蓝底、白字、亮蓝强调，适合大会报告', bg: '0B1F3A', surface: '13294B', title: 'FFFFFF', body: 'E2E8F0', muted: '94A3B8', accent: '38BDF8', accent2: 'F59E0B', titleFont: 'Microsoft YaHei', bodyFont: 'DengXian' },
  warm: { label: '暖白', description: '米白底、深棕标题、橙色强调，适合教学与科普', bg: 'FBF7F0', surface: 'F5EBDD', title: '7C2D12', body: '44403C', muted: '78716C', accent: 'EA580C', accent2: 'B45309', titleFont: 'Microsoft YaHei', bodyFont: 'DengXian' },
}

export const DEFAULT_THEME = 'clinical'
export const THEME_TOKENS = ['accent', 'accent2', 'title', 'body', 'muted', 'bg', 'surface'] as const

/** 颜色参数 → 6 位十六进制（大写）；'none' 原样返回；无效返回 null。 */
export function resolveColor(value: string, theme: string | null | undefined): string | null {
  const v = value.trim().replace(/^#/, '')
  if (v.toLowerCase() === 'none') return 'none'
  if (/^[0-9a-f]{6}$/i.test(v)) return v.toUpperCase()
  if (/^[0-9a-f]{3}$/i.test(v)) return v.split('').map(c => c + c).join('').toUpperCase()
  const t = DECK_THEMES[theme ?? DEFAULT_THEME] ?? DECK_THEMES[DEFAULT_THEME]!
  return (THEME_TOKENS as readonly string[]).includes(v) ? t[v as (typeof THEME_TOKENS)[number]] : null
}
