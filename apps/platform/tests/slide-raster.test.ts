import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templateSlide, newTemplateDeck } from '../src/ops/deck.ts'
import { renderSlideToSvg, renderSlideToPng, chartSvg } from '../src/render/slide-raster.ts'
import { SlideRenderer } from '../src/render/slides.ts'

describe('远端矢量光栅化与幻灯片渲染服务 (slide-raster & SlideRenderer)', () => {
  it('自闭环渲染封面页为标准 SVG 与高清 PNG', () => {
    const deck = newTemplateDeck('心衰临床研究报告', 'clinical')
    const slide = deck.firstChild!
    const size = { cx: 12192000, cy: 6858000 }

    const svg = renderSlideToSvg({ slide, size })
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 960 540"')
    expect(svg).toContain('心衰临床研究报告')

    const png = renderSlideToPng({ slide, size })
    expect(png).toBeInstanceOf(Uint8Array)
    expect(png.length).toBeGreaterThan(1000)
    // PNG 文件头校验: 89 50 4E 47
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50)
    expect(png[2]).toBe(0x4e)
    expect(png[3]).toBe(0x47)
  })

  it('XML 控制字符与危险字符安全性转义测试（防止 Resvg XML 解析崩溃）', () => {
    const deck = newTemplateDeck('测试<>&"\'\x00\x08危险字符', 'clinical')
    const slide = deck.firstChild!
    const size = { cx: 12192000, cy: 6858000 }

    const svg = renderSlideToSvg({ slide, size })
    expect(svg).not.toContain('\x00')
    expect(svg).not.toContain('\x08')
    expect(svg).toContain('&lt;&gt;&amp;&quot;&apos;')

    // 验证经过转义的 SVG 能顺利通过 Resvg 编译为 PNG，不抛出 XML 解析错误
    expect(() => renderSlideToPng({ slide, size })).not.toThrow()
  })

  it('图表渲染：柱状图、折线图、饼图与圆环图', () => {
    const pieSvg = chartSvg({
      type: 'pie',
      title: '患者构成比例',
      categories: ['男性', '女性'],
      series: [{ name: '占比', values: [60, 40] }],
    }, 400, 300)
    expect(pieSvg).toContain('<svg')
    expect(pieSvg).toContain('患者构成比例')
    expect(pieSvg).toContain('<path')

    const barSvg = chartSvg({
      type: 'bar',
      title: '各组血压水平',
      categories: ['基线', '治疗后'],
      series: [{ name: '收缩压', values: [140, 120] }],
    }, 400, 300)
    expect(barSvg).toContain('<rect')
    expect(barSvg).toContain('收缩压')
  })

  it('SlideRenderer 服务自闭环能力：诊断、内置降级与磁盘缓存', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slide-test-'))
    const renderer = new SlideRenderer(dir)

    expect(await renderer.available()).toBe(true)
    const diag = await renderer.diagnose()
    expect(diag.available).toBe(true)
    expect(['builtin', 'local', 'container']).toContain(diag.mode)

    const deck = newTemplateDeck('心衰临床研究报告', 'clinical')
    const pngs = await renderer.render('test-deck/0', {
      getDoc: () => deck,
      size: { cx: 12192000, cy: 6858000 },
    })

    expect(pngs.length).toBe(1)
    expect(pngs[0]).toMatch(/slide-1\.png$/)

    // 第二次调用命中内存或文件缓存
    const cached = await renderer.render('test-deck/0', {
      getDoc: () => deck,
    })
    expect(cached).toEqual(pngs)
  })
})
