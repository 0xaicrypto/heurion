/**
 * #1006 — 主 chat 会话引用材料段（与写作会话共用 buildSessionReferenceBlocks）。
 *
 * 写作会话走 document_context 段（同一 session refs 取数）；本段服务非 doc
 * 会话，把用户挂载到当前 session 的引用材料注入 system 上下文。无挂载 /
 * 全解析失败返回空串（合法降级）。
 */
import { loadSessionReferenceItems } from '../../lib/reference-store.js'
import { buildSessionReferenceBlocks, findUploadFileByName } from '../shared/chat-context.js'
import { classifyGuidelineBySummaryTitle } from '../shared/summary-lookup.js'

export async function buildSessionReferencesBlock(input: {
  userId: string
  sessionId: string
  messageText: string
  stage?: (label: string) => void
}): Promise<string> {
  const { userId, sessionId, messageText, stage } = input
  if (sessionId.startsWith('doc-')) return ''
  const items = await loadSessionReferenceItems(userId, sessionId, {
    classifyGuideline: classifyGuidelineBySummaryTitle,
  })
  if (items.length === 0) return ''
  const { blocks } = await buildSessionReferenceBlocks(userId, items, {
    findFileByName: async (name) => findUploadFileByName(userId, name),
    onProgress: (i, total, label) => stage?.(`正在解析引用材料 ${i}/${total}：${String(label).slice(0, 40)}`),
    userText: messageText,
  })
  if (blocks.length === 0) return ''
  return `\n## Reference Materials\n${blocks.join('\n\n')}`
}
