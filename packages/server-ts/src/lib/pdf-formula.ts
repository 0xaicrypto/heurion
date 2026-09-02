/**
 * #fix: PDF 公式视觉 OCR(方案 A) — PDF 文本层(pdf.js)没有公式语义,
 * 公式是矢量图形渲染的,提取后丢失/乱码。这里把每页渲染为 PNG,用视觉
 * 模型把公式转成 LaTeX,以 $$...$$ 追加到导入的 markdown 文末,AI 才能
 * 理解文章中的数学内容。
 *
 * 成本控制:
 * - PDF_FORMULA_OCR='0' 可关闭(默认开 — 用户实测确认需要公式;
 *   仅在需要时用 '0' 关掉以省视觉调用成本)
 * - PDF_FORMULA_OCR_MAX_PAGES 默认 10(只处理前 N 页)
 * - PDF_FORMULA_OCR_CONCURRENCY 默认 3(并行视觉调用)
 * - 失败静默降级(返回空串,不阻断导入)
 * - #698: 结果进程内 LRU 缓存(key=userId:fileId,TTL 30min) — 同一文件
 *   第二次 import_reference/重新润色不再重烧视觉调用(uploads 文件不可变,
 *   新上传=新 fileId,缓存安全;与 document-extractor 的提取缓存同款)。
 *   失败/空结果不缓存,下次可重试。
 */
import { PDFParse } from 'pdf-parse'
import fs from 'fs'
import { safeUploadPath } from './upload-path.js'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('documents.formula')

function formulaOcrEnabled(): boolean {
  return process.env.PDF_FORMULA_OCR !== '0'
}

function maxFormulaPages(): number {
  return parseInt(process.env.PDF_FORMULA_OCR_MAX_PAGES || '10', 10)
}

function formulaConcurrency(): number {
  return parseInt(process.env.PDF_FORMULA_OCR_CONCURRENCY || '3', 10)
}

function formulaPrompt(page: number): string {
  return `This is page ${page} of an academic paper rendered from a PDF. Extract every mathematical formula/equation visible on this page and convert each to LaTeX, one per line, each wrapped in $$...$$. Preserve subscripts, superscripts, fractions, square roots and Greek letters exactly. Do NOT include surrounding prose, figure captions or tables. If the page contains no formulas, reply with exactly NONE.`
}

/** 并发受限的 map。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// #698: 公式 OCR 结果 LRU — key=userId:fileId, TTL 30min, 上限 50 条。
const FORMULA_CACHE_MAX = 50
const FORMULA_CACHE_TTL_MS = 30 * 60 * 1000
const formulaCache = new Map<string, { text: string; at: number }>()

/**
 * 对 PDF 逐页截图 → 视觉模型提取公式转 LaTeX。返回 markdown 公式段
 * (以 '## 公式' 开头,按页分组),失败/无公式返回 ''。
 * #698: 命中缓存直接返回 — 同一文件重复导入零视觉调用。
 */
export async function extractFormulasFromPdf(userId: string, fileId: string): Promise<string> {
  if (!formulaOcrEnabled()) return ''
  const cacheKey = `${userId}:${fileId}`
  const hit = formulaCache.get(cacheKey)
  if (hit && Date.now() - hit.at < FORMULA_CACHE_TTL_MS) {
    log.info('[formula] cache hit', { fileId })
    return hit.text
  }
  const text = await extractFormulasFromPdfUncached(userId, fileId)
  // 空结果可能是「无公式」也可能是失败 — 都不缓存,下次重试无副作用。
  if (text) {
    if (formulaCache.size >= FORMULA_CACHE_MAX) {
      let oldest: string | null = null
      let oldestAt = Infinity
      for (const [k, v] of formulaCache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldest = k }
      }
      if (oldest) formulaCache.delete(oldest)
    }
    formulaCache.set(cacheKey, { text, at: Date.now() })
  }
  return text
}

async function extractFormulasFromPdfUncached(userId: string, fileId: string): Promise<string> {
  if (!formulaOcrEnabled()) return ''
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return ''

  let parser: PDFParse | null = null
  try {
    const buffer = fs.readFileSync(filepath)
    parser = new PDFParse({ data: new Uint8Array(buffer) })
    // load 是私有方法 — getInfo/getScreenshot 内部会自动触发解析。
    const info = await parser.getInfo()
    const total = Number(info?.total || 0)
    if (!total) return ''
    const pages = Math.min(total, maxFormulaPages())
    // 惰性 import 一次 — 便于测试 mock,且避免并发 worker 内重复动态
    // import 出现 mock/真实模块竞态(vitest 下页面并发时曾拿到真实
    // provider → GEMINI_API_KEY is not configured)。
    const { createAiProvider } = await import('../common/ai/ai-provider.js')
    const provider = createAiProvider()

    const results = await mapLimit(Array.from({ length: pages }, (_, i) => i), formulaConcurrency(), async (i) => {
      try {
        const shot = await parser!.getScreenshot({ partial: [i + 1] })
        const png = shot?.pages?.[0]?.data
        if (!png || png.length === 0) return null
        const base64 = Buffer.from(png).toString('base64')
        const visionResult = await provider.vision(
          [{ base64, mimeType: 'image/png' }],
          formulaPrompt(i + 1),
          { telemetryContext: { userId, workspaceId: userId, action: 'pdf.formula_ocr' } },
        )
        const latex = String(visionResult?.content || '').trim()
        if (!latex || /^NONE$/i.test(latex)) return null
        return { page: i + 1, latex }
      } catch (err) {
        // 单页失败(渲染/视觉调用/无 key)不阻断整篇导入。
        log.error('[formula] page', i, 'failed:', String((err as Error)?.message || err).slice(0, 150))
        return null
      }
    })

    const found = results.filter((r): r is { page: number; latex: string } => r !== null)
    // #698: 页级可观测 — 成功/总数一眼可查(llm_cost 侧已有 action=pdf.formula_ocr)。
    log.info(`[formula] ocr done file=${fileId} pages=${pages} hit=${found.length}`)
    if (found.length === 0) return ''
    return (
      '\n\n## 公式\n\n' +
      found.map((f) => `（第 ${f.page} 页）\n\n${f.latex}`).join('\n\n')
    )
  } catch {
    return ''
  } finally {
    await parser?.destroy?.().catch(() => {})
  }
}
