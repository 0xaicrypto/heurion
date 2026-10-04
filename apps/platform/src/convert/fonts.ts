import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/**
 * 导出字体按使用平台：模板与 Word 底座用的是 Windows 字体（微软雅黑 / 等线 / 宋体），Mac 上没有，
 * Keynote / Pages 会提示「缺少字体」并自行替换。选 Mac 时把这些字体名换成 Mac 自带的（苹方 / 宋体-简）。
 * 只改 XML 里字体属性的取值，其余内容原样。
 */
export type ExportFonts = 'win' | 'mac'

const TO_MAC: Record<string, string> = {
  'Microsoft YaHei': 'PingFang SC', '微软雅黑': 'PingFang SC',
  'DengXian': 'PingFang SC', '等线': 'PingFang SC', 'DengXian Light': 'PingFang SC', '等线 Light': 'PingFang SC',
  'SimHei': 'PingFang SC', '黑体': 'PingFang SC',
  'SimSun': 'Songti SC', '宋体': 'Songti SC', 'NSimSun': 'Songti SC', '新宋体': 'Songti SC',
  'KaiTi': 'Kaiti SC', '楷体': 'Kaiti SC', 'FangSong': 'STFangsong', '仿宋': 'STFangsong',
}
// pptx：typeface="…"；docx：w:ascii / w:hAnsi / w:eastAsia / w:cs="…"（以及 w:font w:name）
const ATTR = /\b(typeface|w:ascii|w:hAnsi|w:eastAsia|w:cs|w:name)="([^"]*)"/g

export function withFonts(bytes: Uint8Array, fonts: ExportFonts | undefined): Uint8Array {
  if (fonts !== 'mac') return bytes
  const files = unzipSync(bytes)
  let changed = false
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.xml')) continue
    const xml = strFromU8(data)
    const next = xml.replace(ATTR, (m, attr: string, value: string) => TO_MAC[value] ? `${attr}="${TO_MAC[value]}"` : m)
    if (next !== xml) { files[name] = strToU8(next); changed = true }
  }
  return changed ? zipSync(files) : bytes
}

export const exportFontsParam = (v: string | undefined): ExportFonts => v === 'mac' ? 'mac' : 'win'
