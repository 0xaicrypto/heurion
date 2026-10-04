import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { emu } from '../model/deck-schema.ts'
import { LAYOUTS, layoutSpec } from '../model/deck-templates.ts'
import { DECK_THEMES, DEFAULT_THEME, resolveColor, type DeckTheme } from '../model/deck-themes.ts'

/**
 * 平台新建 deck 用的 pptx 模板（16:9）：一个母版、8 个版式（deck-templates.ts，封面 / 标题和内容 / 空白 / 章节页 / 两栏 / 图文 / 大数字 / 致谢）、
 * 一套主题（配色与中文字体按所选模板）。只包含 PowerPoint 与 LibreOffice 打开所必需的部件。
 */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CX = 12192000
const CY = 6858000

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`
const rels = (items: Array<[string, string, string]>) =>
  xml(`<Relationships xmlns="${RELS_NS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`)

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

function ph(id: number, name: string, type: string | null, idx: number | null, x: number, y: number, w: number, h: number, body = '<a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p>'): string {
  const phTag = `<p:ph${type ? ` type="${type}"` : ''}${idx !== null ? ` idx="${idx}"` : ''}/>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phTag}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${body}</p:txBody></p:sp>`
}

const TITLE_BOX: [number, number, number, number] = [838200, 365125, 10515600, 1325563]
const BODY_BOX: [number, number, number, number] = [838200, 1825625, 10515600, 4351338]
const srgb = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

function master(t: DeckTheme): string {
  // 背景与文字颜色直接写色值：PowerPoint 里新建的页也是这套模板的配色
  return xml(`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr>${srgb(t.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${ph(2, 'Title Placeholder 1', 'title', null, ...TITLE_BOX)}${ph(3, 'Text Placeholder 2', 'body', 1, ...BODY_BOX)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${LAYOUTS.map(l => `<p:sldLayoutId id="${2147483648 + l.n}" r:id="rId${l.n}"/>`).join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1">${srgb(t.title)}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${[1, 2, 3, 4, 5].map(l => `<a:lvl${l}pPr marL="${228600 + (l - 1) * 457200}" indent="-228600"><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${l % 2 ? '•' : '–'}"/><a:defRPr sz="${[2800, 2400, 2000, 1800, 1800][l - 1]}">${srgb(t.body)}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl${l}pPr>`).join('')}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`)
}

const layout = (name: string, type: string, shapes: string) =>
  xml(`<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)

const PH_NAME: Record<string, string> = { ctrTitle: 'Title', title: 'Title', subTitle: 'Subtitle', body: 'Content Placeholder', pic: 'Picture Placeholder' }

/** 版式部件：占位符按模板几何，文字样式（字号、粗细、颜色、对齐、项目符号）写进 lstStyle。 */
function layoutXml(def: (typeof LAYOUTS)[number], themeKey: string): string {
  const shapes = layoutSpec(themeKey, def.key).map((s, i) => {
    const [x, y, w, h] = s.box.map(emu) as [number, number, number, number]
    const bu = s.bullets ? '' : '<a:buNone/>'
    const marg = s.bullets ? '' : ' marL="0" indent="0"'
    const body = `<a:bodyPr anchor="t"/><a:lstStyle><a:lvl1pPr${marg} algn="${s.align}">${bu}<a:defRPr sz="${s.size * 100}" b="${s.bold ? 1 : 0}">${srgb(resolveColor(s.color, themeKey)!)}</a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="zh-CN"/></a:p>`
    return ph(i + 2, `${PH_NAME[s.type] ?? 'Placeholder'} ${i + 1}`, s.type === 'body' ? null : s.type, s.idx === null ? null : Number(s.idx), x, y, w, h, body)
  }).join('')
  return layout(def.name, def.type, shapes)
}

function themeXml(t: DeckTheme): string {
  return xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Heurion"><a:themeElements>
<a:clrScheme name="Heurion"><a:dk1><a:srgbClr val="${t.title}"/></a:dk1><a:lt1><a:srgbClr val="${t.bg}"/></a:lt1><a:dk2><a:srgbClr val="${t.body}"/></a:dk2><a:lt2><a:srgbClr val="${t.surface}"/></a:lt2><a:accent1><a:srgbClr val="${t.accent}"/></a:accent1><a:accent2><a:srgbClr val="${t.accent2}"/></a:accent2><a:accent3><a:srgbClr val="7C3AED"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="16A34A"/></a:accent6><a:hlink><a:srgbClr val="${t.accent}"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Heurion"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="${t.titleFont}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="${t.bodyFont}"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Heurion"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`)
}

/** 平台模板生成的包（主题名 Heurion）：换模板时整包按新模板重新生成；导入的 pptx 不是。 */
export function isPlatformPackage(pkg: Uint8Array | null | undefined): boolean {
  if (!pkg) return false
  try {
    const theme = unzipSync(pkg, { filter: f => f.name === 'ppt/theme/theme1.xml' })['ppt/theme/theme1.xml']
    return !!theme && /<a:theme\b[^>]*\bname="Heurion"/.test(strFromU8(theme))
  } catch { return false }
}

/** 生成模板（不含幻灯片；导出时按模型新增）：一个母版、8 个版式、一套主题配色与字体。 */
export function pptxTemplate(themeKey: string = DEFAULT_THEME): Uint8Array {
  const key = DECK_THEMES[themeKey] ? themeKey : DEFAULT_THEME
  const t = DECK_THEMES[key]!
  const files: Record<string, string> = {
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>${LAYOUTS.map(l => `<Override PartName="/ppt/slideLayouts/slideLayout${l.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': xml(`<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst/><p:sldSz cx="${CX}" cy="${CY}"/><p:notesSz cx="${CY}" cy="${CX}"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': master(t),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      ...LAYOUTS.map(l => [`rId${l.n}`, 'slideLayout', `../slideLayouts/slideLayout${l.n}.xml`] as [string, string, string]),
      [`rId${LAYOUTS.length + 1}`, 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/theme/theme1.xml': themeXml(t),
  }
  for (const l of LAYOUTS) {
    files[`ppt/slideLayouts/slideLayout${l.n}.xml`] = layoutXml(l, key)
    files[`ppt/slideLayouts/_rels/slideLayout${l.n}.xml.rels`] = rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}
