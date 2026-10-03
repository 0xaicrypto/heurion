/**
 * 幻灯片「＋图片 ▾ → 从 Unsplash 搜索」：搜索框 + 网格结果（缩略图热链 Unsplash），悬停显示署名；
 * 点一张插入当前页（平台下载成资产，图文版式放进图片区，署名写进图片说明与演讲备注）。
 * 与 AI 的 image_search / slide_add_photo 同一个服务；服务器没配图库时入口隐藏（initPhotoSearch 返回 false）。
 */

interface Photo { id: string; width: number; height: number; color: string | null; description: string; thumb: string; small: string; credit: { name: string; profile: string; photo_page: string; text: string } }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

let configured: boolean | null = null
export async function photoSearchEnabled(api: (path: string) => Promise<any>): Promise<boolean> {
  configured ??= await api('/api/images').then(r => Boolean(r.configured)).catch(() => false)
  return configured!
}

export function openPhotoSearch(opts: {
  api: (path: string, init?: RequestInit) => Promise<any>
  target: () => { docId: string; slideId: string } | null
  notice: (msg: string, error?: boolean) => void
}): void {
  const dlg = document.getElementById('dialog')!
  dlg.innerHTML = `<div class="dialog-card ph-dialog" role="dialog" aria-modal="true" aria-label="从 Unsplash 搜索图片">
    <div class="dialog-head"><h2>从 Unsplash 搜索图片</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
    <div class="dialog-body">
      <form class="ph-search"><input id="phQuery" placeholder="关键词（英文效果更好），例如 laboratory、microscope、mountain" autocomplete="off"><button class="primary">搜索</button></form>
      <div class="ph-grid" id="phGrid"><div class="muted small ph-empty">输入关键词搜索。照片插入当前页后，署名会自动写进图片说明和演讲备注。</div></div>
      <div class="ph-more" id="phMore" hidden><button id="phNext">下一页</button></div>
      <div class="muted small ph-foot">照片来自 <a href="https://unsplash.com/?utm_source=heurion&amp;utm_medium=referral" target="_blank" rel="noreferrer">Unsplash</a></div>
    </div></div>`
  dlg.hidden = false
  const close = () => { dlg.hidden = true; dlg.innerHTML = ''; document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  const grid = dlg.querySelector<HTMLElement>('#phGrid')!
  const more = dlg.querySelector<HTMLElement>('#phMore')!
  let q = ''
  let page = 1
  let results: Photo[] = []
  const tile = (p: Photo) => `<button class="ph-tile" data-photo="${esc(p.id)}" style="aspect-ratio:${p.width}/${p.height};background:${esc(p.color ?? 'transparent')}" title="${esc(p.description || p.credit.text)}">
    <img src="${esc(p.thumb)}" alt="${esc(p.description)}" loading="lazy"><span class="ph-credit">${esc(p.credit.text)}</span></button>`
  async function load(reset: boolean): Promise<void> {
    if (reset) { page = 1; results = []; grid.innerHTML = '<div class="muted small ph-empty">搜索中…</div>' }
    try {
      const r = await opts.api(`/api/images/search?q=${encodeURIComponent(q)}&page=${page}`)
      results = [...results, ...r.results]
      grid.innerHTML = results.length ? results.map(tile).join('') : '<div class="muted small ph-empty">没有找到，换个关键词试试</div>'
      more.hidden = page >= r.pages
    } catch (err) { grid.innerHTML = `<div class="muted small ph-empty">${esc((err as Error).message)}</div>` }
  }
  dlg.querySelector<HTMLFormElement>('.ph-search')!.onsubmit = e => {
    e.preventDefault()
    q = dlg.querySelector<HTMLInputElement>('#phQuery')!.value.trim()
    if (q) void load(true)
  }
  dlg.querySelector<HTMLElement>('#phNext')!.onclick = () => { page++; void load(false) }
  dlg.onclick = async e => {
    const t = e.target as HTMLElement
    if (t === dlg || t.closest('[data-close]')) { close(); return }
    const b = t.closest<HTMLButtonElement>('[data-photo]')
    if (!b || b.disabled) return
    const target = opts.target()
    if (!target) { opts.notice('先选中一页幻灯片', true); return }
    b.disabled = true
    b.classList.add('busy')
    try {
      const r = await opts.api(`/api/docs/${target.docId}/slides/${target.slideId}/photo`, { method: 'POST', body: JSON.stringify({ photo_id: b.dataset.photo }) })
      close()
      opts.notice(`已插入（${r.credit.text}，署名已写进演讲备注）`)
    } catch (err) { b.disabled = false; b.classList.remove('busy'); opts.notice((err as Error).message, true) }
  }
  dlg.onchange = null
  dlg.querySelector<HTMLInputElement>('#phQuery')!.focus()
}
