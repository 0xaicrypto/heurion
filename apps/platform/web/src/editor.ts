import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { InputRule, inputRules, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode, NodeType } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { EditorState, Plugin, PluginKey, TextSelection, type Command } from 'prosemirror-state'
import { goToNextCell, tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView, type NodeView } from 'prosemirror-view'
import { redo, undo, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror'
import type * as Y from 'yjs'
import { ADDRESSABLE, schema } from '../../src/model/schema.ts'

/**
 * doc 编辑器（PLATFORM.md §9 P1）：ProseMirror + y-prosemirror，schema 与服务端共用。
 * 用户编辑经 Yjs 实时同步；AI 的修改作为 Yjs 更新流入，被改动的块短暂高亮。
 */

export interface EditorOptions {
  assetUrl: (assetId: string) => string
  /** 上传图片为资产，返回 asset_id（失败抛错）。 */
  uploadImage: (file: File) => Promise<string>
  onCommentClick: (thread: string) => void
  onSuggestion: (group: string, accept: boolean) => void
  onSelection: (anchor: SelectionAnchor | null) => void
}

export interface SelectionAnchor {
  node_id: string
  /** 空串表示整块 / 整个形状。 */
  snippet: string
  /** deck：选区所在段落在形状里的序号。 */
  paragraph?: number
  /** 选区在段落内的偏移（ProseMirror 位置，相对段落内容起点）。 */
  range?: { from: number; to: number }
  /** 选区不能评论时的提示（跨段落、跨形状…）；有值时只提示不评论。 */
  blocked?: string
  /** 选区在视口中的位置（浮动按钮用）。 */
  rect: { top: number; left: number; width: number }
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** 浏览器侧块 id：6 位、字母开头（服务端是 4 位起，基本不会相撞；相撞时服务端落库前会修复）。 */
function clientId(): string {
  let s = ALPHABET[10 + Math.floor(Math.random() * 26)]!
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

const isRemote = (tr: { getMeta: (k: PluginKey) => unknown }) =>
  Boolean((tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)

/** 本地编辑（回车拆段、粘贴）产生的缺失 / 重复 id 当场补上，新块不继承修订标记。 */
const idPlugin = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some(t => t.docChanged && !isRemote(t))) return null
    const seen = new Set<string>()
    let tr: ReturnType<EditorState['tr']['setNodeMarkup']> | null = null
    state.doc.descendants((node, pos) => {
      if (!ADDRESSABLE.has(node.type.name)) return true
      const id = node.attrs.id as string | null
      if (!id || seen.has(id)) {
        const fresh = clientId()
        tr ??= state.tr
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: fresh, suggest: null, suggest_group: null, suggest_of: null })
        seen.add(fresh)
      } else seen.add(id)
      return true
    })
    return tr
  },
})

/** 引用编号：按正文首次出现顺序（NodeView 忽略自身 DOM 变化，编号由插件视图刷新）。 */
const citePlugin = new Plugin({
  view: view => {
    const renumber = () => {
      const order: string[] = []
      view.state.doc.descendants(n => {
        if (n.type.name === 'citation' && !order.includes(n.attrs.cite_id as string)) order.push(n.attrs.cite_id as string)
      })
      view.dom.querySelectorAll<HTMLElement>('sup.cite').forEach(el => {
        const n = order.indexOf(el.dataset.cite ?? '') + 1
        el.textContent = `[${n || '?'}]`
      })
    }
    renumber()
    return { update: renumber }
  },
})

const flashKey = new PluginKey<DecorationSet>('ai-flash')
const flashPlugin = new Plugin<DecorationSet>({
  key: flashKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(flashKey) as string[] | 'clear' | undefined
      if (meta === 'clear') return DecorationSet.empty
      if (!meta) return set.map(tr.mapping, tr.doc)
      const ids = new Set(meta)
      const decos: Decoration[] = []
      tr.doc.descendants((n, pos) => {
        if (n.attrs.id && ids.has(n.attrs.id as string)) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'ai-flash' }))
        return true
      })
      return DecorationSet.create(tr.doc, decos)
    },
  },
  props: { decorations: state => flashKey.getState(state) },
})

/** 待采纳修订：每组第一个块前放「采纳 / 拒绝」按钮。 */
function suggestionPlugin(onSuggestion: EditorOptions['onSuggestion']) {
  const build = (doc: PMNode) => {
    const seen = new Set<string>()
    const decos: Decoration[] = []
    doc.descendants((n, pos) => {
      const group = n.attrs.suggest_group as string | null
      if (!n.attrs.suggest || !group || seen.has(group)) return true
      seen.add(group)
      decos.push(Decoration.widget(pos, () => {
        const bar = document.createElement('div')
        bar.className = 'suggest-bar'
        bar.contentEditable = 'false'
        bar.innerHTML = '<span>AI 修订</span><button data-a="1">采纳</button><button data-a="0">拒绝</button>'
        bar.addEventListener('mousedown', e => {
          const btn = (e.target as HTMLElement).closest('button')
          if (!btn) return
          e.preventDefault()
          onSuggestion(group, btn.dataset.a === '1')
        })
        return bar
      }, { side: -1, key: `sg-${group}`, ignoreSelection: true }))
      return true
    })
    return DecorationSet.create(doc, decos)
  }
  return new Plugin<DecorationSet>({
    state: {
      init: (_c, state) => build(state.doc),
      apply: (tr, set) => tr.docChanged ? build(tr.doc) : set,
    },
    props: { decorations(state) { return this.getState(state) } },
  })
}

/** 改块类型时保留 id 等属性（setBlockType 会丢掉）。 */
function setBlock(type: NodeType, level?: number): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection
    const targets: Array<{ pos: number; node: PMNode }> = []
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) targets.push({ pos, node })
      return !node.isTextblock
    })
    if (targets.length === 0) return false
    if (dispatch) {
      const tr = state.tr
      for (const { pos, node } of targets) {
        const attrs: Record<string, unknown> = { id: node.attrs.id, align: node.attrs.align, style: node.attrs.style }
        if (type.name === 'heading') attrs.level = level ?? 1
        tr.setNodeMarkup(pos, type, attrs)
      }
      dispatch(tr)
    }
    return true
  }
}

function toggleList(type: NodeType): Command {
  return (state, dispatch, view) => {
    const $from = state.selection.$from
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === type) return liftListItem(schema.nodes.list_item!)(state, dispatch, view)
    }
    return wrapInList(type)(state, dispatch, view)
  }
}

const insertHardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView())
  return true
}

const insertTable: Command = (state, dispatch) => {
  const cell = (header: boolean) => schema.nodes.table_cell!.create({ header }, schema.nodes.paragraph!.create())
  const row = (header: boolean) => schema.nodes.table_row!.create(null, [cell(header), cell(header), cell(header)])
  const table = schema.nodes.table!.create(null, [row(true), row(false), row(false)])
  dispatch?.(state.tr.replaceSelectionWith(table).scrollIntoView())
  return true
}

const rules = inputRules({
  rules: [
    new InputRule(/^(#{1,6})\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start)
      if (!$start.parent.isTextblock || $start.parent.type.name !== 'paragraph') return null
      const pos = $start.before()
      return state.tr.delete(start, end).setNodeMarkup(pos, schema.nodes.heading, { ...$start.parent.attrs, level: match[1]!.length })
    }),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list!, m => ({ start: Number(m[1]) })),
  ],
})

export class Editor {
  readonly view: EditorView

  constructor(mount: HTMLElement, fragment: Y.XmlFragment, private readonly opts: EditorOptions) {
    const listItem = schema.nodes.list_item!
    const state = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin(),
        rules,
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Shift-Mod-z': redo,
          'Mod-b': toggleMark(schema.marks.bold!),
          'Mod-i': toggleMark(schema.marks.italic!),
          'Mod-u': toggleMark(schema.marks.underline!),
          'Shift-Enter': insertHardBreak,
          'Mod-Alt-0': setBlock(schema.nodes.paragraph!),
          'Mod-Alt-1': setBlock(schema.nodes.heading!, 1),
          'Mod-Alt-2': setBlock(schema.nodes.heading!, 2),
          'Mod-Alt-3': setBlock(schema.nodes.heading!, 3),
          Enter: splitListItem(listItem),
          Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
          'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(listItem)),
        }),
        keymap(baseKeymap),
        dropCursor(),
        gapCursor(),
        tableEditing(),
        idPlugin,
        citePlugin,
        flashPlugin,
        suggestionPlugin(opts.onSuggestion),
      ],
    })
    const editor = this
    this.view = new EditorView(mount, {
      state,
      nodeViews: {
        citation: node => {
          const dom = document.createElement('sup')
          dom.className = 'cite'
          dom.dataset.cite = node.attrs.cite_id as string
          dom.textContent = '[?]'
          return { dom, ignoreMutation: () => true } satisfies NodeView
        },
        figure: (node, view, getPos) => {
          const dom = document.createElement('figure')
          if (node.attrs.id) dom.dataset.id = node.attrs.id as string
          if (node.attrs.suggest) dom.dataset.suggest = node.attrs.suggest as string
          const img = document.createElement('img')
          img.src = opts.assetUrl(node.attrs.asset_id as string)
          img.alt = (node.attrs.alt as string) ?? ''
          dom.appendChild(img)
          const cap = document.createElement('figcaption')
          cap.textContent = (node.attrs.caption as string) || '双击添加图注'
          if (!node.attrs.caption) cap.className = 'placeholder'
          dom.appendChild(cap)
          dom.title = '双击编辑图注'
          dom.addEventListener('dblclick', () => {
            const pos = getPos()
            if (pos === undefined) return
            const current = view.state.doc.nodeAt(pos)
            const caption = prompt('图注', (current?.attrs.caption as string) ?? '')
            if (caption === null || !current) return
            view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, caption: caption.trim() }))
          })
          return { dom, ignoreMutation: () => true } satisfies NodeView
        },
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
        if (files.length === 0) return false
        void editor.insertImages(files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'))
        if (files.length === 0) return false
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))))
        void editor.insertImages(files)
        return true
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const mark = (event.target as HTMLElement).closest('mark.comment') as HTMLElement | null
        if (mark?.dataset.thread) opts.onCommentClick(mark.dataset.thread)
        return false
      },
      // ySyncPlugin 在构造期间就会 dispatch（this.view 尚未赋值）：用 ProseMirror 绑定的 this（即 view）
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr))
        if (editor.view && (tr.selectionSet || tr.docChanged)) editor.reportSelection()
      },
    })
  }

  /** 当前选区是否在单个块内（可评论），给出锚点。 */
  private reportSelection(): void {
    const { from, to, empty, $from, $to } = this.view.state.selection
    if (empty) { this.opts.onSelection(null); return }
    if (!$from.parent.isTextblock || $from.parent !== $to.parent) {
      // 与 Claude Docs 一致：评论只能落在一个段落内
      const start = this.view.coordsAtPos(from)
      this.opts.onSelection({ node_id: '', snippet: '', blocked: '评论只能选在一个段落内', rect: { top: start.top, left: start.left, width: 120 } })
      return
    }
    let nodeId: string | null = null
    for (let d = $from.depth; d > 0 && !nodeId; d--) nodeId = ($from.node(d).attrs.id as string | null) ?? null
    // 与服务端 paragraphText 同一规则：硬换行记作换行，引用不计文字
    const snippet = this.view.state.doc.textBetween(from, to, '\n', leaf => (leaf.type.name === 'hard_break' ? '\n' : ''))
    if (!nodeId || !snippet.trim()) { this.opts.onSelection(null); return }
    // 段落内偏移：服务端按位置打锚点（重复出现的文字也能锚准）
    const base = $from.start()
    const range = $from.parent.attrs.id === nodeId ? { from: from - base, to: to - base } : undefined
    const start = this.view.coordsAtPos(from)
    const end = this.view.coordsAtPos(to)
    this.opts.onSelection({ node_id: nodeId, snippet, range, rect: { top: start.top, left: start.left, width: Math.max(0, end.right - start.left) } })
  }

  /** AI 改动的块短暂高亮（Yjs 更新可能晚于提交事件到达，稍等再标）。 */
  flash(ids: string[]): void {
    if (ids.length === 0) return
    setTimeout(() => {
      this.view.dispatch(this.view.state.tr.setMeta(flashKey, ids).setMeta('addToHistory', false))
      setTimeout(() => this.view.dispatch(this.view.state.tr.setMeta(flashKey, 'clear').setMeta('addToHistory', false)), 2200)
    }, 250)
  }

  /** 在光标处插入引用（cite_id 已在服务端登记）。 */
  insertCitation(citeId: string): void {
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(schema.nodes.citation!.create({ cite_id: citeId })).scrollIntoView())
    this.view.focus()
  }

  /** 上传图片并在光标处插入图块（逐张，保持顺序）。 */
  async insertImages(files: File[]): Promise<void> {
    for (const file of files) {
      const assetId = await this.opts.uploadImage(file)
      const figure = schema.nodes.figure!.create({ asset_id: assetId, alt: file.name.replace(/\.[^.]+$/, '') })
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(figure).scrollIntoView())
    }
    this.view.focus()
  }

  run(command: Command): void {
    command(this.view.state, this.view.dispatch, this.view)
    this.view.focus()
  }

  readonly commands = {
    mark: (name: 'bold' | 'italic' | 'underline' | 'sup' | 'sub') => this.run(toggleMark(schema.marks[name]!)),
    paragraph: () => this.run(setBlock(schema.nodes.paragraph!)),
    heading: (level: number) => this.run(setBlock(schema.nodes.heading!, level)),
    bulletList: () => this.run(toggleList(schema.nodes.bullet_list!)),
    orderedList: () => this.run(toggleList(schema.nodes.ordered_list!)),
    table: () => this.run(insertTable),
    undo: () => this.run(undo),
    redo: () => this.run(redo),
  }

  /** 光标所在块的类型（工具栏状态）。 */
  blockType(): string {
    const parent = this.view.state.selection.$from.parent
    return parent.type.name === 'heading' ? `h${parent.attrs.level}` : 'p'
  }

  scrollToThread(thread: string): void {
    const el = this.view.dom.querySelector(`mark.comment[data-thread="${CSS.escape(thread)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  destroy(): void {
    this.view.destroy()
  }
}
