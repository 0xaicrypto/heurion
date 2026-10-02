/**
 * deck 查看器（PLATFORM.md §9 P2）：按模型近似渲染每页（形状按位置与尺寸缩放、图片用资产），
 * 每页可切换到 LibreOffice 的精确渲染。AI 改动的形状高亮，修订标红 / 绿。
 * 评论按最小颗粒度：形状里一个段落内的文字，或单击选中整个形状。
 * 画布（C1）：单击选中形状 → 拖顶部手柄移动、拖 8 个控制点缩放、方向键微调（Shift 10pt）、Delete 删除；
 * 每个手势结束时提交一个 deck 操作（与 AI 的 deck_edit 同一套），服务端回推后重新渲染。
 * 形状里拖动仍是选文字（评论），与移动互不干扰。
 */

interface PMJson { type: string; attrs?: Record<string, any>; content?: PMJson[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, any> }> }

export interface DeckViewOptions {
  docId: string
  token: string
  /** 选中文字（限一个段落内）或单击形状（整个形状）；跨段落、跨形状给 blocked 提示。 */
  onSelection: (anchor: { node_id: string; snippet: string; paragraph?: number; range?: { from: number; to: number }; blocked?: string; rect: { top: number; left: number; width: number } } | null) => void
  onCommentClick: (thread: string) => void
  /** 提交 deck 操作（REST edit，actor=user）；成功返回 true。 */
  onEdit: (ops: Array<Record<string, unknown>>, baseRev: number) => Promise<boolean>
  /** 选中的形状变化（工具条据此更新）。 */
  onSelectShape?: (shapeId: string | null) => void
}

type DragKind = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EMU_PER_PT = 12700
/** 幻灯片显示宽度随中间栏自适应（窄屏不被裁掉），在这个范围内。 */
const MIN_WIDTH = 480
const MAX_WIDTH = 960
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const PH_SIZE: Record<string, number> = { title: 40, ctrTitle: 44, subTitle: 24 }
const BODY_LEVELS = [28, 24, 20, 18, 18]

export class DeckView {
  private data: { rev: number; size: { cx: number; cy: number }; doc: PMJson } | null = null
  private precise = new Set<number>()
  private numbers = new Map<string, number>()
  /** 渲染中当前形状的段落计数（与服务端 attachComment 的段落序号一致：形状内文本块的文档顺序）。 */
  private pIndex = 0
  /** 段落模型（形状 id#段落序号）：选区换算引用文字用。 */
  private paras = new Map<string, PMJson>()
  private selected: string | null = null
  private drag: { kind: DragKind; id: string; x: number; y: number; box: { l: number; t: number; w: number; h: number }; ratio: number | null; moved: boolean } | null = null
  private nudge: { id: string; dx: number; dy: number; timer: number } | null = null
  private width = 760
  private readonly resize = new ResizeObserver(() => {
    if (Math.abs(this.fitWidth() - this.width) > 8 && !this.drag) this.render()
  })

  constructor(private readonly mount: HTMLElement, private readonly opts: DeckViewOptions) {
    const scroller = mount.closest('.scroller')
    if (scroller) this.resize.observe(scroller)
    mount.addEventListener('pointerdown', e => this.startDrag(e))
    mount.addEventListener('pointermove', e => this.moveDrag(e))
    mount.addEventListener('pointerup', e => void this.endDrag(e))
    document.addEventListener('keydown', this.onKey)
    mount.addEventListener('mouseup', e => this.reportSelection(e))
    mount.addEventListener('keyup', () => this.reportSelection())
    mount.addEventListener('click', e => {
      const t = e.target as HTMLElement
      const mark = t.closest('mark.comment') as HTMLElement | null
      if (mark?.dataset.thread) opts.onCommentClick(mark.dataset.thread)
      const toggle = t.closest('[data-precise]') as HTMLElement | null
      if (toggle) {
        const i = Number(toggle.dataset.precise)
        if (this.precise.has(i)) this.precise.delete(i)
        else this.precise.add(i)
        this.render()
      }
    })
  }

  async load(): Promise<void> {
    const res = await fetch(`/api/docs/${this.opts.docId}/deck`, { headers: { Authorization: `Bearer ${this.opts.token}` } })
    this.data = await res.json()
    this.render()
  }

  private scale(): number {
    return this.width / (this.data!.size.cx / EMU_PER_PT)
  }

  /** 中间栏可用宽度（减去滚动区与页面的内边距）。 */
  private fitWidth(): number {
    const scroller = this.mount.closest('.scroller') as HTMLElement | null
    const avail = (scroller?.clientWidth ?? 856) - 48 - 48
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(avail)))
  }

  private render(): void {
    if (!this.data) return
    const slides = this.data.doc.content ?? []
    // 引用编号：全文首次出现顺序
    this.numbers.clear()
    this.paras.clear()
    const walk = (n: PMJson) => {
      if (n.type === 'citation' && !this.numbers.has(n.attrs!.cite_id)) this.numbers.set(n.attrs!.cite_id, this.numbers.size + 1)
      n.content?.forEach(walk)
    }
    walk(this.data.doc)
    this.width = this.fitWidth()
    const height = Math.round(this.width * this.data.size.cy / this.data.size.cx)
    this.mount.innerHTML = slides.map((slide, i) => {
      const notes = slide.content?.find(c => c.type === 'notes')
      const suggest = slide.attrs?.suggest ? ` data-suggest="${slide.attrs.suggest}" data-suggest-group="${esc(slide.attrs.suggest_group)}"` : ''
      const body = this.precise.has(i)
        ? `<img class="slide-png" src="/api/docs/${this.opts.docId}/slides/${i}/render.png?token=${encodeURIComponent(this.opts.token)}&rev=${this.data!.rev}" alt="渲染中…" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'muted',textContent:'精确渲染不可用（需要 LibreOffice 或 heurion2:dev 镜像）'}))">`
        : (slide.content ?? []).filter(c => c.type === 'shape').map(s => this.shape(s)).join('')
      return `<div class="slide-wrap" data-id="${esc(slide.attrs?.id)}" data-index="${i}"${suggest}>
        <div class="slide-head"><span>第 ${i + 1} 页 · ${esc(slide.attrs?.layout_name || '无版式')}</span><button data-precise="${i}">${this.precise.has(i) ? '近似预览' : '精确预览'}</button></div>
        <div class="slide" style="width:${this.width}px;height:${height}px;${slide.attrs?.bg ? `background:#${slide.attrs.bg}` : ''}">${body}</div>
        ${notes ? `<div class="slide-notes">备注：${esc(this.text(notes))}</div>` : ''}
      </div>`
    }).join('')
    // 选中的形状被删了（别人或 AI 删的）：取消选中
    if (this.selected && !this.selection()) { this.selected = null; this.opts.onSelectShape?.(null) }
    this.drawSelection()
  }

  // —— 画布：选中、移动、缩放、微调、删除 ——

  /** 当前选中的形状与所在页（工具条用）。 */
  selection(): { shape: PMJson; slide: PMJson } | null {
    if (!this.selected || !this.data) return null
    for (const slide of this.data.doc.content ?? []) {
      const shape = slide.content?.find(c => c.attrs?.id === this.selected)
      if (shape) return { shape, slide }
    }
    return null
  }

  /** 视口里当前的页（没选中形状时，插入 / 背景作用在这一页）。 */
  currentSlide(): PMJson | null {
    const sel = this.selection()
    if (sel) return sel.slide
    const slides = this.data?.doc.content ?? []
    const wraps = [...this.mount.querySelectorAll<HTMLElement>('.slide-wrap')]
    const top = this.mount.closest('.scroller')?.getBoundingClientRect().top ?? 0
    const visible = wraps.find(w => w.getBoundingClientRect().bottom > top + 80)
    return slides[Number(visible?.dataset.index ?? 0)] ?? slides[0] ?? null
  }

  get rev(): number { return this.data?.rev ?? 0 }
  get slideSize(): { cx: number; cy: number } { return this.data?.size ?? { cx: 12192000, cy: 6858000 } }

  async edit(ops: Array<Record<string, unknown>>): Promise<boolean> {
    return this.opts.onEdit(ops, this.rev)
  }

  /** 选中框：顶部移动手柄 + 8 个缩放控制点；框本身不挡鼠标（形状里的文字仍可选中评论）。 */
  private drawSelection(): void {
    this.mount.querySelectorAll('.sel-box').forEach(el => el.remove())
    if (!this.selected) return
    const el = this.mount.querySelector<HTMLElement>(`.slide .shape[data-id="${CSS.escape(this.selected)}"]`)
    if (!el) return
    // 选中框画在页面外层（页面会裁掉超出部分）：形状超出页面时控制点仍可见、可拖
    const slideEl = el.parentElement!
    const ox = slideEl.offsetLeft
    const oy = slideEl.offsetTop
    const box = document.createElement('div')
    box.className = 'sel-box'
    box.dataset.ox = String(ox)
    box.dataset.oy = String(oy)
    box.style.cssText = `left:${ox + parseFloat(el.style.left)}px;top:${oy + parseFloat(el.style.top)}px;width:${el.style.width};height:${el.style.height};${el.style.transform ? `transform:${el.style.transform};` : ''}`
    box.innerHTML = '<div class="sel-grip" data-drag="move" title="拖动移动；方向键微调（Shift 每次 10pt）；Delete 删除">⠿</div>'
      + (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map(h => `<div class="sel-handle h-${h}" data-drag="${h}"></div>`).join('')
    // 手柄放在形状上方；贴着页面上沿时放下方，都放不下时放在框内（页面会裁掉超出部分）
    box.querySelector<HTMLElement>('.sel-grip')!.classList.add(oy + parseFloat(el.style.top) >= 26 ? 'above' : 'inside')
    slideEl.parentElement!.appendChild(box)
  }

  private startDrag(e: PointerEvent): void {
    const handle = (e.target as HTMLElement).closest('[data-drag]') as HTMLElement | null
    if (!handle || !this.selected || e.button !== 0) return
    const el = this.mount.querySelector<HTMLElement>(`.slide .shape[data-id="${CSS.escape(this.selected)}"]`)
    if (!el) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const box = { l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
    // 图片拖角时保持比例
    const ratio = el.classList.contains('shape-image') && handle.dataset.drag!.length === 2 ? box.w / box.h : null
    this.drag = { kind: handle.dataset.drag as DragKind, id: this.selected, x: e.clientX, y: e.clientY, box, ratio, moved: false }
  }

  private moveDrag(e: PointerEvent): void {
    const d = this.drag
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 2) return
    d.moved = true
    this.placeLive(d.id, this.dragRect(d, dx, dy))
  }

  /** 拖动 / 微调过程中就地移动形状与选中框（框在页面外层，要加页面偏移）。 */
  private placeLive(id: string, r: { l: number; t: number; w: number; h: number }): void {
    const el = this.mount.querySelector<HTMLElement>(`.slide .shape[data-id="${CSS.escape(id)}"]`)
    if (el) Object.assign(el.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.w}px`, height: `${r.h}px` })
    const box = this.mount.querySelector<HTMLElement>('.sel-box')
    if (box) Object.assign(box.style, { left: `${r.l + Number(box.dataset.ox)}px`, top: `${r.t + Number(box.dataset.oy)}px`, width: `${r.w}px`, height: `${r.h}px` })
  }

  private dragRect(d: NonNullable<DeckView['drag']>, dx: number, dy: number): { l: number; t: number; w: number; h: number } {
    const min = 10 * this.scale()
    let { l, t, w, h } = d.box
    if (d.kind === 'move') return { l: l + dx, t: t + dy, w, h }
    if (d.kind.includes('e')) w = Math.max(min, w + dx)
    if (d.kind.includes('s')) h = Math.max(min, h + dy)
    if (d.kind.includes('w')) { const nw = Math.max(min, w - dx); l += w - nw; w = nw }
    if (d.kind.includes('n')) { const nh = Math.max(min, h - dy); t += h - nh; h = nh }
    if (d.ratio) {
      const nh = w / d.ratio
      if (d.kind.includes('n')) t += h - nh
      h = nh
    }
    return { l, t, w, h }
  }

  private async endDrag(e: PointerEvent): Promise<void> {
    const d = this.drag
    if (!d) return
    this.drag = null
    if (!d.moved) return
    const r = this.dragRect(d, e.clientX - d.x, e.clientY - d.y)
    const k = this.scale()
    const ok = await this.edit([{ op: 'set_xfrm', shape_id: d.id, x: Math.round(r.l / k), y: Math.round(r.t / k), w: Math.max(10, Math.round(r.w / k)), h: Math.max(10, Math.round(r.h / k)) }])
    if (!ok) this.render() // 被拒（冲突等）：回到服务端的状态
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.selected || !this.mount.isConnected) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], .ProseMirror, .dialog')) return
    if (e.key === 'Escape') { this.select(null); this.opts.onSelectShape?.(null); return }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const id = this.selected
      this.select(null)
      this.opts.onSelectShape?.(null)
      void this.edit([{ op: 'delete_shape', shape_id: id }])
      return
    }
    const step = e.shiftKey ? 10 : 1
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!delta) return
    e.preventDefault()
    // 连续按键先就地移动，停下 400ms 后合并成一个 set_xfrm
    const n = this.nudge?.id === this.selected ? this.nudge : { id: this.selected, dx: 0, dy: 0, timer: 0 }
    n.dx += delta[0]!
    n.dy += delta[1]!
    const k = this.scale()
    const el = this.mount.querySelector<HTMLElement>(`.slide .shape[data-id="${CSS.escape(n.id)}"]`)
    if (el) this.placeLive(n.id, { l: parseFloat(el.style.left) + delta[0]! * k, t: parseFloat(el.style.top) + delta[1]! * k, w: parseFloat(el.style.width), h: parseFloat(el.style.height) })
    clearTimeout(n.timer)
    n.timer = window.setTimeout(() => {
      this.nudge = null
      const sel = this.selection()
      if (!sel) return
      const a = sel.shape.attrs!
      void this.edit([{ op: 'set_xfrm', shape_id: n.id, x: Math.round(a.x / EMU_PER_PT + n.dx), y: Math.round(a.y / EMU_PER_PT + n.dy) }])
    }, 400)
    this.nudge = n
  }

  private text(n: PMJson): string {
    if (n.type === 'text') return n.text ?? ''
    return (n.content ?? []).map(c => this.text(c)).join(n.type === 'notes' ? '\n' : '')
  }

  private shape(s: PMJson): string {
    const a = s.attrs!
    const k = this.scale()
    const box = `left:${a.x / EMU_PER_PT * k}px;top:${a.y / EMU_PER_PT * k}px;width:${a.w / EMU_PER_PT * k}px;height:${a.h / EMU_PER_PT * k}px;${a.rot ? `transform:rotate(${a.rot / 60000}deg);` : ''}`
    const suggest = a.suggest ? ` data-suggest="${a.suggest}" data-suggest-group="${esc(a.suggest_group)}"` : ''
    const fill = a.fill === 'none' ? 'background:transparent;border:0;' : a.fill ? `background:#${a.fill};border:0;` : ''
    const radius = a.geom === 'ellipse' ? 'border-radius:50%;' : a.geom === 'roundRect' ? `border-radius:${Math.min(a.w, a.h) / EMU_PER_PT * k * 0.16}px;` : ''
    this.pIndex = 0
    const sel = this.selected === a.id ? ' selected' : ''
    // 带几何 / 实心填充的文本框按色块显示（文字垂直居中，与导出的 anchor="ctr" 一致）
    const block = a.kind === 'text' && !a.ph && (a.geom || (a.fill && a.fill !== 'none'))
    const common = `class="shape shape-${block ? 'shape' : a.kind}${sel}" data-id="${esc(a.id)}"${suggest} style="${box}${fill}${radius}"`
    if (a.kind === 'image' && a.asset_id) return `<div ${common}><img src="/api/assets/${esc(a.asset_id)}?token=${encodeURIComponent(this.opts.token)}" alt=""></div>`
    if (a.kind === 'text' && !block) return `<div ${common}>${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div>`
    if (block) return `<div ${common}><div class="shape-text">${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div></div>`
    if (a.kind === 'table') {
      const table = s.content?.[0]
      const rows = (table?.content ?? []).map(r => `<tr>${(r.content ?? []).map(c => `<td>${(c.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</td>`).join('')}</tr>`).join('')
      return `<div ${common}><table>${rows}</table></div>`
    }
    // 色块 / 卡片：文字垂直居中（与导出的 anchor="ctr" 一致）
    if (a.kind === 'shape') return `<div ${common}><div class="shape-text">${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div></div>`
    return `<div ${common}><span class="shape-label">${esc(a.description || a.kind)}</span></div>`
  }

  private paragraph(shape: PMJson, p: PMJson, k: number): string {
    const lvl = p.attrs?.lvl ?? 0
    const ph = shape.attrs!.ph as string | null
    let size = 0
    // 每个行内单位标上在段落里的偏移（data-o），选区据此换算回模型位置
    let offset = 0
    const runs = (p.content ?? []).map(c => {
      const o = offset
      offset += c.type === 'text' ? (c.text ?? '').length : 1
      if (c.type === 'hard_break') return `<br data-o="${o}">`
      if (c.type === 'citation') return `<sup class="cite" data-o="${o}" data-atom>[${this.numbers.get(c.attrs!.cite_id) ?? '?'}]</sup>`
      const rpr = c.marks?.find(m => m.type === 'rpr')?.attrs?.xml as string | undefined
      const sz = rpr ? /\ssz="(\d+)"/.exec(rpr)?.[1] : undefined
      const color = rpr ? /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr)?.[1] : undefined
      if (sz && !size) size = Number(sz) / 100
      let html = esc(c.text)
      for (const m of c.marks ?? []) {
        if (m.type === 'bold') html = `<b>${html}</b>`
        if (m.type === 'italic') html = `<i>${html}</i>`
        if (m.type === 'underline') html = `<u>${html}</u>`
        if (m.type === 'sup') html = `<sup>${html}</sup>`
        if (m.type === 'sub') html = `<sub>${html}</sub>`
        if (m.type === 'comment') html = `<mark class="comment" data-thread="${esc(m.attrs?.thread)}">${html}</mark>`
      }
      return `<span data-o="${o}"${color ? ` style="color:#${color}"` : ''}>${html}</span>`
    }).join('')
    if (!size) size = (ph && PH_SIZE[ph]) || (ph === 'body' || ph === 'obj' ? BODY_LEVELS[lvl] ?? 18 : 18)
    // 项目符号用 CSS 画，不进选区文字
    const bullet = (ph === 'body' || ph === 'obj') && runs ? ' class="bullet"' : ''
    const align = p.attrs?.align ? `text-align:${p.attrs.align};` : ''
    this.paras.set(`${shape.attrs!.id}#${this.pIndex}`, p)
    return `<p data-p="${this.pIndex++}" data-len="${offset}"${bullet} style="font-size:${size * k}px;margin-left:${lvl * 18 * k}px;${align}">${runs || '&nbsp;'}</p>`
  }

  private reportSelection(e?: MouseEvent): void {
    // 在选中框（手柄、控制点）上松开鼠标是拖动的结束，不是点空白处
    if ((e?.target as HTMLElement | undefined)?.closest?.('.sel-box')) return
    const sel = getSelection()
    const el = (n: Node | null) => (n?.nodeType === 3 ? n.parentElement : n as HTMLElement | null)
    const shapeOf = (n: Node | null) => el(n)?.closest('.shape[data-id]') as HTMLElement | null
    const paraOf = (n: Node | null) => el(n)?.closest('p[data-p]') as HTMLElement | null
    if (!sel || sel.isCollapsed || !this.mount.contains(sel.anchorNode)) {
      // 单击形状：选中整个形状
      const target = e ? (e.target as HTMLElement).closest('.slide .shape[data-id]') as HTMLElement | null : null
      if (target && !(e!.target as HTMLElement).closest('mark.comment')) {
        this.select(target.dataset.id!)
        const r = target.getBoundingClientRect()
        // 评论按钮放在形状右上角（正上方留给移动手柄）
        this.opts.onSelection({ node_id: target.dataset.id!, snippet: '', rect: { top: r.top, left: r.right - 100, width: 100 } })
      } else {
        this.select(null)
        this.opts.onSelection(null)
      }
      return
    }
    this.select(null)
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const at = { top: rect.top, left: rect.left, width: rect.width }
    const a = shapeOf(sel.anchorNode)
    if (!a) { this.opts.onSelection(null); return }
    const p = paraOf(sel.anchorNode)
    if (a !== shapeOf(sel.focusNode) || !p || p !== paraOf(sel.focusNode)) {
      this.opts.onSelection({ node_id: '', snippet: '', blocked: a !== shapeOf(sel.focusNode) ? '评论只能选在一个形状内' : '评论只能选在一个段落内；要评论整个形状请单击它', rect: at })
      return
    }
    const r = sel.getRangeAt(0)
    const from = pmOffset(p, r.startContainer, r.startOffset)
    const to = pmOffset(p, r.endContainer, r.endOffset)
    const model = this.paras.get(`${a.dataset.id}#${p.dataset.p}`)
    if (from === null || to === null || from >= to || !model) { this.opts.onSelection(null); return }
    // 引用文字按模型算（与服务端同一规则），不含渲染出来的 [n] 角标
    const snippet = paragraphSlice(model, from, to)
    if (!snippet.trim()) { this.opts.onSelection(null); return }
    this.opts.onSelection({ node_id: a.dataset.id!, snippet, paragraph: Number(p.dataset.p), range: { from, to }, rect: at })
  }

  private select(id: string | null): void {
    const changed = id !== this.selected
    this.selected = id
    this.mount.querySelectorAll('.shape.selected').forEach(el => el.classList.remove('selected'))
    if (id) this.mount.querySelector(`.slide .shape[data-id="${CSS.escape(id)}"]`)?.classList.add('selected')
    this.drawSelection()
    if (changed) this.opts.onSelectShape?.(id)
  }

  flash(ids: string[]): void {
    setTimeout(() => {
      for (const id of ids) this.mount.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('ai-flash')
      setTimeout(() => this.mount.querySelectorAll('.ai-flash').forEach(el => el.classList.remove('ai-flash')), 2200)
    }, 50)
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey)
    this.resize.disconnect()
    this.mount.innerHTML = ''
  }
}

/** 浏览器选区端点 → 段落内的模型偏移（按 data-o 标注换算；引用角标整体算一个单位）。 */
function pmOffset(p: HTMLElement, node: Node, offset: number): number | null {
  const el = node.nodeType === 3 ? node.parentElement : node as HTMLElement
  if (!el || !p.contains(el)) return null
  if (el === p) {
    const kid = p.childNodes[offset] as HTMLElement | undefined
    return kid?.dataset?.o !== undefined ? Number(kid.dataset.o) : Number(p.dataset.len ?? 0)
  }
  const run = el.closest('[data-o]') as HTMLElement | null
  if (!run || !p.contains(run)) return null
  const o = Number(run.dataset.o)
  if (run.dataset.atom !== undefined || run.tagName === 'BR') return offset === 0 ? o : o + 1
  if (node.nodeType === 3) return o + offset
  return offset === 0 ? o : o + (run.textContent ?? '').length
}

/** 段落模型 [from, to) 的文字：硬换行记作换行，引用不计文字（同服务端 paragraphText）。 */
function paragraphSlice(p: PMJson, from: number, to: number): string {
  let out = ''
  let pos = 0
  for (const c of p.content ?? []) {
    const len = c.type === 'text' ? (c.text ?? '').length : 1
    const a = Math.max(from, pos)
    const b = Math.min(to, pos + len)
    if (a < b) out += c.type === 'text' ? c.text!.slice(a - pos, b - pos) : c.type === 'hard_break' ? '\n' : ''
    pos += len
  }
  return out
}
