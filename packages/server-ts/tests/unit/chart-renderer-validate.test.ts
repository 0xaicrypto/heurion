import { describe, test, expect } from 'vitest'
import { renderSvgChart } from '../../src/tools/chart-renderer.js'

/**
 * #981 — chart-renderer 注入面收口回归:
 *  - renderSvgChart 入口运行时校验(非数值/NaN 输入拒绝,不拼进 SVG)
 *  - 文本内插(label/title/sig.p/elements.text)全部 esc
 *  - schematic 颜色白名单形态,引号/尖括号注入不逃逸属性
 */

const PAYLOADS = ['<img src=x onerror=a>', '" onload="a', '<script>a</script>', '</text><rect x=1>']

describe('#981 renderSvgChart 运行时校验(非法形状拒绝)', () => {
  test('data.value 为字符串 → 抛错拒绝(数值语义,不内插)', () => {
    expect(() => renderSvgChart({
      type: 'bar',
      data: [{ label: 'x', value: '5' as unknown as number }],
    })).toThrow(/invalid chart input/)
  })

  test('data.value 为 NaN/Infinity → finite 校验拒绝', () => {
    expect(() => renderSvgChart({
      type: 'line',
      data: [{ label: 'x', value: Number.NaN }],
    })).toThrow(/invalid chart input/)
    expect(() => renderSvgChart({
      type: 'line',
      data: [{ label: 'x', value: Number.POSITIVE_INFINITY }],
    })).toThrow(/invalid chart input/)
  })

  test('elements 坐标非数字 → 拒绝;越形 kind → 拒绝', () => {
    expect(() => renderSvgChart({
      type: 'schematic',
      elements: [{ kind: 'rect', x: '" y="0' as unknown as number, y: 0 }],
    })).toThrow(/invalid chart input/)
    expect(() => renderSvgChart({
      type: 'schematic',
      elements: [{ kind: 'script' as never, x: 0, y: 0 }],
    })).toThrow(/invalid chart input/)
  })
})

describe('#981 文本内插全部转义(模型可控输入不逃逸 SVG)', () => {
  test('bar: label/title/sig.p 含 <>&" → 输出无未转义注入形态', () => {
    const svg = renderSvgChart({
      type: 'bar',
      data: [
        { label: '<img src=x onerror=a>', value: 5 },
        { label: 'ok', value: 3 },
      ],
      title: '"<b>bold</b>&ok',
      sig: { pair: ['<img src=x onerror=a>', 'ok'], stars: '*', p: '"<p>&' },
      errors: [{ label: '<img src=x>', error: 1 }],
    })
    // 恶意载荷不得以未转义形态出现
    expect(svg).not.toContain('<img')
    expect(svg).not.toContain('<b>')
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('"<p>')
    // 转义形态存在
    expect(svg).toContain('&lt;img')
    expect(svg).toContain('&lt;b&gt;')
    // 柱顶数值标签 = 数字(经 esc 后仍是数字字符串)
    expect(svg).toMatch(/>5</)
  })

  test('schematic elements: text 转义 + 恶意 color 回退默认色', () => {
    const svg = renderSvgChart({
      type: 'schematic',
      elements: [
        { kind: 'rect', x: 10, y: 10, text: '<img src=x>' },
        { kind: 'rect', x: 20, y: 20, color: 'red" onload="alert(1)' },
      ],
      description: '<desc>&"',
    })
    expect(svg).not.toContain('<img')
    expect(svg).not.toContain('onload')
    expect(svg).not.toContain('<desc')
    expect(svg).toContain('&lt;desc&gt;')
    // 合法 hex 颜色保持透传
    const withHex = renderSvgChart({
      type: 'schematic',
      elements: [{ kind: 'rect', x: 1, y: 1, color: '#ff0000' }],
    })
    expect(withHex).toContain('#ff0000')
  })

  test('合法输入仍正常渲染(smoke):bar/dose_curve/schematic', () => {
    expect(renderSvgChart({ type: 'bar', data: [{ label: 'A', value: 1 }] })).toContain('<svg')
    expect(renderSvgChart({ type: 'dose_curve' })).toContain('<svg')
    expect(renderSvgChart({ type: 'schematic', template: 'beam_scan' })).toContain('<svg')
  })
})
