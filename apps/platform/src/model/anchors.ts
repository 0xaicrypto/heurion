import type { Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import type { CommentRow } from '../store/db.ts'
import { indexById } from './ids.ts'
import { plainText } from './markdown.ts'

/**
 * 评论锚点（PLATFORM.md §4.1）：有文字的锚点是 comment(thread) mark，挂在 Yjs 文本上，
 * 跨编辑不漂移；无文字的块（图、不可编辑块）锚在块 id 上。
 */

export interface AnchorLocation {
  located: boolean
  /** 锚点所在的块（mark 跨多个块时取全部）。 */
  node_ids: string[]
  /** 当前被锚定的文字。 */
  text: string
}

/** 文档中每条线程 mark 覆盖的块与文字。 */
export function threadMarks(doc: PMNode): Map<string, { node_ids: string[]; text: string }> {
  const out = new Map<string, { node_ids: string[]; text: string }>()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // 文本块自己没有 id（deck 形状里的段落）：归到最近的带 id 的祖先
    let id = node.attrs.id as string | null | undefined
    if (!id) {
      const $pos = doc.resolve(pos)
      for (let d = $pos.depth; d > 0 && !id; d--) id = $pos.node(d).attrs.id as string | null | undefined
    }
    if (!id) return false
    node.forEach(child => {
      for (const m of child.marks) {
        if (m.type.name !== 'comment') continue
        const thread = m.attrs.thread as string
        const entry = out.get(thread) ?? { node_ids: [], text: '' }
        if (!entry.node_ids.includes(id!)) entry.node_ids.push(id!)
        entry.text += child.isText ? child.text : ''
        out.set(thread, entry)
      }
    })
    return false
  })
  return out
}

export function locate(doc: PMNode, comment: Pick<CommentRow, 'id' | 'node_id' | 'snippet'>, marks = threadMarks(doc)): AnchorLocation {
  const hit = marks.get(comment.id)
  if (hit) return { located: true, node_ids: hit.node_ids, text: hit.text }
  // 无 mark 的块级锚点：块还在即定位
  if (!comment.snippet) {
    const node = indexById(doc).get(comment.node_id)
    return node ? { located: true, node_ids: [comment.node_id], text: plainText(node.node).slice(0, 200) } : { located: false, node_ids: [], text: '' }
  }
  return { located: false, node_ids: [], text: '' }
}

export class AnchorError extends Error {}

/**
 * 给新评论打锚点：在块 nodeId 的文字里找 snippet，挂上 thread mark。
 * snippet 为空 → 文本块整段挂 mark；无文字的块不挂 mark（块级锚点）。
 */
export function attachComment(doc: PMNode, nodeId: string, snippet: string, thread: string): { doc: PMNode; snippet: string } {
  const hit = indexById(doc).get(nodeId)
  if (!hit) throw new AnchorError(`找不到块 ${nodeId}`)
  const { node, pos } = hit
  const textblocks: Array<{ node: PMNode; pos: number }> = []
  if (node.isTextblock) textblocks.push({ node, pos })
  else node.descendants((n, p) => { if (n.isTextblock) textblocks.push({ node: n, pos: pos + 1 + p }); return !n.isTextblock })
  if (textblocks.length === 0) return { doc, snippet: '' }
  // 用文档自己的 schema（doc / deck 各有一套）
  const mark = doc.type.schema.marks.comment!.create({ thread })
  const tr = new Transform(doc)
  const whole = () => {
    for (const tb of textblocks) if (tb.node.content.size > 0) tr.addMark(tb.pos + 1, tb.pos + tb.node.nodeSize - 1, mark)
    return { doc: tr.doc, snippet: plainText(node).slice(0, 200) }
  }
  if (!snippet.trim()) return whole()
  // 在整个块（可能有多个段落、换行）的文字里找，忽略空白与换行：浏览器选区跨段落时带的是换行
  let text = ''
  const positions: number[] = []
  for (const tb of textblocks) {
    tb.node.forEach((child, offset) => {
      if (!child.isText) return
      for (let i = 0; i < child.text!.length; i++) {
        if (/\s/.test(child.text![i]!)) continue
        text += child.text![i]
        positions.push(tb.pos + 1 + offset + i)
      }
    })
  }
  const needle = snippet.replace(/\s+/g, '')
  const at = text.indexOf(needle)
  if (at === -1) throw new AnchorError(`块 ${nodeId} 中找不到选中的文字`)
  tr.addMark(positions[at]!, positions[at + needle.length - 1]! + 1, mark)
  return { doc: tr.doc, snippet: snippet.trim() }
}
