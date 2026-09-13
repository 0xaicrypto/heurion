/**
 * #1009（SECOND_BRAIN Phase 3）— 文件类/文本类引用材料的语义索引。
 *
 * facts/summaries 在审批生效时进 EmbeddingIndex；文件类 ReferenceItem 的
 * 正文此前完全没有语义索引（设计文档 4.7），对话中语义建议因此覆盖不到。
 * 本模块在引用登记/挂载时把正文分块写入 EmbeddingIndex（type='reference'，
 * 分块 ID `<itemId>::cN`，record 自带正文 — 与 document chunk 同约定）。
 *
 * 隐私边界（#1009 验收）：文件类记录携带 FileIndex.patientHash，检索时由
 * EmbeddingIndex.search 的患者隔离过滤（不同 patientHash 的引用材料不会
 * 出现在患者会话的语义命中里）；kb_summary/pasted_text 暂标记为未分级
 * （patientHash=undefined → 仅全局范围可见）。该口径为显式测试用例。
 */
import prisma from '../common/prisma.js'
import { makeLogger } from '../common/logger.js'
import { chunkText } from '../lib/text-chunker.js'
import { normalizeVector } from './embedding-index.js'
import { EmbeddingService } from './embedding/embedding.service.js'
import { resolveFileSourceRef } from '../lib/reference-store.js'
import { cachedExtractDocumentMarkdownFromUpload } from '../lib/document-extractor.js'

const log = makeLogger('memory.reference-embedding')

const CHUNK_CHARS = 1200
const CHUNK_OVERLAP = 100

export interface ReferenceIndexInput {
  id: string
  userId: string
  kind: string
  sourceRef?: string | null
  snapshot?: string | null
  label?: string | null
}

/**
 * 把一条 ReferenceItem 的正文送入语义索引。返回写入的块数（0 = 无正文/
 * 提取失败/embedding 不可用 — 全部静默降级，不阻断引用登记）。
 * `embedFn` 供测试注入（缺省走 provider）。
 */
export async function indexReferenceItem(
  input: ReferenceIndexInput,
  opts: { embedFn?: (texts: string[]) => Promise<number[][]> } = {},
): Promise<number> {
  try {
    const service = new EmbeddingService(input.userId, undefined, opts.embedFn)
    const index = service.embeddingIndex()
    let text = ''
    let patientHash: string | undefined

    if (String(input.kind) === 'file') {
      const fileId = input.sourceRef
        ? String(input.sourceRef)
        : (await resolveFileSourceRef(input.userId, null, String(input.snapshot || input.label || ''))) || ''
      if (!fileId) return 0
      text = await cachedExtractDocumentMarkdownFromUpload(input.userId, fileId, { maxChars: 60_000 }).catch(() => '')
      const fi = await prisma.fileIndex.findFirst({ where: { id: fileId, userId: input.userId }, select: { patientHash: true } }).catch(() => null)
      patientHash = fi?.patientHash || undefined
    } else {
      text = String(input.snapshot || '')
    }
    if (!text.trim()) return 0

    const chunks = chunkText(text, { size: CHUNK_CHARS, overlap: CHUNK_OVERLAP })
    if (chunks.length === 0) return 0
    const vecs = await service.embedBatchOrNull(chunks)
    if (!vecs) return 0
    const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
    let indexed = 0
    chunks.forEach((chunk, i) => {
      const vec = vecs[i]
      if (!vec) return
      index.upsert({
        nodeId: `${input.id}::c${i}`,
        stableId: `${input.id}::c${i}`,
        type: 'reference',
        patientHash,
        contentHash: chunk.slice(0, 16),
        vector: vec,
        model,
        norm: normalizeVector(vec),
        updatedAt: Date.now(),
        content: chunk,
      })
      indexed++
    })
    return indexed
  } catch (err) {
    log.warn('reference index skipped (best-effort)', { refId: input.id, err: String(err).slice(0, 120) })
    return 0
  }
}

/** 移除一条 ReferenceItem 的全部分块索引（取消引用不删索引；删本体时用）。 */
export function removeReferenceIndex(userId: string, referenceId: string): void {
  try {
    new EmbeddingService(userId).embeddingIndex().remove(referenceId, 'reference')
  } catch { /* best-effort */ }
}
