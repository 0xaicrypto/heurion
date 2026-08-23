/**
 * #diff-review: 把 AI 生成的整篇编辑应用到 DocEditor,并以 track-changes
 * 标记(插入=绿/删除=红)呈现,支持逐条/全部接受或拒绝。
 *
 * 机制:tiptap-track-changes 只拦截"用户输入"(uiEvent/composition),编程式
 * setContent 不会产生标记 — 这里自行计算文本域 diff,再用扩展的
 * setDeletion/setInsertion 命令与 dataTracked 节点属性手动应用标记。
 */
import { diffLines } from 'diff'
import type { Editor } from '@tiptap/core'
import type { ChangeAuthor } from 'tiptap-track-changes'
import { markdownToHtml } from '@/lib/doc-convert'

/** Flat text view of a PM doc that mirrors `getText({ blockSeparator: '\n' })`,
 *  recording each char offset → doc position so diffs can be mapped back. */
interface FlatIndex {
  text: string
  /** textOffset → doc pos (for the char at that offset) */
  toDoc: number[]
  /** block ranges (doc-pos based) for whole-block deletion detection */
  blocks: Array<{ from: number; to: number; text: string }>
}

function uid(): string {
  return `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function authorAttrs(author: ChangeAuthor, changeId: string): Record<string, string> {
  return {
    changeId,
    authorId: author.id,
    authorName: author.name,
    authorColor: author.color,
    timestamp: new Date().toISOString(),
  }
}

export function buildFlatIndex(editor: Editor): FlatIndex {
  const doc = editor.state.doc
  let text = ''
  const toDoc: number[] = []
  const blocks: Array<{ from: number; to: number; text: string }> = []
  let lastBlockEnd = -1

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) {
        toDoc.push(pos + i)
      }
      text += node.text
      return
    }
    if (node.isBlock) {
      if (blocks.length > 0 && pos >= lastBlockEnd) {
        text += '\n'
        // 分隔符占位(-1):保持 toDoc 与 flat 文本偏移严格对齐
        toDoc.push(-1)
      }
      const blockText = doc.textBetween(pos, pos + node.nodeSize, '\n')
      blocks.push({ from: pos, to: pos + node.nodeSize, text: blockText })
      lastBlockEnd = pos + node.nodeSize
    }
  })
  return { text, toDoc, blocks }
}

/** 把 flat-text 的字符区间映射为 doc 位置区间(按文本节点分段,跳过 -1 分隔符占位)。 */
function mapTextRange(idx: FlatIndex, from: number, to: number): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  let curFrom = -1
  let curTo = -1
  for (let o = from; o < to && o < idx.toDoc.length; o++) {
    const p = idx.toDoc[o]
    if (p < 0) {
      if (curFrom !== -1) {
        ranges.push({ from: curFrom, to: curTo })
        curFrom = -1
      }
      continue
    }
    if (curFrom === -1) {
      curFrom = p
      curTo = p + 1
      continue
    }
    if (p === curTo) {
      curTo = p + 1
    } else {
      ranges.push({ from: curFrom, to: curTo })
      curFrom = p
      curTo = p + 1
    }
  }
  if (curFrom !== -1) ranges.push({ from: curFrom, to: curTo })
  return ranges
}

/** flat-text offset → doc 位置(命中 -1 分隔符占位时后移取下一文本字符)。 */
function offsetToDocPos(idx: FlatIndex, offset: number): number {
  if (offset >= idx.toDoc.length) {
    // 文档末尾:取最后一个块之后的位置(不能用 toDoc[last]+1,会落进文本中间)
    return idx.blocks.length > 0 ? idx.blocks[idx.blocks.length - 1].to : 0
  }
  const p = idx.toDoc[offset]
  if (p >= 0) return p
  // 分隔符位置:向前找下一个文本字符
  for (let o = offset + 1; o < idx.toDoc.length; o++) {
    if (idx.toDoc[o] >= 0) return idx.toDoc[o]
  }
  return idx.blocks.length > 0 ? idx.blocks[idx.blocks.length - 1].to : 0
}

interface DeletionAction {
  changeId: string
  ranges: Array<{ from: number; to: number }>
  lines: string[]
}
interface InsertionAction {
  changeId: string
  at: number
  html: string
  addedText: string
}

/**
 * 核心:在 editor(当前内容为旧文档)上应用 AI 新文档的 diff,全部以
 * track-changes 标记呈现。返回应用的变更组数。
 */
export function applyTrackedDiff(
  editor: Editor,
  oldContentHtml: string,
  newContentHtml: string,
  author: ChangeAuthor,
): number {
  // 1) 装载旧内容
  editor.commands.setContent(oldContentHtml, { emitUpdate: false })
  const oldIdx = buildFlatIndex(editor)

  // 2) 计算新旧 flat 文本的行级 diff(新文本取自临时编辑器状态)
  editor.commands.setContent(newContentHtml, { emitUpdate: false })
  const newText = buildFlatIndex(editor).text
  editor.commands.setContent(oldContentHtml, { emitUpdate: false })
  // jsdiff 行尾敏感("X" ≠ "X\n")— 两侧统一以 \n 结尾归一化
  const oldFlat = oldIdx.text.endsWith('\n') ? oldIdx.text : oldIdx.text + '\n'
  const newFlat = newText.endsWith('\n') ? newText : newText + '\n'
  const changes = diffLines(oldFlat, newFlat)

  // 3) 把 hunk 归约为删除/插入动作(相邻 removed+added = 替换,共用 changeId)
  const deletions: DeletionAction[] = []
  const insertions: InsertionAction[] = []
  let oldOffset = 0
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]
    const next = changes[i + 1]
    if (change.removed) {
      const from = oldOffset
      const to = oldOffset + change.value.length
      oldOffset = to
      const changeId = uid()
      const ranges = mapTextRange(oldIdx, from, to)
      if (ranges.length > 0) {
        deletions.push({
          changeId,
          ranges,
          lines: change.value.split('\n').filter((l) => l !== ''),
        })
      }
      if (next && next.added) {
        // 替换:新增与删除共用一个 changeId(扩展按 changeId 分组配对)
        insertions.push({ changeId, at: from, html: '', addedText: next.value })
        i++
      }
    } else if (change.added) {
      insertions.push({ changeId: uid(), at: oldOffset, html: '', addedText: change.value })
    } else {
      oldOffset += change.value.length
    }
  }
  // 补充插入 HTML
  for (const ins of insertions) {
    ins.html = markdownToHtml(ins.addedText)
  }

  // 4) 先应用删除标记(纯标记,不改变结构),再倒序插入(结构性位移互不影响)
  for (const del of deletions) {
    applyDeletion(editor, del, oldIdx, author)
  }
  const positioned = insertions
    .map((ins) => ({ ...ins, docPos: offsetToDocPos(oldIdx, ins.at) }))
    .sort((a, b) => b.docPos - a.docPos)
  for (const ins of positioned) {
    applyInsertion(editor, ins.docPos, ins.html, ins.changeId, author, ins.addedText)
  }

  return deletions.length + insertions.length
}

function applyDeletion(editor: Editor, del: DeletionAction, idx: FlatIndex, author: ChangeAuthor) {
  const attrs = authorAttrs(author, del.changeId)
  const deletionMark = editor.state.schema.marks.deletion

  // 合并连续段(同一文本节点内跨 mark 的拆分)
  const merged: Array<{ from: number; to: number }> = []
  let cur = del.ranges[0]
  for (let i = 1; i < del.ranges.length; i++) {
    if (del.ranges[i].from <= cur.to) {
      cur = { from: cur.from, to: Math.max(cur.to, del.ranges[i].to) }
    } else {
      merged.push(cur)
      cur = del.ranges[i]
    }
  }
  merged.push(cur)

  // 统一用 deletion mark(扩展对 dataTracked 块的 getResultText 有上游 bug:
  // descendants 回调 return undefined 仍访问子节点,整块删除的文本会残留)。
  // 整块删除接受后留空段落,由 cleanupEmptyBlocks 在 accept/reject 后清理。
  for (const r of merged) {
    editor.view.dispatch(editor.state.tr.addMark(r.from, r.to, deletionMark.create(attrs)))
  }
  void idx
}

/**
 * accept/reject 后清理:删除标记的文本被移除后留下的空文本块
 * (如整段删除残留的空段落/空标题)。
 */
export function cleanupEmptyBlocks(editor: Editor) {
  const positions: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.content.size === 0 && !node.attrs.dataTracked) {
      positions.push(pos)
    }
    return true
  })
  let tr = editor.state.tr
  for (const pos of positions.sort((a, b) => b - a)) {
    tr = tr.delete(pos, pos + 1)
  }
  if (tr.docChanged) editor.view.dispatch(tr)
}

function applyInsertion(
  editor: Editor,
  docPos: number,
  html: string,
  changeId: string,
  author: ChangeAuthor,
  addedText: string,
) {
  if (!html.trim()) return
  const attrs = authorAttrs(author, changeId)
  // v3 的 insertContentAt 不再支持 updateSelection 选项 — 插入后按新增文本
  // 定位范围再打 insertion mark。
  editor.chain().insertContentAt(docPos, html).run()
  const needle = addedText.replace(/\n+$/, '')
  if (!needle) return
  const idx = buildFlatIndex(editor)
  const hintOffset = idx.toDoc.indexOf(docPos)
  const found = idx.text.indexOf(needle, hintOffset >= 0 ? hintOffset : 0)
  if (found === -1) return
  const ranges = mapTextRange(idx, found, found + needle.length)
  const insertionMark = editor.state.schema.marks.insertion
  for (const r of ranges) {
    editor.view.dispatch(editor.state.tr.addMark(r.from, r.to, insertionMark.create(attrs)))
  }
}
