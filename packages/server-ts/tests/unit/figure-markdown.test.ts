import { describe, test, expect, vi } from 'vitest'
import { scanFigures, resolveFiguresToImageLines } from '../../src/modules/figures/figure-markdown.js'

/**
 * #821 — 学术图抽取与解析(纯函数层):
 * - 扫描:mermaid 围栏 / $$ 块 / 单行 $$..$$ / 独立行 $..$;段内混排 $ 不抽;
 * - 解析:成功 → 托管图片行原位替换;失败 → 保留原行(降级不阻塞);
 * - 同源码去重:ensureFigure 只调一次。
 */

const SAMPLE = [
  '# 标题',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[入院] --> B[出院]',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '$\\int_0^1 x dx$',
  '',
  '这段话里有 $x$ 和金额 $50 不抽取。',
  '```js',
  'console.log("普通代码不抽取")',
  '```',
].join('\n')

describe('#821 scanFigures', () => {
  test('识别 mermaid 围栏/$$ 块/独立 inline;段内混排与普通代码不抽', () => {
    const { figures, count } = scanFigures(SAMPLE)
    expect(count).toBe(3)
    expect(figures).toHaveLength(3)
    expect(figures[0]).toEqual({ kind: 'mermaid', source: 'flowchart TD\n  A[入院] --> B[出院]' })
    expect(figures[1]).toEqual({ kind: 'latex_math', source: 'E = mc^2', display: true })
    expect(figures[2]).toEqual({ kind: 'latex_math', source: '\\int_0^1 x dx', display: false })
  })

  test('无学术图 → 空列表', () => {
    expect(scanFigures('# 标题\n\n普通段落。\n').figures).toHaveLength(0)
  })
})

describe('#821 resolveFiguresToImageLines', () => {
  const ok = (fileId: string) => async (_userId: string, input: any) =>
    ({ ok: true as const, file: { fileId: `${fileId}_${input.kind}` } })
  const fail = async () => ({ ok: false as const, reason: 'figure render timed out' })

  test('成功 → 源码行原位替换为托管图片行(其余行清空)', async () => {
    const body = '前文\n\n```mermaid\ngraph TD; A-->B;\n```\n\n后文'
    const out = await resolveFiguresToImageLines('u1', body, ok('fig_x'))
    const lines = out.split('\n')
    expect(lines[2]).toBe('![学术图](/api/v1/files/download/fig_x_mermaid)')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe('')
    expect(lines[6]).toBe('后文')
  })

  test('失败 → 保留原行(降级不阻塞导出)', async () => {
    const body = '前文\n\n$$\nE = mc^2\n$$\n\n后文'
    const out = await resolveFiguresToImageLines('u1', body, fail)
    expect(out).toBe(body)
  })

  test('混合:成功的替换,失败的原样保留', async () => {
    const body = '$$E=mc^2$$\n\n```mermaid\ngraph TD; A-->B;\n```'
    const ensure = vi.fn(async (_u: string, input: any) =>
      input.kind === 'latex_math'
        ? { ok: true as const, file: { fileId: 'fig_1' } }
        : { ok: false as const, reason: 'timeout' })
    const out = await resolveFiguresToImageLines('u1', body, ensure)
    expect(out.split('\n')[0]).toBe('![学术图](/api/v1/files/download/fig_1)')
    expect(out).toContain('```mermaid')
  })

  test('同源码多处出现 → ensureFigure 只调一次(去重)', async () => {
    const body = '$$a+b$$\n中段\n$$a+b$$'
    const ensure = vi.fn(ok('fig_d'))
    await resolveFiguresToImageLines('u1', body, ensure)
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  test('无学术图 → 原文原样返回(不触发 I/O)', async () => {
    const ensure = vi.fn(ok('x'))
    const body = '# 无图文档\n段落。'
    expect(await resolveFiguresToImageLines('u1', body, ensure)).toBe(body)
    expect(ensure).not.toHaveBeenCalled()
  })
})
