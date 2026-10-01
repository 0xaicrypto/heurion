import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { z } from 'zod'
import { deckSchema, emu, pt } from '../model/deck-schema.ts'
import { assignIds, indexById } from '../model/ids.ts'
import { MarkdownError, parseBlocks, parseInline } from '../model/markdown.ts'
import { replaceError, replaceInTextblock } from './apply.ts'
import { OpError } from './types.ts'

/** deck_edit 的操作（PLATFORM.md §7 MCP 面）。几何单位 pt。 */
export const DeckOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_slide'),
    after: z.string().nullable().describe('插在该页之后；null 表示开头'),
    layout: z.string().optional().describe('版式名（slide_read / doc_outline 列出的可用版式）；缺省为「标题和内容」类版式'),
    title: z.string().optional().describe('标题占位符的文字'),
    body: z.string().optional().describe('正文占位符的 markdown（列表项 - 对应项目符号，缩进对应级别）'),
  }),
  z.object({ op: z.literal('delete_slide'), slide_id: z.string() }),
  z.object({ op: z.literal('move_slide'), slide_id: z.string(), after: z.string().nullable() }),
  z.object({ op: z.literal('set_text'), shape_id: z.string(), markdown: z.string().describe('形状的全部文字；沿用原有字号、颜色与段落格式') }),
  z.object({
    op: z.literal('replace_text'),
    shape_id: z.string(),
    find: z.string().min(1),
    replace: z.string(),
    occurrence: z.number().int().min(1).optional(),
  }),
  z.object({
    op: z.literal('add_shape'),
    slide_id: z.string(),
    markdown: z.string().describe('文本框的文字'),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    font_size: z.number().positive().optional().describe('字号（pt），缺省 18'),
  }),
  z.object({
    op: z.literal('set_xfrm'),
    shape_id: z.string(),
    x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), h: z.number().positive().optional(),
  }),
  z.object({ op: z.literal('delete_shape'), shape_id: z.string() }),
  z.object({ op: z.literal('set_notes'), slide_id: z.string(), markdown: z.string() }),
  z.object({
    op: z.literal('table_set_cells'),
    shape_id: z.string(),
    cells: z.array(z.object({ row: z.number().int().min(0), col: z.number().int().min(0), markdown: z.string() })).min(1),
  }),
])
export type DeckOp = z.infer<typeof DeckOp>

export const DeckEditBatch = z.object({
  doc_id: z.string(),
  base_rev: z.number().int().min(0),
  mode: z.enum(['apply', 'suggest']).default('apply'),
  ack_comments: z.array(z.string()).optional(),
  ops: z.array(DeckOp).min(1).max(50),
})
export type DeckEditBatch = z.infer<typeof DeckEditBatch>

export interface LayoutInfo {
  name: string
  part: string
  placeholders: Array<{ type: string; idx: string | null; x: number; y: number; w: number; h: number }>
}

export interface DeckContext {
  taken: Set<string>
  layouts: LayoutInfo[]
  size: { cx: number; cy: number }
}

export function deckTargetIds(op: DeckOp): string[] {
  switch (op.op) {
    case 'add_slide': case 'add_shape': return []
    case 'delete_slide': case 'move_slide': case 'set_notes': return [op.slide_id]
    default: return [op.shape_id]
  }
}

export function deckOpTexts(op: DeckOp): string[] {
  switch (op.op) {
    case 'add_slide': return [op.title ?? '', op.body ?? '']
    case 'set_text': case 'add_shape': case 'set_notes': return [op.markdown]
    case 'replace_text': return [op.replace]
    case 'table_set_cells': return op.cells.map(c => c.markdown)
    default: return []
  }
}

// —— markdown → deck 段落 ——

/** doc schema 的行内节点 → deck schema（同名 mark / 节点），叠加模板格式。 */
function toDeckInline(nodes: readonly PMNode[], rpr: Mark | null): PMNode[] {
  return nodes.map(n => {
    let marks: readonly Mark[] = n.marks.flatMap(m => {
      const type = deckSchema.marks[m.type.name]
      return type ? [type.create(m.attrs)] : []
    })
    if (rpr && n.isText && !marks.some(m => m.type.name === 'rpr')) marks = rpr.addToSet(marks)
    if (n.isText) return deckSchema.text(n.text!, marks)
    if (n.type.name === 'citation') return deckSchema.node('citation', { cite_id: n.attrs.cite_id })
    return deckSchema.node('hard_break')
  })
}

interface Template { ppr: (lvl: number) => string | null; rpr: Mark | null }

function templateOf(shape: PMNode | null): Template {
  const pprs: Array<string | null> = []
  let rpr: Mark | null = null
  shape?.descendants(n => {
    if (n.type.name === 'paragraph') pprs[n.attrs.lvl as number] ??= n.attrs.ppr as string | null
    if (n.isText && !rpr) rpr = n.marks.find(m => m.type.name === 'rpr') ?? null
    return true
  })
  return { ppr: lvl => pprs[lvl] ?? pprs[0] ?? null, rpr }
}

/** markdown → 段落：标题 / 段落各成一段，列表项按嵌套深度设 lvl。 */
export function deckParagraphs(markdown: string, template: Template): PMNode[] {
  const out: PMNode[] = []
  const walk = (node: PMNode, depth: number) => {
    if (node.isTextblock) {
      out.push(deckSchema.node('paragraph', { lvl: depth, ppr: template.ppr(depth) }, toDeckInline(contentOf(node), template.rpr)))
      return
    }
    if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
      node.forEach(item => item.forEach(child => walk(child, /_list$/.test(child.type.name) ? depth + 1 : depth)))
      return
    }
    node.forEach(child => walk(child, depth))
  }
  for (const block of parseBlocks(markdown)) {
    walk(block, /_list$/.test(block.type.name) ? 1 : 0)
  }
  // 顶层列表在幻灯片里就是项目符号段落：从 lvl 0 开始
  const minLvl = Math.min(...out.map(p => p.attrs.lvl as number), 99)
  return out.map(p => minLvl > 0 ? p.type.create({ ...p.attrs, lvl: (p.attrs.lvl as number) - minLvl, ppr: template.ppr((p.attrs.lvl as number) - minLvl) }, p.content) : p)
}

function contentOf(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach(c => out.push(c))
  return out
}

const deckInlineParser = (template: Template) => (md: string) => toDeckInline(parseInline(md), template.rpr)

// —— 应用 ——

function find(tr: Transform, id: string, kind: 'slide' | 'shape'): { node: PMNode; pos: number } {
  const hit = indexById(tr.doc).get(id)
  if (!hit || hit.node.type.name !== kind) {
    throw new OpError('node_not_found', `找不到${kind === 'slide' ? '幻灯片' : '形状'} ${id}`, { hint: '先用 doc_outline / slide_read 获取当前的 id。' })
  }
  return hit
}

const EDITABLE_TEXT = new Set(['text', 'shape'])

export function applyDeckOps(doc: PMNode, ops: DeckOp[], ctx: DeckContext): { doc: PMNode; results: Array<{ op_index: number; op: string; ids: string[] }> } {
  const tr = new Transform(doc)
  const results: Array<{ op_index: number; op: string; ids: string[] }> = []
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
    throw new OpError('invalid_structure', `操作后的结构不合法：${(err as Error).message}`)
  }
  return { doc: tr.doc, results }
}

function pickLayout(ctx: DeckContext, name?: string): LayoutInfo | null {
  if (ctx.layouts.length === 0) return null
  if (name) {
    const n = name.toLowerCase()
    const hit = ctx.layouts.find(l => l.name.toLowerCase() === n) ?? ctx.layouts.find(l => l.name.toLowerCase().includes(n))
    if (!hit) throw new OpError('layout_not_found', `没有版式「${name}」`, { hint: `可用版式：${ctx.layouts.map(l => l.name).join('、')}` })
    return hit
  }
  return ctx.layouts.find(l => /title and content|标题和内容/i.test(l.name))
    ?? ctx.layouts.find(l => l.placeholders.some(p => p.type === 'title') && l.placeholders.some(p => p.type === 'body' || p.type === 'obj'))
    ?? ctx.layouts[0]!
}

function applyOne(tr: Transform, op: DeckOp, ctx: DeckContext): string[] {
  switch (op.op) {
    case 'add_slide': {
      const layout = pickLayout(ctx, op.layout)
      const shapes: PMNode[] = []
      const add = (ph: LayoutInfo['placeholders'][number], markdown: string) => {
        const paragraphs = deckParagraphs(markdown, { ppr: () => null, rpr: null })
        shapes.push(deckSchema.node('shape', {
          kind: 'text', ph: ph.type, ph_idx: ph.idx, x: ph.x, y: ph.y, w: ph.w, h: ph.h, xfrm_inherited: true,
          name: ph.type === 'title' || ph.type === 'ctrTitle' ? 'Title' : 'Content',
        }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')]))
      }
      const title = layout?.placeholders.find(p => p.type === 'title' || p.type === 'ctrTitle')
      const body = layout?.placeholders.find(p => p.type === 'body' || p.type === 'obj' || p.type === 'subTitle')
      if (title && op.title !== undefined) add(title, op.title)
      if (body && op.body !== undefined) add(body, op.body)
      if (!layout && (op.title || op.body)) {
        // 没有版式（不应发生）：用文本框兜底
        if (op.title) shapes.push(textBox(op.title, { x: 40, y: 30, w: pt(ctx.size.cx) - 80, h: 60 }, 32))
        if (op.body) shapes.push(textBox(op.body, { x: 40, y: 110, w: pt(ctx.size.cx) - 80, h: pt(ctx.size.cy) - 150 }, 20))
      }
      const slide = assignIds(deckSchema.node('slide', { layout: layout?.part ?? null, layout_name: layout?.name ?? '' }, shapes), ctx.taken)
      insertSlide(tr, slide, op.after)
      return [slide.attrs.id as string, ...contentOf(slide).map(s => s.attrs.id as string)]
    }
    case 'delete_slide': {
      const hit = find(tr, op.slide_id, 'slide')
      if (tr.doc.childCount === 1) throw new OpError('invalid_structure', '不能删除最后一页')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      return [op.slide_id]
    }
    case 'move_slide': {
      if (op.after === op.slide_id) throw new OpError('invalid_structure', '不能移动到自己之后')
      const hit = find(tr, op.slide_id, 'slide')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      insertSlide(tr, hit.node, op.after)
      return [op.slide_id]
    }
    case 'set_text': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string)) throw notEditable(hit.node)
      const paragraphs = deckParagraphs(op.markdown, templateOf(hit.node))
      const next = hit.node.type.create({ ...hit.node.attrs, kind: 'text' }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, next)
      return [op.shape_id]
    }
    case 'replace_text': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string) && hit.node.attrs.kind !== 'table') throw notEditable(hit.node)
      const parse = deckInlineParser(templateOf(hit.node))
      let last: Exclude<ReturnType<typeof replaceInTextblock>, { ok: true }> | null = null
      let done = false
      hit.node.descendants((node, offset) => {
        if (done || node.type.name !== 'paragraph') return !done
        const outcome = replaceInTextblock(tr, node, hit.pos + 1 + offset, op, parse)
        if (outcome.ok) done = true
        else if (outcome.code !== 'text_not_found' || !last) last = outcome
        return false
      })
      if (!done) throw replaceError(last ?? { ok: false, code: 'text_not_found', crossesCitation: false }, `形状 ${op.shape_id} `, hit.node.textContent)
      return [op.shape_id]
    }
    case 'add_shape': {
      const hit = find(tr, op.slide_id, 'slide')
      const shape = assignIds(textBox(op.markdown, op, op.font_size ?? 18), ctx.taken)
      // 插在备注之前（slide 内容：shape* notes?）
      const last = hit.node.lastChild
      const at = last?.type.name === 'notes' ? hit.pos + hit.node.nodeSize - 1 - last.nodeSize : hit.pos + hit.node.nodeSize - 1
      tr.insert(at, shape)
      return [shape.attrs.id as string]
    }
    case 'set_xfrm': {
      const hit = find(tr, op.shape_id, 'shape')
      const a = hit.node.attrs
      tr.setNodeMarkup(hit.pos, undefined, {
        ...a,
        x: op.x !== undefined ? emu(op.x) : a.x,
        y: op.y !== undefined ? emu(op.y) : a.y,
        w: op.w !== undefined ? emu(op.w) : a.w,
        h: op.h !== undefined ? emu(op.h) : a.h,
        xfrm_inherited: false,
      })
      return [op.shape_id]
    }
    case 'delete_shape': {
      const hit = find(tr, op.shape_id, 'shape')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      return [op.shape_id]
    }
    case 'set_notes': {
      const hit = find(tr, op.slide_id, 'slide')
      const paragraphs = deckParagraphs(op.markdown, { ppr: () => null, rpr: null })
      const notes = deckSchema.node('notes', null, paragraphs)
      const last = hit.node.lastChild
      if (last?.type.name === 'notes') {
        const at = hit.pos + hit.node.nodeSize - 1 - last.nodeSize
        tr.replaceWith(at, at + last.nodeSize, paragraphs.length > 0 ? notes : Fragment.empty)
      } else if (paragraphs.length > 0) {
        tr.insert(hit.pos + hit.node.nodeSize - 1, notes)
      }
      return [op.slide_id]
    }
    case 'table_set_cells': {
      const hit = find(tr, op.shape_id, 'shape')
      const table = hit.node.firstChild
      if (hit.node.attrs.kind !== 'table' || table?.type.name !== 'table') throw new OpError('invalid_structure', `${op.shape_id} 不是表格`)
      const rows: PMNode[][] = []
      table.forEach(r => { const cells: PMNode[] = []; r.forEach(c => cells.push(c)); rows.push(cells) })
      for (const c of op.cells) {
        const cell = rows[c.row]?.[c.col]
        if (!cell) throw new OpError('cell_not_found', `表格 ${op.shape_id} 没有单元格 (${c.row}, ${c.col})`, { hint: `共 ${rows.length} 行；下标从 0 开始。` })
        const paragraphs = deckParagraphs(c.markdown, templateOf(deckSchema.node('shape', null, [deckSchema.node('table', null, [deckSchema.node('table_row', null, [cell])])])))
        rows[c.row]![c.col] = cell.type.create(cell.attrs, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
      }
      const next = hit.node.type.create(hit.node.attrs, [deckSchema.node('table', null, rows.map(r => deckSchema.node('table_row', null, r)))])
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, next)
      return [op.shape_id]
    }
  }
}

function notEditable(shape: PMNode): OpError {
  return new OpError('node_not_editable', `形状 ${shape.attrs.id}（${shape.attrs.kind}）的内容不可编辑`, { hint: '不可编辑形状只能移动（set_xfrm）或删除（delete_shape）。' })
}

function textBox(markdown: string, box: { x: number; y: number; w: number; h: number }, fontSize: number): PMNode {
  const rpr = deckSchema.marks.rpr!.create({ xml: `<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" lang="zh-CN" sz="${Math.round(fontSize * 100)}" dirty="0"/>` })
  const paragraphs = deckParagraphs(markdown, { ppr: () => null, rpr })
  return deckSchema.node('shape', { kind: 'text', name: 'TextBox', x: emu(box.x), y: emu(box.y), w: emu(box.w), h: emu(box.h) }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
}

function insertSlide(tr: Transform, slide: PMNode, after: string | null): void {
  if (after === null) { tr.insert(0, slide); return }
  const hit = find(tr, after, 'slide')
  tr.insert(hit.pos + hit.node.nodeSize, slide)
}

/** 新建 deck 的初始内容：一页「标题页」版式（标题、副标题占位符留空）。 */
export function newDeckContent(layouts: LayoutInfo[], title = ''): PMNode {
  const layout = layouts.find(l => /title slide|标题幻灯片/i.test(l.name)) ?? layouts[0]
  const shapes: PMNode[] = []
  for (const ph of layout?.placeholders ?? []) {
    if (!['ctrTitle', 'title', 'subTitle'].includes(ph.type)) continue
    shapes.push(deckSchema.node('shape', {
      kind: 'text', ph: ph.type, ph_idx: ph.idx, x: ph.x, y: ph.y, w: ph.w, h: ph.h, xfrm_inherited: true,
      name: ph.type === 'subTitle' ? 'Subtitle' : 'Title',
    }, [deckSchema.node('paragraph', null, ph.type !== 'subTitle' && title ? [deckSchema.text(title)] : [])]))
  }
  return deckSchema.node('doc', null, [deckSchema.node('slide', { layout: layout?.part ?? null, layout_name: layout?.name ?? '' }, shapes)])
}
