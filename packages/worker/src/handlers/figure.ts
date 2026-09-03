/**
 * #819 — sidecar.render_figure: mermaid 围栏 / LaTeX 公式 → SVG。
 *
 * 工程范式沿用 preview.ts(超时+临时目录+优雅降级),但 JS 类渲染依赖
 * DOM,改用进程内 headless Chromium(RENDER_BOUNDARY 铁律:位图/浏览器
 * 渲染归执行面,控制面零浏览器依赖)。设计: docs/design/ACADEMIC_FIGURE_RENDERING.md。
 *
 * 安全(设计 §5):
 * - shell.html 本地 bundle,file:// 加载;request interception 仅放行
 *   file:/data: — 零外呼(断网环境渲染可用,测试锁定)。
 * - mermaid securityLevel=strict + htmlLabels:false;MathJax 仅 tex→svg。
 * - 源码 ≤32KB(contracts zod);单图 10s 超时杀 page;browser 每 50 job
 *   回收(内存泄漏防护)。
 * - chromium 以 --no-sandbox 运行:容器内 root 无法启用 setuid sandbox
 *   (chromium 常规要求),网络面已由 interception 全拒绝 + worker 容器
 *   自身无外网依赖兜底。
 *
 * 优雅降级:镜像缺 chromium/资产时抛 FIGURE_UNAVAILABLE — 控制面映射为
 * 可识别降级(导出回退纯文本),不崩进程。
 */
import { existsSync } from 'fs'
import path from 'path'
import { figurePayloadSchema, type FigurePayload } from '@heurion/contracts'
import { saveFile } from '../storage.js'

const FIGURE_TIMEOUT_MS = 10_000
const BROWSER_RECYCLE_JOBS = 50

/** 容器/本机的 chromium 候选路径(依次探测)。 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH || '',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function resolveChromePath(): string | null {
  for (const p of CHROME_CANDIDATES) {
    try { if (existsSync(p)) return p } catch { /* probe next */ }
  }
  return null
}

function resolveAssetsDir(): string | null {
  const dir = process.env.FIGURE_ASSETS_DIR
    || path.join(process.cwd(), 'assets', 'figure')
  return existsSync(path.join(dir, 'shell.html')) ? dir : null
}

// ── browser singleton(有界回收) ────────────────────────────────

interface BrowserState {
  browser: any
  jobs: number
}
let browserState: BrowserState | null = null
let browserLaunch: Promise<any> | null = null

async function getBrowser(chromePath: string): Promise<any> {
  if (browserState) {
    browserState.jobs += 1
    if (browserState.jobs >= BROWSER_RECYCLE_JOBS) {
      const stale = browserState
      browserState = null
      browserLaunch = null
      // 回收是泄漏防护而非正确性路径 — 后台关闭,不阻塞当前渲染。
      void Promise.resolve(stale.browser.close()).catch(() => {})
    } else {
      return browserState.browser
    }
  }
  browserLaunch = browserLaunch || launchBrowser(chromePath)
  const browser = await browserLaunch
  browserState = { browser, jobs: 1 }
  return browser
}

async function launchBrowser(chromePath: string): Promise<any> {
  const puppeteer = await import('puppeteer-core')
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  })
}

/** 优雅降级探测 — 镜像未装 chromium/资产时给控制面可识别错误码。 */
export function figureUnavailableReason(): string | null {
  if (!resolveChromePath()) return 'FIGURE_UNAVAILABLE: headless chromium is required for figure rendering'
  if (!resolveAssetsDir()) return 'FIGURE_UNAVAILABLE: local render assets (shell.html + bundles) are missing'
  return null
}

// ── 渲染 ───────────────────────────────────────────────────────

/** 从 SVG 文本提取尺寸(viewBox 优先,回退 width/height 属性)。 */
export function extractSvgSize(svg: string): { width?: number; height?: number } {
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (viewBox) return { width: Math.round(parseFloat(viewBox[1])), height: Math.round(parseFloat(viewBox[2])) }
  const w = svg.match(/\bwidth="([\d.]+)/)
  const h = svg.match(/\bheight="([\d.]+)/)
  return {
    width: w ? Math.round(parseFloat(w[1])) : undefined,
    height: h ? Math.round(parseFloat(h[1])) : undefined,
  }
}

async function renderInPage(browser: any, assetsDir: string, input: FigurePayload): Promise<{ svg: string; warnings: string[] }> {
  const page = await browser.newPage()
  const warnings: string[] = []
  try {
    // 零外呼:仅放行 file:/data:,其余一律 abort(测试锁定)。
    await page.setRequestInterception(true)
    page.on('request', (req: any) => {
      const url = String(req.url() || '')
      if (url.startsWith('file:') || url.startsWith('data:')) req.continue()
      else {
        warnings.push(`blocked external request: ${url.slice(0, 120)}`)
        req.abort()
      }
    })
    const shellUrl = `file://${encodeURI(path.join(assetsDir, 'shell.html'))}`
    await page.goto(shellUrl, { waitUntil: 'load', timeout: FIGURE_TIMEOUT_MS })
    const ready = await page.evaluate(() => (window as any).__ready === true)
    if (!ready) throw new Error('FIGURE_FAILED: render shell did not initialize (bundles missing?)')

    const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('FIGURE_TIMEOUT: rendering exceeded 10s')), FIGURE_TIMEOUT_MS)),
      ])

    let svg: string
    if (input.kind === 'mermaid') {
      svg = await withTimeout(page.evaluate(async (src: string, theme?: string) => {
        return await (window as any).__renderMermaid(src, theme)
      }, input.source, input.theme))
    } else {
      svg = await withTimeout(page.evaluate(async (src: string, display?: boolean) => {
        return await (window as any).__renderLatex(src, display)
      }, input.source, input.display))
    }
    if (typeof svg !== 'string' || !svg.includes('<svg')) {
      throw new Error('FIGURE_FAILED: renderer produced no SVG')
    }
    const scale = input.scale ?? 1
    if (scale !== 1) svg = applySvgScale(svg, scale)
    return { svg, warnings }
  } finally {
    // 超时/异常后 page 必须关闭 — 杀页面即杀渲染循环。
    await page.close().catch(() => {})
  }
}

/** scale 应用:放大根 svg 的 width/height(viewBox 保持 → 矢量无损放大)。 */
export function applySvgScale(svg: string, scale: number): string {
  return svg.replace(/(<svg[^>]*?)\bwidth="([\d.]+)([a-z%]*)"/i, (_, head, w, unit) =>
    `${head}width="${(parseFloat(w) * scale).toFixed(2)}${unit}"`)
    .replace(/(<svg[^>]*?)\bheight="([\d.]+)([a-z%]*)"/i, (_, head, h, unit) =>
      `${head}height="${(parseFloat(h) * scale).toFixed(2)}${unit}"`)
}

export async function renderFigure(payload: unknown) {
  // #686: 入口收 unknown — zod 校验在内部(server.ts 的入口校验保留为快速失败)。
  const parsed = figurePayloadSchema.safeParse(payload ?? {})
  if (!parsed.success) {
    throw new Error(`render_figure payload failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const input = parsed.data

  const unavailable = figureUnavailableReason()
  if (unavailable) throw new Error(unavailable)
  const chromePath = resolveChromePath()!
  const assetsDir = resolveAssetsDir()!

  const browser = await getBrowser(chromePath)
  const { svg, warnings } = await renderInPage(browser, assetsDir, input)

  const size = extractSvgSize(svg)
  const buffer = Buffer.from(svg, 'utf-8')
  // 产物以 SVG 为准(设计决策 B)— 导出侧按需 sharp 光栅化;
  // 扩展名如实,绝不做"SVG 字节按位图扩展名直嵌"。
  const saved = await saveFile(buffer, 'figure.svg', 'image/svg+xml')
  // 同时暴露 snake/camel 键 — job-runner 索引与控制面消费端按键取用。
  return {
    file_id: saved.fileId,
    fileId: saved.fileId,
    file_name: saved.fileName,
    mime_type: saved.mimeType,
    s3_key: saved.s3Key,
    width: size.width,
    height: size.height,
    warnings: warnings.length > 0 ? warnings.slice(0, 10) : undefined,
  }
}

// 供测试注入/复位(浏览器是模块级单例)。
export function resetFigureBrowserForTest(): void {
  if (browserState) void Promise.resolve(browserState.browser.close()).catch(() => {})
  browserState = null
  browserLaunch = null
}
