/**
 * #1034 — 写作会话引用登记的 doc 专属副作用（从 documents.router 抽出）。
 *
 * 统一引用链路（`/api/v1/sessions/:sessionId/references`）对 `doc-<docId>`
 * 会话需要保留旧写作端点的两项能力：
 * - 上传即草稿：空文档 + 文件类参考 → `ensureDraftBody` 导入正文回传；
 * - pptx 后台解析：deck 落点 + 空正文导入（响应只回 started，前端轮询）。
 *
 * 旧端点 `/api/v1/docs/:docId/references` 保留观察期，两处共用本函数避免分叉。
 */
import prisma from '../../common/prisma'
import { makeLogger } from '../../common/logger'
import { SCHEMA_VERSION } from '@heurion/contracts'
import { extractPptxContentFromUpload, pptxSlidesToDeck } from '../../lib/pptx-extractor.js'
import { ensureDraftBody } from '../../tools/doc-import.js'
import { writeDocVersion } from '../../tools/doc-version-writer.js'

const log = makeLogger('doc-reference-effects')

export interface DocReferenceSideEffects {
  imported_body: string | null
  imported: boolean
  pptx_parse: { started: boolean; reason?: string } | null
}

const NO_EFFECTS: DocReferenceSideEffects = { imported_body: null, imported: false, pptx_parse: null }

export function parseDocSessionId(sessionId: string): string | null {
  return sessionId.startsWith('doc-') && sessionId.length > 4 ? sessionId.slice(4) : null
}

export async function runDocReferenceSideEffects(input: {
  userId: string
  sessionId: string
  /** 归一化后的 kind（file/kb_summary/pasted_text）。 */
  kind: string
  label: string
  content: string
}): Promise<DocReferenceSideEffects> {
  const docId = parseDocSessionId(input.sessionId)
  if (!docId) return NO_EFFECTS
  const doc = await prisma.doc.findFirst({ where: { id: docId, userId: input.userId } }).catch(() => null)
  if (!doc) return NO_EFFECTS

  const refFileName = String(input.label || input.content || '')
  const isPptxRef = input.kind === 'file' && /\.pptx$/i.test(refFileName)
  let pptxParse: { started: boolean; reason?: string } | null = null
  if (isPptxRef) {
    const fileIndex = await prisma.fileIndex.findFirst({ where: { userId: input.userId, name: refFileName, deletedAt: null } }).catch(() => null)
    if (!fileIndex) {
      pptxParse = { started: false, reason: '上传记录缺失，无法解析 PPT' }
    } else if (Number(fileIndex.sizeBytes || 0) > 50 * 1024 * 1024) {
      pptxParse = { started: false, reason: '文件超过 50MB，已跳过 PPT 解析' }
    } else {
      pptxParse = { started: true }
      void (async () => {
        try {
          const parsed = extractPptxContentFromUpload(input.userId, fileIndex.id)
          if (parsed.error) return
          const deck = pptxSlidesToDeck(parsed.slides, parsed.images, doc.title || refFileName, SCHEMA_VERSION)
          if (deck) {
            const written = await writeDocVersion({ userId: input.userId, docId, deck, snapshotLabel: 'AI deck' })
            if (written.error) log.warn('pptx deck write-back failed', { docId, reason: written.error.slice(0, 200) })
          }
          if (!String(doc.body || '').trim()) {
            await ensureDraftBody(input.userId, docId, { scenario: 'upload', preferLabel: refFileName })
          }
        } catch (err) {
          log.warn('pptx background parse failed', { docId, reason: (err as Error)?.message?.slice(0, 200) })
        }
      })()
    }
  }

  const autoImport = (async () => {
    try {
      if (isPptxRef) return null // pptx 走后台，不阻塞登记响应
      if (input.kind !== 'file') return null
      if (String(doc.body || '').trim()) return null
      if (/\.pptx$/i.test(refFileName)) return null
      const ensured = await ensureDraftBody(input.userId, docId, { scenario: 'upload', preferLabel: input.label || input.content || '' })
      return ensured.error ? null : ensured.body
    } catch (err) {
      log.warn('reference auto-import failed', { docId, reason: (err as Error)?.message?.slice(0, 200) })
      return null
    }
  })()
  const importedBody = await autoImport
  return { imported_body: importedBody, imported: importedBody !== null, pptx_parse: pptxParse }
}
