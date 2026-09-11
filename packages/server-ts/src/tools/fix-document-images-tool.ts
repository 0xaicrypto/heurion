import fs from 'fs'
import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { issueChartToken, verifyChartToken } from '../common/chart-token.js'
import { safeUploadPath } from '../lib/upload-path.js'
import { writeDocVersion } from './doc-version-writer.js'
import { makeLogger } from '../common/logger.js'

/**
 * #fix 2026-09 — fix_document_images: 文档图片链接「先审计、后修复」工具。
 *
 * 修复换图工作流的两个生产问题：
 *  1. 模型此前对不显示的图片一律先 render_chart 全量重生成，再做脆弱的
 *     edit_document 逐个替换（易撞锚点死循环）；实际上多数图片只是
 *     token 过期/坏链形状，文件本体仍在库中 — 重写 URL 即可，无需重生成。
 *  2. 读取期自愈（refreshFileUrls）只改写响应不落库，DB 正文里的坏链
 *     依旧存在；本工具通过 writeDocVersion 落库 → tool-loop 推
 *     doc_updated SSE → 编辑器实时重渲染（用户无需刷新页面）。
 *
 * 判定逻辑（与 /files/download/:fileId 的服务口径一致 — 磁盘存在性）：
 *  - 文件在库 + token 有效 → 保留（不产生无意义版本）；
 *  - 文件在库 + token 过期/失效/缺失/旧版坏链形状 → 改写 canonical + 重签；
 *  - 文件不在库 → 保持原样并上报，仅这些才需要 render_chart/generate_image
 *    重生成，然后用 edit_document 以整行图片为 old_text 替换链接。
 */

const log = makeLogger('tools.fix-document-images')

export interface DocImageLink {
  fileId: string
  /** 在原文中匹配到的完整 URL（含 token/查询串）。 */
  url: string
  /** canonical = /files/download/<id>；legacy = /files/<id>/download（无路由坏链）。 */
  shape: 'canonical' | 'legacy'
  /** markdown 图片的 alt 文本 — 帮模型识别是哪张图（裸 URL 为空）。 */
  alt: string
}

const CANONICAL_RE = /\/api\/v1\/files\/download\/([\w.\-]+)(\?token=[^\s)"'\\]*)?/g
const LEGACY_RE = /\/api\/v1\/files\/(?!download\/|preview-page\/)([\w.\-]+)\/download(?:\?token=[^\s)"'\\]*)?/g
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g

/** 从 URL 中提取 fileId 与形状；非文件下载链接返回 null。 */
export function fileIdFromUrl(url: string): { fileId: string; shape: 'canonical' | 'legacy' } | null {
  const canonical = url.match(/\/api\/v1\/files\/download\/([\w.\-]+)/)
  if (canonical) return { fileId: canonical[1], shape: 'canonical' }
  const legacy = url.match(/\/api\/v1\/files\/(?!download\/|preview-page\/)([\w.\-]+)\/download/)
  if (legacy) return { fileId: legacy[1], shape: 'legacy' }
  return null
}

/** 收集文本中全部文件下载链接（markdown 图片优先带 alt），按 fileId 去重。 */
export function collectDocImageLinks(text: string): DocImageLink[] {
  if (!text || !text.includes('/api/v1/files/')) return []
  const byFile = new Map<string, DocImageLink>()
  for (const m of text.matchAll(MD_IMAGE_RE)) {
    const url = m[2].trim()
    const hit = fileIdFromUrl(url)
    if (hit && !byFile.has(hit.fileId)) {
      byFile.set(hit.fileId, { fileId: hit.fileId, url, shape: hit.shape, alt: m[1] })
    }
  }
  for (const re of [CANONICAL_RE, LEGACY_RE]) {
    for (const m of text.matchAll(re)) {
      const url = m[0]
      const hit = fileIdFromUrl(url)
      if (hit && !byFile.has(hit.fileId)) {
        byFile.set(hit.fileId, { fileId: hit.fileId, url, shape: hit.shape, alt: '' })
      }
    }
  }
  return [...byFile.values()]
}

export interface RewriteResult {
  text: string
  /** 已改写（canonical 重签 / 坏链重写）的 fileId。 */
  fixed: string[]
  /** token 有效且文件在库 — 原样保留。 */
  valid: string[]
  /** 文件不在库（服务端必 404）— 链接保持原样,由调用方上报重生成。 */
  missing: string[]
}

/**
 * 按判定逻辑改写文本中的图片链接。exists = 文件库存在性谓词
 * （磁盘口径），missing 的链接不动 — 伪造 fileId 没有意义。
 */
export function rewriteDocImageUrls(text: string, userId: string, exists: (fileId: string) => boolean): RewriteResult {
  if (!text || !text.includes('/api/v1/files/')) return { text, fixed: [], valid: [], missing: [] }
  const fixed = new Set<string>()
  const valid = new Set<string>()
  const missing = new Set<string>()
  const mint = (id: string) => `/api/v1/files/download/${id}?token=${issueChartToken(id, userId)}`

  let out = text.replace(CANONICAL_RE, (match, id: string, tokenPart?: string) => {
    if (!exists(id)) {
      missing.add(id)
      return match
    }
    const token = tokenPart?.startsWith('?token=') ? tokenPart.slice(7) : ''
    if (token && verifyChartToken(id, token) === userId) {
      valid.add(id)
      return match
    }
    fixed.add(id)
    return mint(id)
  })
  out = out.replace(LEGACY_RE, (match, id: string) => {
    if (!exists(id)) {
      missing.add(id)
      return match
    }
    fixed.add(id)
    return mint(id)
  })
  return { text: out, fixed: [...fixed], valid: [...valid], missing: [...missing] }
}

export class FixDocumentImagesTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'fix_document_images' }

  get description(): string {
    return [
      'Audit and repair image links in the current writing-session document. ALWAYS call this BEFORE regenerating any figure/image:',
      'it checks every image URL against the file library — links whose files still exist are rewritten to canonical URLs with fresh tokens (broken display without regeneration),',
      'and ONLY files missing from the library are reported back for regeneration (render_chart/generate_image, then replace the link with edit_document using the full image line as old_text).',
      'No arguments. Pass summary when it makes changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'A one-line summary of what was fixed.' },
      },
      required: [],
    }
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'fix_document_images is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)
    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const body = String(existing.body || '')
      const deckRaw = typeof existing.deck === 'string' && existing.deck ? existing.deck : null

      // 文件库存在性 — 与下载端点同一口径（磁盘 + safeUploadPath 防护）。
      const existsCache = new Map<string, boolean>()
      const exists = (fileId: string): boolean => {
        let hit = existsCache.get(fileId)
        if (hit === undefined) {
          const p = safeUploadPath(this.ctx.userId, fileId)
          hit = Boolean(p && fs.existsSync(p))
          existsCache.set(fileId, hit)
        }
        return hit
      }

      const bodyRes = rewriteDocImageUrls(body, this.ctx.userId, exists)
      let deckRes: RewriteResult | null = null
      if (deckRaw) {
        deckRes = rewriteDocImageUrls(deckRaw, this.ctx.userId, exists)
      }

      const fixed = [...new Set([...bodyRes.fixed, ...(deckRes?.fixed ?? [])])]
      const missing = [...new Set([...bodyRes.missing, ...(deckRes?.missing ?? [])])]
      const validCount = bodyRes.valid.length + (deckRes?.valid.length ?? 0)

      // 库内对照诊断 — fileIndex 有行但磁盘缺文件（卷重建/worker 未挂载）
      // 是「图仍不显示」的典型漂移,日志单列出来。FileIndex.id 即 fileId。
      const allIds = [...new Set(collectDocImageLinks(body).map((l) => l.fileId))]
      let indexIds: string[] = []
      try {
        const rows = await prisma.fileIndex.findMany({
          where: { userId: this.ctx.userId, id: { in: allIds } },
          select: { id: true },
        })
        indexIds = rows.map((r: { id: string }) => r.id)
      } catch {
        // fileIndex 查询失败不阻断审计 — 磁盘口径已足够判定
      }
      const onDiskNotIndexed = allIds.filter((id) => exists(id) && !indexIds.includes(id))
      const indexedNotOnDisk = allIds.filter((id) => !exists(id) && indexIds.includes(id))

      log.info('image audit', {
        docId, total: allIds.length, fixed: fixed.length, missing: missing.length, valid: validCount,
        fixedIds: fixed.slice(0, 10), missingIds: missing.slice(0, 10),
        indexedNotOnDisk: indexedNotOnDisk.slice(0, 10), onDiskNotIndexed: onDiskNotIndexed.slice(0, 10),
      })

      const links = collectDocImageLinks(body)
      const altOf = (fileId: string) => links.find((l) => l.fileId === fileId)?.alt || ''
      const missingDesc = missing.map((id) => `${id}${altOf(id) ? `(${altOf(id).slice(0, 30)})` : ''}`).join('、') || '无'

      if (fixed.length === 0) {
        const summary = missing.length
          ? `图片审计完成：${validCount} 个链接有效；${missing.length} 个文件不在库中（${missingDesc}）— 仅这些需要 render_chart/generate_image 重新生成，其余不要重生成。`
          : `图片审计完成：共 ${validCount} 个图片链接，文件均在库且 token 有效，显示问题不在链接本身（检查前端渲染/网络），无需任何重生成。`
        return { success: true, output: JSON.stringify({ body, summary, fixed: [], missing }) }
      }

      // deck 改写 — 与 documents.router.refreshDeckUrls 同构（JSON 串级改写）。
      const deckChanged = deckRes !== null && deckRes.text !== deckRaw
      const nextDeckObj = deckChanged ? JSON.parse(deckRes!.text) : undefined
      const summary = [
        `已修复 ${fixed.length} 个图片链接（重签 token/改写坏链，文件均在库）：${fixed.slice(0, 8).join('、')}。`,
        missing.length
          ? `另有 ${missing.length} 个文件不在库（${missingDesc}）— 仅对这些调用 render_chart/generate_image 重新生成，然后用 edit_document 以整行图片做 old_text 替换链接；已修复的不要再生成。`
          : '全部图片文件均在库，无需重新生成。',
      ].join(' ')

      const written = await writeDocVersion({
        userId: this.ctx.userId,
        docId,
        body: bodyRes.text,
        ...(deckChanged ? { deck: nextDeckObj as Record<string, unknown> } : {}),
        snapshotLabel: 'AI fix image links',
      })
      if (written.error) return { success: false, error: written.error }

      return {
        success: true,
        // #989 Phase 3: 输出携带块投影 — tool-loop 转 doc_updated.projection 推前端。
        output: JSON.stringify({ body: written.body, summary, fixed, missing, projection: written.projection }),
      }
    } catch (err) {
      return { success: false, error: `fix_document_images failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
