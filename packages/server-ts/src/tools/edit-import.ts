/**
 * edit_document import mode (#697) — reference-material import extracted
 * from edit-document-tool.ts so the tool class keeps only matching +
 * write-back. Uses doc-import.ts primitives (resolveImportTargets /
 * extractRefText / writeDocBody) as the single orchestration point.
 */
import type { ToolResult } from './base-tool.js'
import { resolveImportTargets, extractRefText, writeDocBody } from './doc-import.js'

/** 导入模式:按 label 定位参考材料,把提取的正文写入文档。 */
export async function executeImportReference(
  userId: string,
  docId: string,
  reference: string,
  summary: string,
): Promise<ToolResult> {
  try {
    const labels = await resolveImportTargets(userId, docId)
    const hit = labels.find(({ r, label }) => label.includes(reference) || reference.includes(label))
    if (!hit) {
      const available = labels.map((l) => l.label).slice(0, 5).join('、') || '(无)'
      return { success: false, error: `未找到参考材料 "${reference}"。当前参考材料:${available}。请用参考材料的名称(label)作为 import_reference。` }
    }

    const { text, error } = await extractRefText(userId, docId, hit.r, hit.label)
    if (error) return { success: false, error }
    const { body, error: writeError } = await writeDocBody(userId, docId, text, 'AI import')
    if (writeError) return { success: false, error: writeError }
    return { success: true, output: JSON.stringify({ body, summary: `已导入参考材料「${hit.label}」(${text.length} 字符)` }) }
  } catch (err) {
    return { success: false, error: `edit_document import failed: ${(err as Error).message.slice(0, 200)}` }
  }
}
