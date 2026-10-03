/**
 * deck 模板（主题）：一组配色与字体，加上 deck-templates.ts 里的装饰与版式几何。
 * apply_theme 把它落到每页的背景、标题与正文文字颜色上（模型里都是显式颜色，查看器、导出、AI 读到的都一致）；
 * 平台新建的 deck 同时换掉模板装饰、把继承版式位置的占位符挪到新模板的位置。
 * 导出时写进 pptx 主题的强调色与字体，PowerPoint 里新建的页也匹配。
 * 颜色参数可写主题记号（accent / accent2 / title / body / muted / bg / surface / soft），按该页所用主题换成色值。
 */
export interface DeckTheme {
  label: string
  description: string
  bg: string
  /** 卡片、色块底色。 */
  surface: string
  /** 装饰用的浅色（色块、圆形、图片区底色）。 */
  soft: string
  title: string
  body: string
  muted: string
  accent: string
  accent2: string
  titleFont: string
  bodyFont: string
  /** 封面、章节页、结束页的标题对齐：左对齐 / 居中。 */
  frame: 'left' | 'center'
  /** 标题用衬线（宋体类）字体。 */
  serif?: boolean
  /** 适合的场合（模板选择器里显示）。 */
  tags: string[]
}

const YAHEI = { titleFont: 'Microsoft YaHei', bodyFont: 'DengXian' }
const SONG = { titleFont: 'SimSun', bodyFont: 'DengXian', serif: true }

export const DECK_THEMES: Record<string, DeckTheme> = {
  clinical: { label: '临床蓝', description: '白底、墨蓝标题、天蓝强调，左侧色带，适合学术汇报', bg: 'FFFFFF', surface: 'F1F5F9', soft: 'E0F2FE', title: '0F172A', body: '334155', muted: '64748B', accent: '0EA5E9', accent2: '0284C7', ...YAHEI, frame: 'left', tags: ['学术汇报', '科室会'] },
  teal: { label: '学术青', description: '白底、深青衬线标题、角落大圆，适合文献解读', bg: 'FFFFFF', surface: 'F0FDFA', soft: 'CCFBF1', title: '134E4A', body: '1F2937', muted: '6B7280', accent: '14B8A6', accent2: '0F766E', ...SONG, frame: 'left', tags: ['文献解读', '期刊俱乐部'] },
  midnight: { label: '深夜蓝', description: '深蓝底、白字、亮蓝细线，适合大会报告', bg: '0B1F3A', surface: '13294B', soft: '163460', title: 'FFFFFF', body: 'E2E8F0', muted: '94A3B8', accent: '38BDF8', accent2: 'F59E0B', ...YAHEI, frame: 'left', tags: ['大会报告', '投影'] },
  warm: { label: '暖白', description: '米白底、深棕衬线标题、橙色侧边条，适合教学与科普', bg: 'FBF7F0', surface: 'F5EBDD', soft: 'F3E3CC', title: '7C2D12', body: '44403C', muted: '78716C', accent: 'EA580C', accent2: 'B45309', ...SONG, frame: 'left', tags: ['教学', '患者科普'] },
  paper: { label: '素白', description: '大量留白、居中标题、一道细线，内容优先', bg: 'FFFFFF', surface: 'F4F4F5', soft: 'EEF2FF', title: '18181B', body: '3F3F46', muted: '71717A', accent: '4F46E5', accent2: '18181B', ...YAHEI, frame: 'center', tags: ['通用', '论文答辩'] },
  graphite: { label: '石墨', description: '炭灰底、白字、翠绿短条，沉稳的深色', bg: '1C1D21', surface: '2A2C31', soft: '26282D', title: 'F4F4F5', body: 'D4D4D8', muted: '9CA3AF', accent: '34D399', accent2: 'FBBF24', ...YAHEI, frame: 'left', tags: ['学术汇报', '暗场投影'] },
  swiss: { label: '网格', description: '黑色粗线、红色方块、严格左对齐，信息密集也清楚', bg: 'FFFFFF', surface: 'F5F5F5', soft: 'F5F5F5', title: '111111', body: '262626', muted: '737373', accent: 'DC2626', accent2: '111111', ...YAHEI, frame: 'left', tags: ['数据汇报', '基金答辩'] },
  mint: { label: '薄荷', description: '浅绿底、圆润色块、柔和配色，轻松友好', bg: 'F3FAF6', surface: 'E3F4EA', soft: 'D3EEDD', title: '14532D', body: '1F3A2C', muted: '5B7B6A', accent: '22A06B', accent2: '0F766E', ...YAHEI, frame: 'center', tags: ['健康教育', '团队分享'] },
  coral: { label: '珊瑚', description: '珊瑚色大色块撞藏青文字，醒目有冲击力', bg: 'FFFFFF', surface: 'FFF1EC', soft: 'FFE4D9', title: '1E293B', body: '334155', muted: '64748B', accent: 'F0643C', accent2: '1E293B', ...YAHEI, frame: 'left', tags: ['项目路演', '宣讲'] },
}

export const DEFAULT_THEME = 'clinical'
export const THEME_TOKENS = ['accent', 'accent2', 'title', 'body', 'muted', 'bg', 'surface', 'soft'] as const

/** 颜色参数 → 6 位十六进制（大写）；'none' 原样返回；无效返回 null。 */
export function resolveColor(value: string, theme: string | null | undefined): string | null {
  const v = value.trim().replace(/^#/, '')
  if (v.toLowerCase() === 'none') return 'none'
  if (/^[0-9a-f]{6}$/i.test(v)) return v.toUpperCase()
  if (/^[0-9a-f]{3}$/i.test(v)) return v.split('').map(c => c + c).join('').toUpperCase()
  const t = DECK_THEMES[theme ?? DEFAULT_THEME] ?? DECK_THEMES[DEFAULT_THEME]!
  return (THEME_TOKENS as readonly string[]).includes(v) ? t[v as (typeof THEME_TOKENS)[number]] : null
}
