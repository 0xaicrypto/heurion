import { DECK_THEMES, DEFAULT_THEME, resolveColor, type DeckTheme } from './deck-themes.ts'
import { emu } from './deck-schema.ts'
import { baseOf, isOrgThemeKey, orgLogoId, orgMeta, themeKeysFor } from './org-templates.ts'
import { themePhotoCredit, themePhotoId } from './theme-photos.ts'

/**
 * deck 完整模板：deck-themes.ts 的配色字体 + 这里的版式几何与装饰。
 *
 * - 版式：平台新建的 deck 都有同一组 8 个版式（封面、标题和内容、空白、章节页、两栏、图文、大数字、致谢），
 *   pptx 里的部件编号固定（slideLayout1…8），换模板不改部件，只改占位符位置与配色。
 *   1–3 号与早期平台模板（Title Slide / Title and Content / Blank）一一对应，旧 deck 直接沿用。
 * - 装饰：色条、角块、圆形、细线等，作为页上的形状存在（查看器、导出、AI 读到的一致），名字以 deco: 开头；
 *   换模板时整体删掉重加，用户自己加的形状不受影响。装饰不能改字，可以删除。
 * - 带图模板（主题带 photo）：封面 / 致谢铺全幅照片（已压暗，白字），章节页铺很淡的全幅照片（与底色混合，深色字照常可读）；照片也是装饰（kind=image，
 *   引用内置资产 tp_<模板>_cover / _wash），换模板一样整体替换。
 * - 机构模板（org_<id>，见 org-templates.ts）：版式与装饰沿用一套内置模板，配色换成机构标准色，
 *   再加机构装饰：封面 / 章节页 / 致谢的院徽，内容页页脚的主色细线 + 机构名称 + 小院徽（没上传院徽时不放）。
 * 坐标单位 pt，页面 960×540（16:9）。
 */

export type LayoutKey = 'cover' | 'content' | 'blank' | 'section' | 'two_col' | 'image_text' | 'big_number' | 'closing'

export interface LayoutDef {
  key: LayoutKey
  name: string
  /** pptx 版式部件序号（ppt/slideLayouts/slideLayoutN.xml）。 */
  n: number
  /** p:sldLayout 的 type。 */
  type: string
  /** 别名（旧版式名、英文名），add_slide 的 layout 参数也认。 */
  aliases: string[]
  /** 给 AI / 选择器看的用途说明。 */
  hint: string
}

export const LAYOUTS: LayoutDef[] = [
  { key: 'cover', name: '封面', n: 1, type: 'title', aliases: ['Title Slide', '标题幻灯片', 'cover'], hint: '标题 + 副标题（汇报人、单位、日期）' },
  { key: 'content', name: '标题和内容', n: 2, type: 'obj', aliases: ['Title and Content', 'content'], hint: '标题 + 要点列表' },
  { key: 'blank', name: '空白', n: 3, type: 'blank', aliases: ['Blank', 'blank'], hint: '只有背景，自由排版' },
  { key: 'section', name: '章节页', n: 4, type: 'secHead', aliases: ['Section Header', 'section'], hint: '章节标题 + 一句说明' },
  { key: 'two_col', name: '两栏', n: 5, type: 'twoObj', aliases: ['Two Content', 'two columns', 'two_col'], hint: '标题 + 左右两栏（body 左栏，body2 右栏），适合对比' },
  { key: 'image_text', name: '图文', n: 6, type: 'picTx', aliases: ['Picture with Caption', 'image_text'], hint: '左侧图片区 + 右侧标题与说明（body）；图片用 add_image 放进图片区' },
  { key: 'big_number', name: '大数字', n: 7, type: 'cust', aliases: ['Big Number', 'big_number'], hint: '标题 + 一个醒目的数字或结论（body）+ 说明（body2）' },
  { key: 'closing', name: '致谢', n: 8, type: 'cust', aliases: ['Closing', 'Thanks', 'closing', '结束'], hint: '结束语 + 联系方式 / 问答提示' },
]

export const layoutDef = (key: LayoutKey): LayoutDef => LAYOUTS.find(l => l.key === key)!

/** 版式名（含旧名、英文名）→ 版式。 */
export function layoutByName(name: string | null | undefined): LayoutDef | null {
  if (!name) return null
  const n = name.trim().toLowerCase()
  return LAYOUTS.find(l => l.name.toLowerCase() === n || l.aliases.some(a => a.toLowerCase() === n)) ?? null
}

export type ColorToken = 'title' | 'body' | 'muted' | 'accent' | 'accent2'

export interface PhSpec {
  /** 占位符类型（ctrTitle / title / subTitle / body / pic）与 idx。 */
  type: string
  idx: string | null
  /** 中文角色（slide_read、选择器里显示）。 */
  role: string
  box: [number, number, number, number]
  size: number
  bold: boolean
  /** 主题记号；压在照片上的文字用固定的白 / 浅灰。 */
  color: ColorToken | 'FFFFFF' | 'E5E7EB'
  align: 'l' | 'ctr'
  bullets: boolean
  /** add_slide 的哪个参数填进来。 */
  fill?: 'title' | 'body' | 'body2'
}

type Box = [number, number, number, number]
type Boxes = Partial<Record<string, Box>>

/** 各模板对版式几何的调整（为装饰色块让位）。键：`版式.占位符角色`。 */
const BOX_OVERRIDES: Record<string, Boxes> = {
  clinical: { 'section.title': [80, 190, 520, 110], 'section.body': [80, 310, 520, 70] },
  warm: { 'section.title': [80, 190, 420, 110], 'section.body': [80, 310, 420, 70] },
  graphite: { 'section.title': [80, 190, 480, 110], 'section.body': [80, 310, 480, 70] },
  swiss: { 'section.title': [80, 190, 480, 110], 'section.body': [80, 310, 480, 70], 'cover.title': [80, 200, 800, 110], 'closing.title': [80, 200, 800, 110] },
  ...Object.fromEntries(['lab', 'micro', 'mist', 'dusk', 'library'].map(k => [k, {
    'cover.title': [80, 190, 640, 120], 'cover.subtitle': [80, 320, 600, 70],
    'closing.title': [80, 190, 640, 110], 'closing.body': [80, 310, 600, 70],
    'section.title': [80, 190, 420, 110], 'section.body': [80, 310, 420, 70],
  } as Boxes])),
  coral: {
    'cover.title': [80, 170, 470, 130], 'cover.subtitle': [80, 316, 450, 70],
    'closing.title': [80, 190, 480, 110], 'closing.body': [80, 310, 480, 70],
    'section.title': [360, 190, 520, 110], 'section.body': [360, 310, 520, 70],
    'content.title': [60, 40, 830, 70], 'content.body': [60, 130, 830, 360],
    'two_col.right': [482, 130, 408, 360],
  },
}

/** 版式的占位符（按模板）。带图模板的封面 / 致谢：文字压在压暗的照片上，用白字。 */
export function layoutSpec(themeKey: string | null | undefined, key: LayoutKey): PhSpec[] {
  const specs = baseLayoutSpec(themeKey, key)
  if (!themeOf(themeKey).photo || (key !== 'cover' && key !== 'closing')) return specs
  return specs.map(s => ({ ...s, color: s.color === 'title' ? 'FFFFFF' : 'E5E7EB' }))
}

function baseLayoutSpec(themeKey: string | null | undefined, key: LayoutKey): PhSpec[] {
  const theme = themeOf(themeKey)
  const key_ = DECK_THEMES[themeKey ?? ''] ? themeKey! : DEFAULT_THEME
  const center = theme.frame === 'center'
  const o = BOX_OVERRIDES[baseOf(key_)] ?? {}
  const box = (role: string, def: Box): Box => o[`${key}.${role}`] ?? def
  const feature = center ? 'ctr' : 'l'
  const title = (b: Box, size = 32): PhSpec => ({ type: 'title', idx: null, role: '标题', box: box('title', b), size, bold: true, color: 'title', align: 'l', bullets: false, fill: 'title' })
  switch (key) {
    case 'cover': return [
      { type: 'ctrTitle', idx: null, role: '标题', box: box('title', [80, 180, 800, 120]), size: 44, bold: true, color: 'title', align: feature, bullets: false, fill: 'title' },
      { type: 'subTitle', idx: '1', role: '副标题', box: box('subtitle', [80, 316, 800, 70]), size: 20, bold: false, color: 'muted', align: feature, bullets: false, fill: 'body' },
    ]
    case 'content': return [title([60, 40, 840, 70]), { type: 'body', idx: '1', role: '正文', box: box('body', [60, 130, 840, 360]), size: 22, bold: false, color: 'body', align: 'l', bullets: true, fill: 'body' }]
    case 'blank': return []
    case 'section': return [
      { ...title([80, 190, 800, 110], 40), align: feature },
      { type: 'body', idx: '1', role: '说明', box: box('body', [80, 310, 800, 70]), size: 20, bold: false, color: 'muted', align: feature, bullets: false, fill: 'body' },
    ]
    case 'two_col': return [
      title([60, 40, 840, 70]),
      { type: 'body', idx: '1', role: '左栏', box: box('left', [60, 130, 408, 360]), size: 20, bold: false, color: 'body', align: 'l', bullets: true, fill: 'body' },
      { type: 'body', idx: '2', role: '右栏', box: box('right', [492, 130, 408, 360]), size: 20, bold: false, color: 'body', align: 'l', bullets: true, fill: 'body2' },
    ]
    case 'image_text': return [
      { type: 'pic', idx: '1', role: '图片区', box: box('picture', [60, 60, 420, 420]), size: 18, bold: false, color: 'body', align: 'l', bullets: false },
      title([520, 70, 380, 90], 28),
      { type: 'body', idx: '2', role: '说明', box: box('body', [520, 176, 380, 300]), size: 18, bold: false, color: 'body', align: 'l', bullets: true, fill: 'body' },
    ]
    case 'big_number': return [
      { ...title([60, 40, 840, 70], 28), align: feature },
      { type: 'body', idx: '1', role: '数字', box: box('number', [60, 140, 840, 170]), size: 96, bold: true, color: 'accent', align: feature, bullets: false, fill: 'body' },
      { type: 'body', idx: '2', role: '说明', box: box('caption', [60, 330, 840, 120]), size: 22, bold: false, color: 'body', align: feature, bullets: false, fill: 'body2' },
    ]
    case 'closing': return [
      { ...title([80, 190, 800, 110], 48), align: feature },
      { type: 'body', idx: '1', role: '联系方式', box: box('body', [80, 310, 800, 70]), size: 20, bold: false, color: 'muted', align: feature, bullets: false, fill: 'body' },
    ]
  }
}

/** 页上的一个占位符对应的规格（按类型 + idx 找；标题类互认）。 */
export function phSpecOf(specs: PhSpec[], ph: string | null, idx: string | null): PhSpec | null {
  if (!ph) return null
  const isTitle = (t: string) => t === 'title' || t === 'ctrTitle'
  return specs.find(s => s.type === ph && (s.idx ?? null) === (idx ?? null))
    ?? specs.find(s => isTitle(s.type) && isTitle(ph))
    ?? specs.find(s => s.type === ph && s.type !== 'body')
    ?? null
}

export interface Deco {
  name: string; box: Box; fill: string; geom: 'rect' | 'roundRect' | 'ellipse'
  /** 照片装饰：内置资产 id（tp_<模板>_cover / _panel；机构院徽 ol_<模板 id>）与署名 / 说明 */
  image?: string
  credit?: string
  /** 文字装饰（机构模板页脚的机构名称）：不能改字，换模板时一起替换 */
  text?: { value: string; size: number; color: string; align: 'l' | 'r' }
}

type DecoToken = 'accent' | 'accent2' | 'soft' | 'surface' | 'title' | 'photo:cover' | 'photo:panel' | 'photo:wash'
type D = [string, Box, DecoToken, Deco['geom']?]

/** 每套模板的装饰（按版式）。 */
/** 带图模板共用的装饰：封面 / 致谢全幅照片，章节页很淡的全幅照片，内页顶部一道主色细条。 */
const photoDecos = (key: LayoutKey): D[] => {
  if (key === 'cover' || key === 'closing') return [['photo', [0, 0, 960, 540], 'photo:cover'], ['rule', [80, 168, 64, 5], 'accent']]
  if (key === 'section') return [['photo', [0, 0, 960, 540], 'photo:wash'], ['rule', [80, 168, 56, 5], 'accent']]
  if (key === 'blank' || key === 'image_text') return [['band', [0, 0, 960, 6], 'accent']]
  return [['band', [0, 0, 960, 6], 'accent'], ['rule', [key === 'big_number' ? 60 : 60, 112, 48, 4], 'accent']]
}

const DECOS: Record<string, (key: LayoutKey) => D[]> = {
  lab: photoDecos, micro: photoDecos, mist: photoDecos, dusk: photoDecos, library: photoDecos,
  clinical: key => {
    if (key === 'cover' || key === 'closing') return [['band', [0, 0, 24, 540], 'accent'], ['rule', [80, 404, 96, 5], 'accent2']]
    if (key === 'section') return [['panel', [640, 0, 320, 540], 'soft'], ['band', [0, 0, 24, 540], 'accent']]
    if (key === 'blank') return [['top', [0, 0, 960, 6], 'accent']]
    return [['top', [0, 0, 960, 6], 'accent'], ...(key === 'image_text' ? [] : [['rule', [60, 112, 56, 4], 'accent2']] as D[])]
  },
  teal: key => {
    if (key === 'cover' || key === 'closing') return [['circle', [640, 250, 480, 480], 'soft', 'ellipse'], ['dot', [850, 130, 56, 56], 'accent', 'ellipse']]
    if (key === 'section') return [['circle', [600, 150, 520, 520], 'soft', 'ellipse']]
    if (key === 'blank') return [['footer', [60, 500, 840, 2], 'accent2']]
    return [['footer', [60, 500, 840, 2], 'accent2'], ...(key === 'image_text' ? [] : [['marker', [40, 58, 6, 34], 'accent']] as D[])]
  },
  midnight: key => {
    if (key === 'cover' || key === 'closing' || key === 'section') return [['orb', [620, -120, 520, 520], 'surface', 'ellipse'], ['bar', [80, 300, 64, 5], 'accent2']]
    if (key === 'image_text') return [['line', [520, 166, 60, 3], 'accent']]
    if (key === 'blank') return []
    return [['line', [60, 112, 840, 2], 'accent']]
  },
  warm: key => {
    const strip: D = ['strip', [0, 0, 14, 540], 'accent']
    if (key === 'cover' || key === 'closing') return [['band', [0, 460, 960, 80], 'soft'], strip]
    if (key === 'section') return [['panel', [540, 0, 420, 540], 'soft'], strip]
    if (key === 'blank' || key === 'image_text') return [strip]
    return [strip, ['rule', [60, 112, 40, 3], 'accent2']]
  },
  paper: key => {
    if (key === 'cover' || key === 'closing' || key === 'section') return [['rule', [440, 302, 80, 3], 'accent']]
    if (key === 'blank' || key === 'image_text') return []
    if (key === 'big_number') return [['rule', [440, 112, 80, 3], 'accent']]
    return [['rule', [60, 112, 32, 3], 'accent']]
  },
  graphite: key => {
    if (key === 'cover' || key === 'closing') return [['footer', [0, 500, 960, 40], 'surface'], ['bar', [80, 300, 56, 6], 'accent']]
    if (key === 'section') return [['panel', [600, 0, 360, 540], 'surface'], ['bar', [80, 300, 56, 6], 'accent']]
    if (key === 'blank' || key === 'image_text') return []
    return [['bar', [60, 26, 28, 5], 'accent']]
  },
  swiss: key => {
    if (key === 'cover' || key === 'closing') return [['square', [80, 72, 96, 96], 'accent'], ['rule', [80, 404, 800, 6], 'title']]
    if (key === 'section') return [['block', [600, 0, 360, 540], 'accent'], ['rule', [80, 404, 440, 6], 'title']]
    if (key === 'image_text') return [['rule', [520, 28, 380, 5], 'title']]
    if (key === 'blank') return []
    return [['rule', [60, 28, 840, 5], 'title'], ['tick', [60, 28, 80, 5], 'accent']]
  },
  mint: key => {
    if (key === 'cover' || key === 'closing') return [['blob1', [-90, -90, 260, 260], 'soft', 'ellipse'], ['blob2', [760, 360, 280, 280], 'soft', 'ellipse'], ['dot', [740, 340, 48, 48], 'accent', 'ellipse']]
    if (key === 'section') return [['blob1', [-120, 300, 360, 360], 'soft', 'ellipse'], ['blob2', [800, -80, 240, 240], 'soft', 'ellipse']]
    if (key === 'blank' || key === 'image_text') return [['blob', [860, 440, 180, 180], 'soft', 'ellipse']]
    return [['blob', [860, 440, 180, 180], 'soft', 'ellipse'], ['pill', [key === 'big_number' ? 450 : 60, 112, 60, 6], 'accent', 'roundRect']]
  },
  coral: key => {
    if (key === 'cover' || key === 'closing') return [['block', [600, 0, 360, 540], 'accent'], ['dot', [548, 404, 104, 104], 'accent2', 'ellipse']]
    if (key === 'section') return [['block', [0, 0, 300, 540], 'accent']]
    if (key === 'blank') return [['edge', [930, 0, 30, 540], 'accent']]
    if (key === 'image_text') return [['edge', [930, 0, 30, 540], 'accent']]
    return [['edge', [930, 0, 30, 540], 'accent'], ['rule', [60, 112, 64, 6], 'accent']]
  },
}

export const DECO_PREFIX = 'deco:'
export const isDecoName = (name: unknown) => typeof name === 'string' && name.startsWith(DECO_PREFIX)

/** 一页的装饰（含图文版式的图片区底色），颜色已换成色值。 */
export function decorations(themeKey: string | null | undefined, key: LayoutKey): Deco[] {
  const k = DECK_THEMES[themeKey ?? ''] ? themeKey! : DEFAULT_THEME
  const base = baseOf(k)
  const theme = themeOf(k)
  const out: Deco[] = []
  if (key === 'image_text') {
    const pic = layoutSpec(k, key).find(s => s.type === 'pic')!
    out.push({ name: `${DECO_PREFIX}${k}:picture`, box: pic.box, fill: theme.soft, geom: base === 'mint' ? 'roundRect' : 'rect' })
  }
  for (const [name, box, token, geom] of DECOS[base]?.(key) ?? []) {
    if (token === 'photo:cover' || token === 'photo:panel' || token === 'photo:wash') {
      const slug = theme.photo!
      out.push({ name: `${DECO_PREFIX}${k}:${name}`, box, fill: 'none', geom: 'rect', image: themePhotoId(slug, token === 'photo:cover' ? 'cover' : token === 'photo:wash' ? 'wash' : 'panel'), credit: themePhotoCredit(slug)?.credit ?? 'Photo on Unsplash' })
      continue
    }
    out.push({ name: `${DECO_PREFIX}${k}:${name}`, box, fill: resolveColor(token, k)!, geom: geom ?? 'rect' })
  }
  if (isOrgThemeKey(k)) out.push(...orgDecorations(k, key))
  return out
}

/**
 * 机构装饰：封面 / 致谢右上角院徽（高 72pt），章节页右上角院徽（高 56pt）；
 * 其余版式页脚一条主色细线 + 机构名称 + 右下小院徽（高 22pt）。院徽按原图比例，最宽 260pt。
 */
function orgDecorations(k: string, key: LayoutKey): Deco[] {
  const m = orgMeta(k)
  if (!m) return []
  const t = themeOf(k)
  const out: Deco[] = []
  const logo = (name: string, h: number, right: number, y: number) => {
    if (!m.logo) return
    const w = Math.min(260, Math.round(h * m.logo.width / Math.max(1, m.logo.height)))
    out.push({ name: `${DECO_PREFIX}${k}:${name}`, box: [right - w, y, w, h], fill: 'none', geom: 'rect', image: orgLogoId(m.id), credit: `${m.org_name}院徽` })
  }
  if (key === 'cover' || key === 'closing') { logo('logo', 72, 904, 40); return out }
  if (key === 'section') { logo('logo', 56, 904, 40); return out }
  out.push({ name: `${DECO_PREFIX}${k}:footer-rule`, box: [60, 504, 840, 1.5], fill: t.title, geom: 'rect' })
  if (m.footer || m.org_name) out.push({ name: `${DECO_PREFIX}${k}:footer-name`, box: [60, 510, 620, 22], fill: 'none', geom: 'rect', text: { value: m.footer || m.org_name, size: 10, color: t.muted, align: 'l' } })
  logo('footer-logo', 22, 900, 510)
  return out
}

export function themeOf(key: string | null | undefined): DeckTheme {
  return DECK_THEMES[key ?? ''] ?? DECK_THEMES[DEFAULT_THEME]!
}

/** 平台模板 deck 的版式（LayoutInfo 形状，几何 EMU）。 */
export function templateLayouts(themeKey: string | null | undefined): Array<{ name: string; part: string; key: LayoutKey; hint: string; placeholders: Array<{ type: string; idx: string | null; x: number; y: number; w: number; h: number }> }> {
  return LAYOUTS.map(l => ({
    name: l.name, part: `ppt/slideLayouts/slideLayout${l.n}.xml`, key: l.key, hint: l.hint,
    placeholders: layoutSpec(themeKey, l.key).map(s => ({ type: s.type, idx: s.idx, x: emu(s.box[0]), y: emu(s.box[1]), w: emu(s.box[2]), h: emu(s.box[3]) })),
  }))
}

/** 模板清单（选择器、MCP 用）：配色、说明、每个版式的占位符与装饰（预览图按这些画）。按用户过滤：本机构模板在前，再是内置模板。 */
export function templateCatalog(userId: string | null = null) {
  return themeKeysFor(userId).map(key => [key, DECK_THEMES[key]!] as const).map(([key, t]) => ({
    key, ...t,
    ...(isOrgThemeKey(key) ? { org: true, org_name: orgMeta(key)?.org_name ?? '', base: baseOf(key) } : {}),
    layouts: LAYOUTS.map(l => ({
      key: l.key, name: l.name, hint: l.hint,
      placeholders: layoutSpec(key, l.key).map(s => ({ role: s.role, type: s.type, box: s.box, size: s.size, bold: s.bold, color: resolveColor(s.color, key), align: s.align })),
      decorations: decorations(key, l.key).map(d => ({ box: d.box, fill: d.fill, geom: d.geom, ...(d.image ? { image: d.image } : {}), ...(d.text ? { text: d.text } : {}) })),
    })),
    ...(t.photo ? { credit: themePhotoCredit(t.photo) } : {}),
  }))
}
