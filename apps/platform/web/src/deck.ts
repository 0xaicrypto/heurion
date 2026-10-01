/**
 * deck 查看器（PLATFORM.md §9 P2）：按模型近似渲染每页（形状按位置与尺寸缩放、图片用资产），
 * 每页可切换到 LibreOffice 的精确渲染。AI 改动的形状高亮，修订标红 / 绿。
 * 评论按最小颗粒度：形状里一个段落内的文字，或单击选中整个形状。
 * 直接拖拽、编辑形状的画布（Univer）在后续阶段接入；当前编辑走对话（deck_edit）。
 */

interface PMJson { type: string; attrs?: Record<string, any>; content?: PMJson[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, any> }> }

export interface DeckViewOptions {
  docId: string
  token: string
  /** 选中文字（限一个段落内）或单击形状（整个形状）；跨段落、跨形状给 blocked 提示。 */
  onSelection: (anchor: { node_id: string; snippet: string; paragraph?: number; blocked?: string; rect: { top: number; left: number; width: number } } | null) => void
  onCommentClick: (thread: string) => void
}

const EMU_PER_PT = 12700
const WIDTH = 760
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const PH_SIZE: Record<string, number> = { title: 40, ctrTitle: 44, subTitle: 24 }
const BODY_LEVELS = [28, 24, 20, 18, 18]

export class DeckView {
  private data: { rev: number; size: { cx: number; cy: number }; doc: PMJson } | null = null
  private precise = new Set<number>()
  private numbers = new Map<string, number>()
  /** 渲染中当前形状的段落计数（与服务端 attachComment 的段落序号一致：形状内文本块的文档顺序）。 */
  private pIndex = 0
  private selected: string | null = null

  constructor(private readonly mount: HTMLElement, private readonly opts: DeckViewOptions) {
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
    return WIDTH / (this.data!.size.cx / EMU_PER_PT)
  }

  private render(): void {
    if (!this.data) return
    const slides = this.data.doc.content ?? []
    // 引用编号：全文首次出现顺序
    this.numbers.clear()
    const walk = (n: PMJson) => {
      if (n.type === 'citation' && !this.numbers.has(n.attrs!.cite_id)) this.numbers.set(n.attrs!.cite_id, this.numbers.size + 1)
      n.content?.forEach(walk)
    }
    walk(this.data.doc)
    const height = Math.round(WIDTH * this.data.size.cy / this.data.size.cx)
    this.mount.innerHTML = slides.map((slide, i) => {
      const notes = slide.content?.find(c => c.type === 'notes')
      const suggest = slide.attrs?.suggest ? ` data-suggest="${slide.attrs.suggest}" data-suggest-group="${esc(slide.attrs.suggest_group)}"` : ''
      const body = this.precise.has(i)
        ? `<img class="slide-png" src="/api/docs/${this.opts.docId}/slides/${i}/render.png?token=${encodeURIComponent(this.opts.token)}&rev=${this.data!.rev}" alt="渲染中…" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'muted',textContent:'精确渲染不可用（需要 LibreOffice 或 heurion2:dev 镜像）'}))">`
        : (slide.content ?? []).filter(c => c.type === 'shape').map(s => this.shape(s)).join('')
      return `<div class="slide-wrap" data-id="${esc(slide.attrs?.id)}"${suggest}>
        <div class="slide-head"><span>第 ${i + 1} 页 · ${esc(slide.attrs?.layout_name || '无版式')}</span><button data-precise="${i}">${this.precise.has(i) ? '近似预览' : '精确预览'}</button></div>
        <div class="slide" style="width:${WIDTH}px;height:${height}px;${slide.attrs?.bg ? `background:#${slide.attrs.bg}` : ''}">${body}</div>
        ${notes ? `<div class="slide-notes">备注：${esc(this.text(notes))}</div>` : ''}
      </div>`
    }).join('')
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
    const fill = a.fill ? `background:#${a.fill};border:0;` : ''
    this.pIndex = 0
    const sel = this.selected === a.id ? ' selected' : ''
    const common = `class="shape shape-${a.kind}${sel}" data-id="${esc(a.id)}"${suggest} style="${box}${fill}"`
    if (a.kind === 'image' && a.asset_id) return `<div ${common}><img src="/api/assets/${esc(a.asset_id)}?token=${encodeURIComponent(this.opts.token)}" alt=""></div>`
    if (a.kind === 'text') return `<div ${common}>${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div>`
    if (a.kind === 'table') {
      const table = s.content?.[0]
      const rows = (table?.content ?? []).map(r => `<tr>${(r.content ?? []).map(c => `<td>${(c.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</td>`).join('')}</tr>`).join('')
      return `<div ${common}><table>${rows}</table></div>`
    }
    if (a.kind === 'shape') return `<div ${common}></div>`
    return `<div ${common}><span class="shape-label">${esc(a.description || a.kind)}</span></div>`
  }

  private paragraph(shape: PMJson, p: PMJson, k: number): string {
    const lvl = p.attrs?.lvl ?? 0
    const ph = shape.attrs!.ph as string | null
    let size = 0
    const runs = (p.content ?? []).map(c => {
      if (c.type === 'hard_break') return '<br>'
      if (c.type === 'citation') return `<sup class="cite">[${this.numbers.get(c.attrs!.cite_id) ?? '?'}]</sup>`
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
      return color ? `<span style="color:#${color}">${html}</span>` : html
    }).join('')
    if (!size) size = (ph && PH_SIZE[ph]) || (ph === 'body' || ph === 'obj' ? BODY_LEVELS[lvl] ?? 18 : 18)
    // 项目符号用 CSS 画，不进选区文字
    const bullet = (ph === 'body' || ph === 'obj') && runs ? ' class="bullet"' : ''
    const align = p.attrs?.align ? `text-align:${p.attrs.align};` : ''
    return `<p data-p="${this.pIndex++}"${bullet} style="font-size:${size * k}px;margin-left:${lvl * 18 * k}px;${align}">${runs || '&nbsp;'}</p>`
  }

  private reportSelection(e?: MouseEvent): void {
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
        this.opts.onSelection({ node_id: target.dataset.id!, snippet: '', rect: { top: r.top, left: r.left, width: r.width } })
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
    const snippet = sel.toString()
    if (!snippet.trim()) { this.opts.onSelection(null); return }
    this.opts.onSelection({ node_id: a.dataset.id!, snippet, paragraph: Number(p.dataset.p), rect: at })
  }

  private select(id: string | null): void {
    this.selected = id
    this.mount.querySelectorAll('.shape.selected').forEach(el => el.classList.remove('selected'))
    if (id) this.mount.querySelector(`.slide .shape[data-id="${CSS.escape(id)}"]`)?.classList.add('selected')
  }

  flash(ids: string[]): void {
    setTimeout(() => {
      for (const id of ids) this.mount.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('ai-flash')
      setTimeout(() => this.mount.querySelectorAll('.ai-flash').forEach(el => el.classList.remove('ai-flash')), 2200)
    }, 50)
  }

  destroy(): void {
    this.mount.innerHTML = ''
  }
}
