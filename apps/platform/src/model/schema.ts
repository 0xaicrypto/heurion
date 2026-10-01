import { Schema, type Node as PMNode } from 'prosemirror-model'

/**
 * doc 插件的 ProseMirror schema（PLATFORM.md §4.2）。
 *
 * 可寻址节点（带平台 id）：heading / paragraph / bullet_list / ordered_list /
 * list_item / table / figure / opaque。表格单元格按 (row, col) 寻址，不单独给 id。
 * 引用是行内原子节点 citation(cite_id)：编号在渲染时按文中首次出现顺序计算，
 * 模型只写 `[@c:<cite_id>]`，不能手写编号或参考文献表。
 */
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { id: { default: null }, style: { default: null }, align: { default: null } },
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { id: { default: null }, level: { default: 1 }, style: { default: null }, align: { default: null } },
      defining: true,
    },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { id: { default: null } } },
    ordered_list: { group: 'block', content: 'list_item+', attrs: { id: { default: null }, start: { default: 1 } } },
    list_item: { content: 'paragraph block*', attrs: { id: { default: null } }, defining: true },
    table: { group: 'block', content: 'table_row+', attrs: { id: { default: null } }, isolating: true },
    table_row: { content: 'table_cell+' },
    table_cell: {
      content: 'paragraph+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, header: { default: false } },
      isolating: true,
    },
    /** 图：引用平台资产。 */
    figure: {
      group: 'block',
      atom: true,
      attrs: { id: { default: null }, asset_id: { default: null }, alt: { default: '' }, caption: { default: '' } },
    },
    /** 模型不认识的结构：可移动、可删除、可评论，不可编辑内部；导出时原样写回（src 存在 node_src 表）。 */
    opaque: {
      group: 'block',
      atom: true,
      attrs: { id: { default: null }, kind: { default: 'unknown' }, description: { default: '' } },
    },
    text: { group: 'inline' },
    hard_break: { group: 'inline', inline: true },
    citation: { group: 'inline', inline: true, atom: true, attrs: { cite_id: {} } },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
    sup: { excludes: 'sub' },
    sub: { excludes: 'sup' },
    code: {},
    link: { attrs: { href: {} }, inclusive: false },
    /** 评论锚点：同一段文字可同时挂多条线程。 */
    comment: { attrs: { thread: {} }, excludes: '', inclusive: false },
  },
})

/** 带平台 id 的节点类型。 */
export const ADDRESSABLE = new Set(['heading', 'paragraph', 'bullet_list', 'ordered_list', 'list_item', 'table', 'figure', 'opaque'])

export const isAddressable = (n: PMNode): boolean => ADDRESSABLE.has(n.type.name)

/** 一个空文档（doc 至少要有一个块）。 */
export function emptyDoc(id: string): PMNode {
  return schema.node('doc', null, [schema.node('paragraph', { id })])
}
