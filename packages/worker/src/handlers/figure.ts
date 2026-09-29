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
import type { Browser } from 'puppeteer-core'
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

// ── browser singleton(有界回收 + 在途引用计数) ────────────────

interface BrowserState {
  browser: Browser
  jobs: number
  /** 在途渲染数 — 回收必须等归零(#1139: 旧实现第 50 个作业直接 close,
   *  WORKER_MAX_CONCURRENT=4 下仍有用例在使用 → Target closed)。 */
  inFlight: number
  recyclePending: boolean
}
let browserState: BrowserState | null = null
let browserLaunch: Promise<Browser> | null = null

/** #1139: chromium 崩溃/被外部关闭 → 重置单例,下次 acquire 重新拉起
 *  (旧实现要等回收阈值,期间所有渲染必败)。 */
function attachDisconnectReset(browser: Browser): void {
  browser.on('disconnected', () => {
    if (browserState?.browser === browser) {
      browserState = null
      browserLaunch = null
    }
  })
}

/** 获取共享浏览器并登记在途引用(渲染结束必须 release)。 */
export async function acquireFigureBrowser(chromePath: string): Promise<Browser> {
  if (browserState) {
    browserState.jobs += 1
    browserState.inFlight += 1
    if (browserState.jobs >= BROWSER_RECYCLE_JOBS) browserState.recyclePending = true
    return browserState.browser
  }
  browserLaunch = browserLaunch || launchBrowser(chromePath)
  let browser: Browser
  try {
    browser = await browserLaunch
  } catch (err) {
    // #1139: 启动失败不得把 rejected Promise 永久缓存(旧实现此后每个
    // 作业都直接 reject,一次冷启动超时废掉整个进程生命周期)。
    browserLaunch = null
    throw err
  }
  attachDisconnectReset(browser)
  browserState = { browser, jobs: 1, inFlight: 1, recyclePending: false }
  return browser
}

/**
 * 释放一次在途引用;回收标记且在途归零时才真正关闭。
 * #1150-followup: 传入 acquire 时拿到的实例 — 旧作业的迟到释放(实例已被
 * 回收/替换)不得扣新浏览器的计数,否则新实例会被提前关闭。可选参数保持
 * 旧调用兼容(不传 = 释放当前实例)。
 */
export function releaseFigureBrowser(browser?: Browser): void {
  if (!browserState) return
  if (browser && browser !== browserState.browser) {
    // 实例已轮换:这是旧作业的重复/迟到释放,忽略(回收时已确保 inFlight=0)。
    return
  }
  if (browserState.inFlight <= 0) return // 重复释放不把计数扣穿
  browserState.inFlight -= 1
  if (browserState.recyclePending && browserState.inFlight === 0) {
    const stale = browserState
    browserState = null
    browserLaunch = null
    void Promise.resolve(stale.browser.close()).catch(() => {})
  }
}

async function launchBrowser(chromePath: string): Promise<Browser> {
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

/** 渲染 shell 注入的全局桥（shell.html 的 bundle 提供）。 */
interface FigureRenderWindow {
  __ready?: boolean
  __renderMermaid: (src: string, theme?: string) => Promise<string>
  __renderLatex: (src: string, display?: boolean) => Promise<string>
}

async function renderInPage(browser: Browser, assetsDir: string, input: FigurePayload): Promise<{ svg: string; warnings: string[] }> {
  const page = await browser.newPage()
  const warnings: string[] = []
  try {
    // 零外呼:仅放行 file:/data:,其余一律 abort(测试锁定)。
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = String(req.url() || '')
      if (url.startsWith('file:') || url.startsWith('data:')) req.continue()
      else {
        warnings.push(`blocked external request: ${url.slice(0, 120)}`)
        req.abort()
      }
    })
    const shellUrl = `file://${encodeURI(path.join(assetsDir, 'shell.html'))}`
    await page.goto(shellUrl, { waitUntil: 'load', timeout: FIGURE_TIMEOUT_MS })
    const ready = await page.evaluate(() => (window as unknown as FigureRenderWindow).__ready === true)
    if (!ready) throw new Error('FIGURE_FAILED: render shell did not initialize (bundles missing?)')

    const withTimeout = <T,>(p: Promise<T>): Promise<T> => {
      // #1139: 定时器必须在完成后清理 — 旧实现超时/成功后 timer 仍挂着,
      // 长跑进程累积无谓定时器(且 keep-alive 挂住事件循环)。
      let timer: ReturnType<typeof setTimeout>
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIGURE_TIMEOUT: rendering exceeded 10s')), FIGURE_TIMEOUT_MS)
      })
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
    }

    let svg: string
    if (input.kind === 'mermaid') {
      svg = await withTimeout(page.evaluate(async (src: string, theme?: string) => {
        return await (window as unknown as FigureRenderWindow).__renderMermaid(src, theme)
      }, input.source, input.theme))
    } else {
      svg = await withTimeout(page.evaluate(async (src: string, display?: boolean) => {
        return await (window as unknown as FigureRenderWindow).__renderLatex(src, display)
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

  // #1139: acquire/release 引用计数 — 回收等待在途归零,不再关闭在用浏览器。
  const browser = await acquireFigureBrowser(chromePath)
  try {
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
  } finally {
    releaseFigureBrowser(browser)
  }
}

// 供测试注入/复位(浏览器是模块级单例)。
export function resetFigureBrowserForTest(): void {
  if (browserState) void Promise.resolve(browserState.browser.close()).catch(() => {})
  browserState = null
  browserLaunch = null
}
