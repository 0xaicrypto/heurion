import { describe, test, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { renderFigure, extractSvgSize, applySvgScale, figureUnavailableReason } from '../src/handlers/figure.js'

/**
 * #819 — render_figure 渲染器。
 *
 * 本机有 Chrome 时(开发/CI macOS runner)跑真实渲染:mermaid 中文图 +
 * LaTeX 公式 + 零外呼断言(request interception 只放行 file:/data:)。
 * 无 Chrome/资产时仅验证优雅降级路径(FIGURE_UNAVAILABLE)。
 */

const hasLocalSetup =
  fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  && fs.existsSync(path.join(process.cwd(), 'assets', 'figure', 'shell.html'))

afterAll(() => {
  // 浏览器单例清理(避免 vitest 进程挂住)。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  import('../src/handlers/figure.js').then((m) => m.resetFigureBrowserForTest())
})

describe.skipIf(!hasLocalSetup)('#819 real headless rendering', () => {
  test('renders Chinese mermaid flowchart to SVG', async () => {
    const result = await renderFigure({
      kind: 'mermaid',
      source: 'flowchart TD\n  A[患者入院] --> B{活检?}\n  B -->|阳性| C[确诊 NSCLC]\n  B -->|阴性| D[随访]',
    })
    expect(result.file_id).toBeTruthy()
    expect(result.file_name).toBe('figure.svg')
    expect(result.mime_type).toBe('image/svg+xml')
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  }, 30_000)

  test('renders LaTeX formula (inline + display) to SVG', async () => {
    const inline = await renderFigure({ kind: 'latex_math', source: 'e^{i\\pi} + 1 = 0' })
    expect(inline.file_id).toBeTruthy()
    const display = await renderFigure({ kind: 'latex_math', source: '\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}', display: true })
    expect(display.file_id).toBeTruthy()
  }, 30_000)

  test('mermaid parse error → structured error (not crash)', async () => {
    await expect(renderFigure({ kind: 'mermaid', source: 'flowchart TD\n  A[未闭合' })).rejects.toThrow(/FIGURE_FAILED|Error/i)
  }, 30_000)

  test('oversized source (>32KB) rejected by contract', async () => {
    await expect(renderFigure({ kind: 'mermaid', source: 'a'.repeat(33 * 1024) })).rejects.toThrow(/payload failed validation/)
  }, 30_000)
})

describe.skipIf(hasLocalSetup)('#819 graceful degradation', () => {
  test('no chromium/assets → FIGURE_UNAVAILABLE', async () => {
    expect(figureUnavailableReason()).toMatch(/FIGURE_UNAVAILABLE/)
    await expect(renderFigure({ kind: 'mermaid', source: 'graph TD; A-->B;' })).rejects.toThrow(/FIGURE_UNAVAILABLE/)
  })
})

describe('#819 svg helpers', () => {
  test('extractSvgSize prefers viewBox, falls back to width/height attrs', () => {
    expect(extractSvgSize('<svg viewBox="0 0 320.5 240.1"><g/></svg>')).toEqual({ width: 321, height: 240 })
    expect(extractSvgSize('<svg width="600.0" height="400.0"><g/></svg>')).toEqual({ width: 600, height: 400 })
    expect(extractSvgSize('<svg><g/></svg>')).toEqual({})
  })

  test('applySvgScale scales width/height keeping viewBox (vector lossless)', () => {
    const out = applySvgScale('<svg width="100.0px" height="50.0px" viewBox="0 0 100 50"></svg>', 2)
    expect(out).toContain('width="200.00px"')
    expect(out).toContain('height="100.00px"')
    expect(out).toContain('viewBox="0 0 100 50"')
  })
})
