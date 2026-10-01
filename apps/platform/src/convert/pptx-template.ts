import { strToU8, zipSync } from 'fflate'

/**
 * 平台新建 deck 用的最小 pptx 模板（16:9）：一个母版、三个版式（标题页 / 标题和内容 / 空白）、
 * 一套主题（中文默认字体：微软雅黑 / 等线）。只包含 PowerPoint 与 LibreOffice 打开所必需的部件。
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
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phTag}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr><p:txBody>${body}</p:txBody></p:sp>`
}

const TITLE_BOX: [number, number, number, number] = [838200, 365125, 10515600, 1325563]
const BODY_BOX: [number, number, number, number] = [838200, 1825625, 10515600, 4351338]

const master = xml(`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${ph(2, 'Title Placeholder 1', 'title', null, ...TITLE_BOX)}${ph(3, 'Text Placeholder 2', 'body', 1, ...BODY_BOX)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${[1, 2, 3, 4, 5].map(l => `<a:lvl${l}pPr marL="${228600 + (l - 1) * 457200}" indent="-228600"><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${l % 2 ? '•' : '–'}"/><a:defRPr sz="${[2800, 2400, 2000, 1800, 1800][l - 1]}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl${l}pPr>`).join('')}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`)

const layout = (name: string, type: string, shapes: string) =>
  xml(`<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)

const theme = xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Heurion"><a:themeElements>
<a:clrScheme name="Heurion"><a:dk1><a:srgbClr val="1F2328"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0B2B45"/></a:dk2><a:lt2><a:srgbClr val="F2F4F7"/></a:lt2><a:accent1><a:srgbClr val="2F6FED"/></a:accent1><a:accent2><a:srgbClr val="148F8A"/></a:accent2><a:accent3><a:srgbClr val="7C3AED"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="16A34A"/></a:accent6><a:hlink><a:srgbClr val="2F6FED"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Heurion"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="DengXian"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Heurion"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`)

/** 生成模板（不含幻灯片；导出时按模型新增）。 */
export function pptxTemplate(): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>${[1, 2, 3].map(i => `<Override PartName="/ppt/slideLayouts/slideLayout${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': xml(`<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst/><p:sldSz cx="${CX}" cy="${CY}"/><p:notesSz cx="${CY}" cy="${CX}"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': master,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'slideLayout', '../slideLayouts/slideLayout2.xml'],
      ['rId3', 'slideLayout', '../slideLayouts/slideLayout3.xml'],
      ['rId4', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': layout('Title Slide', 'title',
      ph(2, 'Title 1', 'ctrTitle', null, 1524000, 1122363, 9144000, 2387600, '<a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="zh-CN"/></a:p>') +
      ph(3, 'Subtitle 2', 'subTitle', 1, 1524000, 3602038, 9144000, 1655762, '<a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="zh-CN"/></a:p>')),
    'ppt/slideLayouts/slideLayout2.xml': layout('Title and Content', 'obj',
      ph(2, 'Title 1', 'title', null, ...TITLE_BOX) + ph(3, 'Content Placeholder 2', null, 1, ...BODY_BOX)),
    'ppt/slideLayouts/slideLayout3.xml': layout('Blank', 'blank', ''),
    'ppt/theme/theme1.xml': theme,
  }
  for (const i of [1, 2, 3]) files[`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`] = rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}
