import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { assignIds, indexById, stripIds } from '../model/ids.ts'
import { MarkdownError, parseBlocks, parseInline, serializeBlock } from '../model/markdown.ts'
import { schema } from '../model/schema.ts'
import { OpError, type DocOp } from './types.ts'

export interface OpResult {
  op_index: number
  op: DocOp['op']
  /** 新增块的 id，或被修改 / 移动的块 id。 */
  ids: string[]
}

export interface ApplyContext {
  /** 文档里已占用的 id（新分配的 id 会加入）。 */
  taken: Set<string>
}

/**
 * 在内存里把一批操作应用到文档上（纯函数，不落库）。任何一个 op 失败即抛 OpError，
 * 调用方整批放弃（原子性）。
 */
export function applyOps(doc: PMNode, ops: DocOp[], ctx: ApplyContext): { doc: PMNode; results: OpResult[] } {
  const tr = new Transform(doc)
  const results: OpResult[] = []
  ops.forEach((op, index) => {
    try {
      results.push({ op_index: index, op: op.op, ids: applyOne(tr, op, ctx) })
    } catch (err) {
      if (err instanceof OpError) throw new OpError(err.code, err.message, { op_index: index, ...err.extra })
      if (err instanceof MarkdownError) throw new OpError('invalid_markdown', err.message, { op_index: index })
      throw new OpError('invalid_structure', `操作无法应用：${(err as Error).message}`, { op_index: index })
    }
  })
  try {
    tr.doc.check()
  } catch (err) {
    throw new OpError('invalid_structure', `操作后的文档结构不合法：${(err as Error).message}`)
  }
  return { doc: tr.doc, results }
}

function find(tr: Transform, id: string): { node: PMNode; pos: number } {
  const hit = indexById(tr.doc).get(id)
  if (!hit) {
    throw new OpError('node_not_found', `找不到块 ${id}`, { hint: '先用 doc_outline / doc_read 获取当前的块 id；id 区分大小写，不要自己编造。' })
  }
  return hit
}

function parseNew(markdown: string, taken: Set<string>): PMNode[] {
  return parseBlocks(markdown).map(n => assignIds(stripIds(n), taken))
}

function topIds(nodes: readonly PMNode[]): string[] {
  return nodes.map(n => n.attrs.id as string).filter(Boolean)
}

function applyOne(tr: Transform, op: DocOp, ctx: ApplyContext): string[] {
  switch (op.op) {
    case 'insert_after':
    case 'insert_before':
      return insert(tr, op.anchor_id, op.markdown, op.op === 'insert_after', ctx)
    case 'replace_block':
      return replaceBlock(tr, op.id, op.markdown, ctx)
    case 'replace_text':
      return replaceText(tr, op)
    case 'delete':
      for (const id of op.ids) deleteBlock(tr, id, ctx)
      return op.ids
    case 'move':
      return move(tr, op.ids, op.after)
    case 'set_block_style':
      return setStyle(tr, op)
    case 'table_set_cells':
    case 'table_insert_rows':
    case 'table_delete_rows':
      return tableOp(tr, op, ctx)
  }
}

function insert(tr: Transform, anchorId: string, markdown: string, after: boolean, ctx: ApplyContext): string[] {
  const anchor = find(tr, anchorId)
  let nodes = parseNew(markdown, ctx.taken)
  if (nodes.length === 0) throw new OpError('invalid_markdown', 'markdown 解析后为空')
  const $pos = tr.doc.resolve(anchor.pos)
  const parent = $pos.parent
  const index = $pos.index()
  // 锚点是列表项、内容是一个列表 → 插入其中的列表项
  if (anchor.node.type.name === 'list_item' && nodes.length === 1 && /_list$/.test(nodes[0]!.type.name)) {
    const items: PMNode[] = []
    nodes[0]!.forEach(c => items.push(c))
    nodes = items
  }
  const at = after ? index + 1 : index
  const fragment = Fragment.from(nodes)
  if (!parent.canReplace(at, at, fragment)) {
    throw new OpError('invalid_structure', `不能把这些内容插在 ${anchorId} ${after ? '之后' : '之前'}`, {
      hint: anchor.node.type.name === 'list_item'
        ? '锚点是列表项：插入列表项请用 "- 内容" 形式；要在整个列表前后插入段落，请用列表本身的 id。'
        : '检查锚点所在的容器（如表格单元格、列表项）是否接受该类型的块。',
    })
  }
  tr.insert(after ? anchor.pos + anchor.node.nodeSize : anchor.pos, fragment)
  return topIds(nodes)
}

function replaceBlock(tr: Transform, id: string, markdown: string, ctx: ApplyContext): string[] {
  const target = find(tr, id)
  if (target.node.type.name === 'opaque') {
    throw new OpError('node_not_editable', `块 ${id} 是不可编辑内容（${target.node.attrs.description}）`, { hint: '不可编辑块只能移动或删除。' })
  }
  let nodes = parseNew(markdown, ctx.taken)
  if (target.node.type.name === 'list_item' && nodes.length === 1 && /_list$/.test(nodes[0]!.type.name)) {
    const items: PMNode[] = []
    nodes[0]!.forEach(c => items.push(c))
    nodes = items
  }
  // 第一个块沿用原 id（同类可互换：段落 ↔ 标题）
  if (nodes.length > 0) {
    const first = nodes[0]!
    const compatible = first.type === target.node.type || (first.isTextblock && target.node.isTextblock)
    if (compatible) {
      ctx.taken.delete(first.attrs.id as string)
      const attrs: Record<string, unknown> = { ...first.attrs, id }
      // 保留原段落样式与对齐（markdown 不表达）
      if (target.node.isTextblock && first.type === target.node.type) {
        attrs.style = target.node.attrs.style
        attrs.align = target.node.attrs.align
      }
      nodes[0] = first.type.create(attrs, first.content, first.marks)
    }
  }
  const $pos = tr.doc.resolve(target.pos)
  const index = $pos.index()
  const fragment = Fragment.from(nodes)
  if (!$pos.parent.canReplace(index, index + 1, fragment)) {
    throw new OpError('invalid_structure', `块 ${id} 不能替换成这些内容`, {
      hint: nodes.length === 0 ? '替换为空会让容器变空；要删除请用 delete。' : '检查块类型是否适合所在容器。',
    })
  }
  tr.replaceWith(target.pos, target.pos + target.node.nodeSize, fragment)
  return topIds(nodes)
}

/** 块内字符 → 文档位置的映射。citation 以 `[@c:id]` 参与匹配，hard_break 记作换行。 */
function textMap(node: PMNode, nodePos: number): { text: string; from: number[]; to: number[]; marks: Array<readonly Mark[]>; cite: boolean[] } {
  let text = ''
  const from: number[] = []
  const to: number[] = []
  const marks: Array<readonly Mark[]> = []
  const cite: boolean[] = []
  node.forEach((child, offset) => {
    const start = nodePos + 1 + offset
    if (child.isText) {
      for (let i = 0; i < child.text!.length; i++) {
        text += child.text![i]
        from.push(start + i)
        to.push(start + i + 1)
        marks.push(child.marks)
        cite.push(false)
      }
    } else {
      const s = child.type.name === 'citation' ? `[@c:${child.attrs.cite_id}]` : child.type.name === 'hard_break' ? '\n' : '￼'
      for (const ch of s) {
        text += ch
        from.push(start)
        to.push(start + child.nodeSize)
        marks.push(child.marks)
        cite.push(child.type.name === 'citation')
      }
    }
  })
  return { text, from, to, marks, cite }
}

/** 去掉引用标记后的文字，index[i] = 去标记文字第 i 个字符在原映射里的下标。 */
function stripCitations(map: ReturnType<typeof textMap>): { text: string; index: number[] } {
  let text = ''
  const index: number[] = []
  for (let i = 0; i < map.text.length; i++) {
    if (map.cite[i]) continue
    text += map.text[i]
    index.push(i)
  }
  return { text, index }
}

/**
 * find 跨过了引用标记、而 replace 只是在 find 前 / 后追加文字时：不动原文（保留引用），
 * 只把追加的部分插到匹配处之后 / 之前。处理不了返回 false。
 */
function appendAcrossCitation(tr: Transform, map: ReturnType<typeof textMap>, op: ReplaceArgs, parse: InlineParser): boolean {
  const stripped = stripCitations(map)
  for (const v of findVariants(op.find)) {
    const find = v.replace(/\[@c:[a-z0-9]+\]/g, '')
    if (!find) continue
    const hits = allIndexes(stripped.text, find)
    if (hits.length === 0) continue
    if (hits.length > 1 && op.occurrence === undefined) return false
    const at = hits[(op.occurrence ?? 1) - 1]
    if (at === undefined) return false
    const startIdx = stripped.index[at]!
    const endIdx = stripped.index[at + find.length - 1]!
    let addition: string | null = null
    let after = true
    if (op.replace.startsWith(v)) addition = op.replace.slice(v.length)
    else if (op.replace.endsWith(v)) { addition = op.replace.slice(0, op.replace.length - v.length); after = false }
    if (addition === null || !addition) return false
    const base = map.marks[after ? endIdx : startIdx]!.filter(m => m.type.name !== 'comment')
    const inline = parse(addition).map(n => {
      let set = n.marks
      for (const m of base) if (!m.isInSet(set)) set = m.addToSet(set)
      return n.isText ? n.mark(set) : n
    })
    // 插在匹配末尾所在位置之后（若末尾紧跟引用，插在引用之后）
    let pos = after ? map.to[endIdx]! : map.from[startIdx]!
    if (after) for (let i = endIdx + 1; i < map.text.length && map.cite[i]; i++) pos = map.to[i]!
    tr.insert(pos, inline)
    return true
  }
  return false
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** find 的候选写法：原样 → 去 markdown 转义与 <br> → 去强调符号。 */
function findVariants(find: string): string[] {
  const unescaped = find.replace(/<br\s*\/?>/gi, '\n').replace(/\\([\\*_`[\]<>])/g, '$1').replace(/&lt;/g, '<')
  const plain = unescaped.replace(/\*\*|__|(?<![\w*])\*(?!\s)|(?<!\s)\*(?![\w*])/g, '')
  return [...new Set([find, unescaped, plain])]
}

export type InlineParser = (markdown: string) => PMNode[]
export interface ReplaceArgs { find: string; replace: string; occurrence?: number }
export type ReplaceOutcome =
  | { ok: true }
  | { ok: false; code: 'text_not_found'; crossesCitation: boolean }
  | { ok: false; code: 'ambiguous_match'; count: number }
  | { ok: false; code: 'occurrence_out_of_range'; count: number }

/**
 * 在一个文本块（doc 段落 / 标题，deck 形状里的段落）内做 replace_text：匹配原文（容忍 markdown 转义），
 * 替换文字继承匹配起点的格式，评论锚点跟随；find 跳过引用标记且只是追加时保留引用。
 */
export function replaceInTextblock(tr: Transform, node: PMNode, pos: number, op: ReplaceArgs, parse: InlineParser): ReplaceOutcome {
  const map = textMap(node, pos)
  let needle = ''
  let hits: number[] = []
  for (const v of findVariants(op.find)) {
    hits = allIndexes(map.text, v)
    if (hits.length > 0) { needle = v; break }
  }
  if (hits.length === 0) {
    // 常见失配：find 跳过了句中的引用标记（原文「…）[@c:x]。」，find 写成「…）。」）
    if (appendAcrossCitation(tr, map, op, parse)) return { ok: true }
    const crossesCitation = findVariants(op.find).some(v => {
      const stripped = v.replace(/\[@c:[a-z0-9]+\]/g, '')
      return stripped.length > 0 && stripCitations(map).text.includes(stripped)
    })
    return { ok: false, code: 'text_not_found', crossesCitation }
  }
  if (hits.length > 1 && op.occurrence === undefined) return { ok: false, code: 'ambiguous_match', count: hits.length }
  const start = hits[(op.occurrence ?? 1) - 1]
  if (start === undefined) return { ok: false, code: 'occurrence_out_of_range', count: hits.length }
  const end = start + needle.length - 1
  const from = map.from[start]!
  const to = map.to[end]!
  // 替换文本继承匹配起点的格式（评论锚点 mark 除外），再叠加替换文本自带的格式
  const base = map.marks[start]!.filter(m => m.type.name !== 'comment')
  let inline = parse(op.replace).map(n => {
    let set = n.marks
    for (const m of base) if (!m.isInSet(set)) set = m.addToSet(set)
    return n.isText ? n.mark(set) : n
  })
  inline = carryComments(node, inline, map, start, end)
  if (inline.length === 0) tr.delete(from, to)
  else tr.replaceWith(from, to, inline)
  return { ok: true }
}

/** replace_text 失败时的结构化错误。 */
export function replaceError(outcome: Exclude<ReplaceOutcome, { ok: true }>, where: string, current: string): OpError {
  if (outcome.code === 'ambiguous_match') {
    return new OpError('ambiguous_match', `原文在${where}中出现 ${outcome.count} 次`, { hint: '用 occurrence 指定第几处（从 1 开始），或把 find 写长一些。' })
  }
  if (outcome.code === 'occurrence_out_of_range') return new OpError('text_not_found', `原文只出现 ${outcome.count} 次`)
  return new OpError('text_not_found', `${where}中找不到要替换的原文`, {
    hint: outcome.crossesCitation
      ? '原文在这段文字中间有引用标记 [@c:…]：find 与 replace 里要原样写出引用标记（否则会删掉引用），或者只匹配引用标记之前 / 之后的文字。'
      : '按 current 中的原文逐字复制 find（不含 {#id} 前缀和 markdown 符号）。',
    current,
  })
}

function replaceText(tr: Transform, op: Extract<DocOp, { op: 'replace_text' }>): string[] {
  const target = find(tr, op.id)
  if (!target.node.isTextblock) {
    throw new OpError('invalid_structure', `replace_text 只能用于段落或标题，${op.id} 是 ${target.node.type.name}`, {
      hint: target.node.type.name === 'list_item' ? '列表项的文字请用列表项 id 配合 replace_block。' : '表格请用 table_set_cells；其他块用 replace_block。',
    })
  }
  const outcome = replaceInTextblock(tr, target.node, target.pos, op, parseInline)
  if (!outcome.ok) throw replaceError(outcome, `块 ${op.id} `, serializeBlock(target.node, { ids: true }, ''))
  return [op.id]
}

/**
 * 评论锚点跟随替换（PLATFORM.md §5.3 锚点保护）：对与匹配范围相交的每条线程——
 * 替换文字里原样包含被锚定的那段文字 → 锚点精确落回这段文字；
 * 线程整体落在匹配范围内且被改写 → 锚点跟到整段替换文字；
 * 只部分重叠且被改写 → 不加（范围外的剩余文字继续承担锚点）。
 */
function carryComments(block: PMNode, inline: PMNode[], map: ReturnType<typeof textMap>, start: number, end: number): PMNode[] {
  if (inline.length === 0) return inline
  const threads = new Map<string, Mark>()
  for (let i = start; i <= end; i++) for (const m of map.marks[i]!) if (m.type.name === 'comment') threads.set(m.attrs.thread as string, m)
  if (threads.size === 0) return inline
  const paragraph = block.type.create(null, inline)
  const tr = new Transform(block.type.schema.topNodeType.create(null, [paragraph]))
  const replaced = textMap(paragraph, 0)
  for (const [thread, mark] of threads) {
    const has = (i: number) => map.marks[i]!.some(m => m.type.name === 'comment' && m.attrs.thread === thread)
    const inside: number[] = []
    let outside = false
    for (let i = 0; i < map.text.length; i++) {
      if (!has(i)) continue
      if (i >= start && i <= end) inside.push(i)
      else outside = true
    }
    const anchored = map.text.slice(inside[0]!, inside[inside.length - 1]! + 1)
    const at = anchored ? replaced.text.indexOf(anchored) : -1
    if (at !== -1) tr.addMark(replaced.from[at]!, replaced.to[at + anchored.length - 1]!, mark)
    else if (!outside) tr.addMark(1, paragraph.nodeSize - 1, mark)
  }
  const out: PMNode[] = []
  tr.doc.child(0).forEach(n => out.push(n))
  return out
}

function deleteBlock(tr: Transform, id: string, ctx: ApplyContext): void {
  const target = find(tr, id)
  const $pos = tr.doc.resolve(target.pos)
  const parent = $pos.parent
  const index = $pos.index()
  if (parent.canReplace(index, index + 1, Fragment.empty)) {
    tr.delete(target.pos, target.pos + target.node.nodeSize)
    return
  }
  if (parent.type.name === 'doc') {
    // 删掉最后一个块：留一个空段落
    tr.replaceWith(target.pos, target.pos + target.node.nodeSize, assignIds(schema.node('paragraph'), ctx.taken))
    return
  }
  throw new OpError('invalid_structure', `删除 ${id} 会让所在的${parent.type.name === 'list_item' ? '列表项' : parent.type.name}变空`, {
    hint: '改为删除外层的块（例如整个列表或列表项）。',
  })
}

function move(tr: Transform, ids: string[], after: string | null): string[] {
  if (after !== null && ids.includes(after)) throw new OpError('invalid_structure', '不能把块移动到自己之后')
  const nodes = ids.map(id => find(tr, id).node)
  // 从后往前删，位置不受影响
  const positions = ids.map(id => ({ id, ...find(tr, id) })).sort((a, b) => b.pos - a.pos)
  for (const p of positions) {
    const $pos = tr.doc.resolve(p.pos)
    if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.empty)) {
      throw new OpError('invalid_structure', `移走 ${p.id} 会让所在容器变空`)
    }
    tr.delete(p.pos, p.pos + p.node.nodeSize)
  }
  let at: number
  let parent: PMNode
  let index: number
  if (after === null) {
    at = 0
    parent = tr.doc
    index = 0
  } else {
    const anchor = find(tr, after)
    const $pos = tr.doc.resolve(anchor.pos)
    at = anchor.pos + anchor.node.nodeSize
    parent = $pos.parent
    index = $pos.index() + 1
  }
  const fragment = Fragment.from(nodes)
  if (!parent.canReplace(index, index, fragment)) {
    throw new OpError('invalid_structure', `这些块不能放在 ${after ?? '文档开头'} 之后的位置`)
  }
  tr.insert(at, fragment)
  return ids
}

function setStyle(tr: Transform, op: Extract<DocOp, { op: 'set_block_style' }>): string[] {
  const target = find(tr, op.id)
  if (!target.node.isTextblock) throw new OpError('invalid_structure', `set_block_style 只能用于段落或标题，${op.id} 是 ${target.node.type.name}`)
  const typeName = op.type ?? (op.level !== undefined ? 'heading' : target.node.type.name)
  const type = schema.nodes[typeName]!
  const attrs: Record<string, unknown> = { id: op.id, style: target.node.attrs.style, align: target.node.attrs.align }
  if (typeName === 'heading') attrs.level = op.level ?? (target.node.attrs.level as number | undefined) ?? 1
  if (op.align !== undefined) attrs.align = op.align
  if (op.style !== undefined) attrs.style = op.style
  tr.setNodeMarkup(target.pos, type, attrs)
  return [op.id]
}

function cellNode(markdown: string, attrs: Record<string, unknown>, taken: Set<string>): PMNode {
  const inline = parseInline(markdown)
  return schema.node('table_cell', attrs, [assignIds(schema.node('paragraph', null, inline), taken)])
}

function tableOp(tr: Transform, op: Extract<DocOp, { op: 'table_set_cells' | 'table_insert_rows' | 'table_delete_rows' }>, ctx: ApplyContext): string[] {
  const target = find(tr, op.id)
  if (target.node.type.name !== 'table') throw new OpError('invalid_structure', `${op.id} 不是表格`)
  const rows: PMNode[][] = []
  target.node.forEach(row => {
    const cells: PMNode[] = []
    row.forEach(c => cells.push(c))
    rows.push(cells)
  })
  const width = Math.max(...rows.map(r => r.length))
  if (op.op === 'table_set_cells') {
    for (const c of op.cells) {
      const cell = rows[c.row]?.[c.col]
      if (!cell) throw new OpError('cell_not_found', `表格 ${op.id} 没有单元格 (${c.row}, ${c.col})`, { hint: `表格共 ${rows.length} 行；行列下标从 0 开始。` })
      rows[c.row]![c.col] = cellNode(c.markdown, cell.attrs, ctx.taken)
    }
  } else if (op.op === 'table_insert_rows') {
    if (op.at > rows.length) throw new OpError('cell_not_found', `插入位置 ${op.at} 超出表格行数 ${rows.length}`)
    const fresh = op.rows.map(r => Array.from({ length: Math.max(width, r.length) }, (_, i) => cellNode(r[i] ?? '', {}, ctx.taken)))
    rows.splice(op.at, 0, ...fresh)
  } else {
    if (op.at + op.count > rows.length) throw new OpError('cell_not_found', `要删除的行超出表格范围（共 ${rows.length} 行）`)
    if (op.count >= rows.length) throw new OpError('invalid_structure', '不能删除表格的全部行', { hint: '要删除整张表请用 delete。' })
    rows.splice(op.at, op.count)
  }
  const table = schema.node('table', target.node.attrs, rows.map(cells => schema.node('table_row', null, cells)))
  tr.replaceWith(target.pos, target.pos + target.node.nodeSize, table)
  return [op.id]
}
