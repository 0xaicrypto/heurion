/**
 * #fix 2026-09 — 图片视觉理解单点(A+B 共用):
 *  - A `view_image` 工具:模型按需"看"文档内嵌图/截图(file_id 或 URL);
 *  - B 导入期图题:embedDocumentImages 落盘后逐图生成 vision caption
 *    写进 alt,模型被动阅读 markdown 时就知道每张图画的是什么。
 *
 * 模型对文档里的图片原本是"盲"的(只见 `![caption](url)` 文本);唯一的
 * 视觉通道是聊天附件(≤4MB)。本模块把文件库图片(uploads 目录,与
 * fix_document_images/下载端点同一磁盘口径)喂给多模态主模型。
 *
 * 缓存:key=userId:fileId[:question] — 图片文件不可变,同一图片同一问题
 * 不重烧视觉调用(同 #698 pdf-formula 口径);空结果(失败)不缓存,下次重试。
 */
import fs from 'fs'
import { getLlmGateway, providerSupportsVision, resolveActiveModel, currentLlmProvider } from '../common/llm-gateway.js'
import { safeUploadPath } from './upload-path.js'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('lib.image-vision')

const CAPTION_CACHE_MAX = 200
const CAPTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const captionCache = new Map<string, { caption: string; at: number }>()

/** 测试钩子:清空描述缓存。 */
export function resetImageVisionCacheForTest(): void {
  captionCache.clear()
}

/** 当前主模型是否多模态;是则返回模型名,否则 null(调用方诚实跳过/报错)。 */
export function visionModelForActiveProvider(): string | null {
  const model = resolveActiveModel()
  if (!providerSupportsVision(currentLlmProvider(), model)) return null
  return model
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return null
}

/** 读文件库图片为 base64(safeUploadPath 防穿越;非图片/不存在返回 null)。 */
export function readImageFile(userId: string, fileId: string): { mime: string; dataBase64: string } | null {
  const p = safeUploadPath(userId, fileId)
  if (!p || !fs.existsSync(p)) return null
  try {
    const buf = fs.readFileSync(p)
    const mime = sniffImageMime(buf)
    if (!mime) return null
    return { mime, dataBase64: buf.toString('base64') }
  } catch {
    return null
  }
}

/** 默认描述提示(B 图题用 — 简短,写进 alt 不喧宾夺主)。 */
const CAPTION_PROMPT = '用一句中文描述这张图片的内容(图片类型/展示对象/关键信息,如"柱状图:三组患者的 12 个月无进展生存率对比"),不超过 50 字,直接输出描述本身,不要任何前后缀。'

/**
 * 视觉理解一张图片,返回文字。失败/无视觉模型/文件不存在 → ''(调用方
 * best-effort 降级,绝不阻断主流程)。
 */
export async function describeImage(userId: string, fileId: string, question?: string): Promise<string> {
  const model = visionModelForActiveProvider()
  if (!model) return ''
  const key = `${userId}:${fileId}:${question || 'caption'}`
  const hit = captionCache.get(key)
  if (hit && Date.now() - hit.at < CAPTION_CACHE_TTL_MS) {
    return hit.caption
  }
  const img = readImageFile(userId, fileId)
  if (!img) return ''
  const prompt = question
    ? `请阅读这张图片并回答问题(中文,直接给出答案):\n${question}`
    : CAPTION_PROMPT
  try {
    const r = await getLlmGateway().chatWithMeta(
      [{
        role: 'user',
        content: [
          { type: 'image', mime: img.mime, dataBase64: img.dataBase64 },
          { type: 'text', text: prompt },
        ],
      }],
      {
        model,
        maxTokens: 512,
        temperature: 0.3,
        telemetryContext: { userId, workspaceId: userId, action: 'image.describe' },
      },
    )
    const caption = r.text.trim()
    if (!caption) return ''
    if (captionCache.size >= CAPTION_CACHE_MAX) {
      let oldest: string | null = null
      let oldestAt = Infinity
      for (const [k, v] of captionCache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldest = k }
      }
      if (oldest) captionCache.delete(oldest)
    }
    captionCache.set(key, { caption, at: Date.now() })
    log.info('[image-vision] described', { fileId, question: Boolean(question), chars: caption.length })
    return caption
  } catch (err) {
    log.warn('[image-vision] describe failed', { fileId, error: (err as Error).message.slice(0, 120) })
    return ''
  }
}

/** 并发受限的 map(同 pdf-formula 口径) — 导入期批量图题用。 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
