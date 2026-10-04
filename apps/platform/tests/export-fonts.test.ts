import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportFontsParam, withFonts } from '../src/convert/fonts.ts'

describe('导出字体（Mac / Windows）', () => {
  const pkg = () => zipSync({
    'ppt/theme/theme1.xml': strToU8('<a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:ea typeface="DengXian"/></a:minorFont><a:ea typeface="SimSun"/>'),
    'word/styles.xml': strToU8('<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:t>宋体 Microsoft YaHei 是正文</w:t>'),
    'ppt/media/a.png': new Uint8Array([1, 2, 3]),
  })
  it('Mac：字体属性换成苹方 / 宋体-简，正文文字与其他文件不动', () => {
    const files = unzipSync(withFonts(pkg(), 'mac'))
    const theme = strFromU8(files['ppt/theme/theme1.xml']!)
    expect(theme).toContain('typeface="PingFang SC"')
    expect(theme).toContain('typeface="Songti SC"')
    expect(theme).toContain('typeface="Arial"')
    expect(theme).not.toContain('Microsoft YaHei')
    const styles = strFromU8(files['word/styles.xml']!)
    expect(styles).toContain('w:eastAsia="Songti SC"')
    expect(styles).toContain('<w:t>宋体 Microsoft YaHei 是正文</w:t>')
    expect([...files['ppt/media/a.png']!]).toEqual([1, 2, 3])
  })
  it('Windows（默认）：原样返回', () => {
    const bytes = pkg()
    expect(withFonts(bytes, 'win')).toBe(bytes)
    expect(exportFontsParam(undefined)).toBe('win')
    expect(exportFontsParam('mac')).toBe('mac')
  })
})
