import { strFromU8, unzipSync } from 'fflate'
import { DOC_XML, paragraphSpan, spliceDeleteParagraph, spliceInsertAfter, spliceReplaceParagraph, type Projection } from './office.ts'

/**
 * S5 三方合并（DESIGN.md §4.3 第二步，docx）：
 *
 * 方向 = **AI 变更重放到用户 head 上**（用户优先的实现方式）：
 * - AI 改了 base 的节点 X：
 *     head 没有 X（用户删了/重写换了新 id）→ 用户赢，AI 改动丢弃；
 *     head 的 X 文本 ≠ base 的 X 文本（用户也改了）→ 用户赢；
 *     head 的 X 与 base 相同（用户没动）→ 应用：整段落元素从 AI 文件拼接过去。
 * - AI 新增 N（base 没有）：按 AI 里的前一 file-backed 兄弟在 head 中定位（该兄弟
 *   被用户删掉时向前再找一级），插到其后；找不到锚点 → 丢弃并记录。
 * - AI 删除 X：head 还有 X → 删；head 已没有 → no-op。
 *
 * 冲突判定全程用「文本是否偏离 base」而非 id（Collabora 回写会换 id，reconcile
 * 已把未触碰内容恢复原 id——两者互为兜底）。
 */
export interface MergeResult {
  bytes: Uint8Array
  applied: Array<{ id: string; kind: 'modified' | 'added' | 'removed' }>
  /** 被用户改动覆盖的 AI 节点（merge_result 事件 + 线程说明）。 */
  overridden: Array<{ id: string; text: string }>
}

export function mergeAiOpsOntoHead(input: {
  baseProj: Projection
  aiBytes: Uint8Array
  aiProj: Projection
  headBytes: Uint8Array
  headProj: Projection
}): MergeResult {
  const { baseProj, aiBytes, aiProj, headBytes, headProj } = input
  const result: MergeResult = { bytes: headBytes, applied: [], overridden: [] }

  const baseNodes = (baseProj.nodes ?? []).filter(n => n.id && !/^(tbl|sdt|anon)-/.test(n.id))
  const aiList = (aiProj.nodes ?? []).filter(n => n.id && !/^(tbl|sdt|anon)-/.test(n.id))
  const aiById = new Map(aiList.map(n => [n.id, n]))
  const headIds = new Set((headProj.nodes ?? []).map(n => n.id))
  const headTextById = new Map((headProj.nodes ?? []).map(n => [n.id, n.text]))

  let aiXml: string | null = null
  const aiParagraph = (id: string): string | null => {
    if (aiXml === null) {
      const files = unzipSync(aiBytes, { filter: f => f.name === DOC_XML })
      aiXml = files[DOC_XML] ? strFromU8(files[DOC_XML]!) : ''
    }
    return aiXml ? paragraphSpan(aiXml, id)?.element ?? null : null
  }

  // ① AI 修改 base 节点 → 试着落到 head
  for (const base of baseNodes) {
    const ai = aiById.get(base.id)
    if (!ai) continue
    if (ai.text === base.text) continue // AI 未动此节点
    const headText = headTextById.get(base.id)
    if (headText === undefined || headText !== base.text) {
      // 用户删了它 / 重写了它 / 改了内容 —— 用户赢
      result.overridden.push({ id: base.id, text: ai.text })
      continue
    }
    const element = aiParagraph(base.id)
    if (!element) continue
    result.bytes = spliceReplaceParagraph(result.bytes, base.id, element)
    headTextById.set(base.id, ai.text)
    result.applied.push({ id: base.id, kind: 'modified' })
  }

  // ② AI 新增节点（base 没有）：按 AI 中的前兄弟定位插入
  for (let i = 0; i < aiList.length; i++) {
    const n = aiList[i]!
    if (baseNodes.some(b => b.id === n.id)) continue
    // 向前找最近一个「已在 head 里」的锚点（前兄弟或更早；刚插入的也算）
    let inserted = false
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const anchorId = aiList[j]!.id
      if (!headIds.has(anchorId)) continue
      const element = aiParagraph(n.id)
      if (!element) break
      result.bytes = spliceInsertAfter(result.bytes, anchorId, element)
      headIds.add(n.id)
      headTextById.set(n.id, n.text)
      result.applied.push({ id: n.id, kind: 'added' })
      inserted = true
      break
    }
    if (!inserted) result.overridden.push({ id: n.id, text: n.text })
  }

  // ③ AI 删除节点：head 还有 → 删
  for (const base of baseNodes) {
    if (aiById.has(base.id)) continue
    if (!headIds.has(base.id)) continue
    result.bytes = spliceDeleteParagraph(result.bytes, base.id)
    headIds.delete(base.id)
    result.applied.push({ id: base.id, kind: 'removed' })
  }

  return result
}
