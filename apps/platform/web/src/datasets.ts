/**
 * 数据集（实验室数据分析）：左栏「数据」对话框（上传、处理状态、身份信息列处理、变量与标签、预览、删除），
 * 对话框下方的「引用数据」选择，以及文档里分析图的「来自分析」（代码与数据来源）。
 */
import { askConfirm } from './dialogs.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>

interface Column {
  name: string; type: 'numeric' | 'categorical' | 'date' | 'text'; missing: number; unique: number; label?: string
  stats?: { mean: number | null; sd: number | null; median: number | null; q1: number | null; q3: number | null; min: number | null; max: number | null }
  top?: Array<{ value: string; count: number }>
  range?: [string, string]
}
interface Dataset {
  id: string; name: string; filename: string; format: string; size: number; status: 'processing' | 'review' | 'ready' | 'failed'
  rows: number; cols: number; error: string | null; created_at: string; updated_at: string
  columns: Column[]; labels: Record<string, string>; phi: Array<{ name: string; reason: string }>; truncated: boolean
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
export const DATASET_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta'
const STATUS: Record<Dataset['status'], string> = { processing: '处理中', review: '待处理身份信息', ready: '可分析', failed: '失败' }
const TYPE: Record<Column['type'], string> = { numeric: '数值', categorical: '分类', date: '日期', text: '文本' }

const fmt = (n: number | null | undefined) => n === null || n === undefined ? '—' : Math.abs(n) >= 1000 ? n.toFixed(0) : Number(n.toPrecision(4)).toString()
function summary(c: Column, rows: number): string {
  if (c.type === 'numeric' && c.stats) return `中位数 ${fmt(c.stats.median)}（${fmt(c.stats.q1)}–${fmt(c.stats.q3)}），范围 ${fmt(c.stats.min)}–${fmt(c.stats.max)}`
  if (c.type === 'date' && c.range) return `${c.range[0]} 至 ${c.range[1]}`
  if (c.top?.length) {
    const n = rows - c.missing || 1
    return c.top.slice(0, 4).map(t => `${t.value} ${Math.round(t.count / n * 100)}%`).join('、') + (c.unique > 4 ? ` 等 ${c.unique} 类` : '')
  }
  return ''
}

export function initDatasets(api: Api, notice: (msg: string, error?: boolean) => void) {
  let picked: Dataset[] = []
  let poll: ReturnType<typeof setTimeout> | null = null
  /** 这次刚上传的：处理完如果要处理身份信息，直接打开详情 */
  const justUploaded = new Set<string>()
  const dlg = () => document.getElementById('dialog')!
  const isOpen = () => !dlg().hidden && !!dlg().querySelector('[aria-label="数据"]')

  async function upload(files: FileList | File[]): Promise<Dataset[]> {
    const form = new FormData()
    for (const f of Array.from(files)) form.append('file', f)
    const res = await api<Array<Dataset & { duplicate?: boolean; error?: string }>>('/api/datasets', { method: 'POST', body: form })
    for (const r of res) if (r.id && !r.error) justUploaded.add(r.id)
    const failed = res.filter(r => r.error)
    if (failed.length) notice(failed.map(r => `${r.filename}：${r.error}`).join('；'), true)
    else if (res.some(r => r.duplicate)) notice('这份文件已经上传过了')
    return res.filter(r => r.id && !r.error)
  }

  // —— 列表 ——

  async function openList(): Promise<void> {
    const d = dlg()
    let list: Dataset[] = await api<Dataset[]>('/api/datasets')
    const row = (x: Dataset) => `<tr data-id="${x.id}"><td><div class="kb-name">${esc(x.name)}</div>
        <div class="muted small">${[x.format, x.status === 'ready' || x.status === 'review' ? `${x.rows.toLocaleString()} 行 × ${x.cols} 列` : '', x.error ? esc(x.error) : ''].filter(Boolean).join(' · ')}</div></td>
      <td><span class="kb-status ${x.status === 'ready' ? 'ready' : x.status === 'failed' ? 'failed' : x.status === 'review' ? 'review' : 'busy'}">${STATUS[x.status]}</span></td>
      <td class="actions"><div class="actions-row">${x.status === 'failed' || x.status === 'processing' ? '' : `<button data-open>${x.status === 'review' ? '处理' : '查看'}</button>`}<button data-del class="danger">删除</button></div></td></tr>`
    const render = () => {
      d.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="数据">
        <div class="dialog-head"><h2>数据</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body">
          <div class="muted">上传研究数据表（CSV、Excel 第一个工作表、SAS .xpt / .sas7bdat、SPSS .sav、Stata .dta，≤100 MB），在对话里「＋ 引用数据」后让 AI 做统计分析：Table 1、生存曲线、组间比较、回归，结果直接写进文稿。
            <br>上传时会检查疑似身份信息的列（姓名、证件号、电话、病历号、地址、出生日期），处理后才能分析。</div>
          <div class="kb-drop" id="dsDrop">把文件拖到这里，或 <button id="dsPick" class="primary">选择文件</button><input id="dsInput" type="file" accept="${DATASET_ACCEPT}" multiple hidden></div>
          ${list.length === 0 ? '<div class="muted kb-empty">还没有数据</div>' : `<table class="users kb-table"><tbody>${list.map(row).join('')}</tbody></table>`}
        </div></div>`
      const input = d.querySelector<HTMLInputElement>('#dsInput')!
      d.querySelector<HTMLButtonElement>('#dsPick')!.onclick = () => input.click()
      input.onchange = () => { if (input.files?.length) void withRefresh(upload(input.files)) }
      const drop = d.querySelector<HTMLElement>('#dsDrop')!
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over') }
      drop.ondragleave = () => drop.classList.remove('over')
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files.length) void withRefresh(upload(e.dataTransfer.files)) }
    }
    const refresh = async () => {
      if (!isOpen() || d.querySelector('.ds-detail')) return
      list = await api<Dataset[]>('/api/datasets')
      if (poll) clearTimeout(poll)
      poll = null
      // 刚上传的处理完、需要处理身份信息：直接打开详情
      const fresh = list.find(x => justUploaded.has(x.id) && x.status === 'review')
      for (const x of list) if (x.status !== 'processing') justUploaded.delete(x.id)
      if (fresh) { void openDetail(fresh.id); return }
      render()
      if (list.some(x => x.status === 'processing')) poll = setTimeout(() => void refresh(), 1500)
    }
    const withRefresh = async (p: Promise<unknown>) => {
      try { await p } catch (err) { notice((err as Error).message, true) }
      await refresh()
    }
    render()
    d.hidden = false
    if (list.some(x => x.status === 'processing')) poll = setTimeout(() => void refresh(), 1500)
    d.onchange = null
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { close(); return }
      const x = list.find(y => y.id === (t.closest('tr[data-id]') as HTMLElement | null)?.dataset.id)
      if (!x) return
      if (t.closest('[data-open]')) void openDetail(x.id)
      else if (t.closest('[data-del]')) {
        d.hidden = true
        if (await askConfirm({ title: '删除数据', message: `删除「${x.name}」？AI 将不能再分析它；已写进文稿的结果不受影响。`, confirm: '删除', danger: true })) {
          await api(`/api/datasets/${x.id}`, { method: 'DELETE' })
          picked = picked.filter(p => p.id !== x.id)
          renderPicked()
        }
        void openList()
      }
    }
  }

  function close(): void {
    const d = dlg()
    d.hidden = true
    d.innerHTML = ''
    if (poll) clearTimeout(poll)
    poll = null
  }

  // —— 详情：身份信息处理、变量与标签、预览 ——

  async function openDetail(id: string): Promise<void> {
    const d = dlg()
    const [x, preview] = await Promise.all([api<Dataset>(`/api/datasets/${id}`), api<{ header: string[]; rows: string[][] }>(`/api/datasets/${id}/preview?limit=50`)])
    const phi = new Set(x.phi.map(p => p.name))
    d.innerHTML = `<div class="dialog-card ds-detail" role="dialog" aria-modal="true" aria-label="数据">
      <div class="dialog-head"><h2><button class="quiet small-btn" data-back title="返回列表">←</button>
        <input class="ds-name" id="dsName" value="${esc(x.name)}" aria-label="数据集名称"></h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted small">${esc(x.filename)} · ${x.format} · ${x.rows.toLocaleString()} 行 × ${x.cols} 列${x.truncated ? ' · <b>超过 200 万行，只导入了前 200 万行</b>' : ''}</div>
        ${x.phi.length ? `<div class="ds-phi">
          <div><b>这些列像身份信息</b>，处理后才能给 AI 分析。删除的列从数据集里去掉（原文件里的也不再使用）；确认「不是身份信息」的会保留并记录。</div>
          <table class="users"><tbody>${x.phi.map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.reason)}</div></td>
            <td><label class="toggle"><input type="radio" name="phi-${esc(p.name)}" value="drop" checked> 删除这一列</label></td>
            <td><label class="toggle"><input type="radio" name="phi-${esc(p.name)}" value="keep"> 不是身份信息，保留</label></td></tr>`).join('')}</tbody></table>
          <div class="row end"><button class="primary" id="dsPhiOk">确认</button></div></div>` : ''}
        <h3 class="mem-h">变量（${x.columns.length}）</h3>
        <div class="ds-scroll"><table class="users ds-vars"><thead><tr><th>列名</th><th>标签（画图、做表时用的名字）</th><th>类型</th><th>缺失</th><th>概况</th></tr></thead><tbody>
          ${x.columns.map(c => `<tr${phi.has(c.name) ? ' class="ds-flag"' : ''}><td class="ds-col">${esc(c.name)}</td>
            <td><input class="ds-label" data-col="${esc(c.name)}" value="${esc(x.labels[c.name] ?? c.label ?? '')}" placeholder="${c === x.columns[0] ? '例如：胆红素（mg/dL）' : '添加标签'}"></td>
            <td>${TYPE[c.type]}</td><td>${c.missing ? `${c.missing}（${Math.round(c.missing / Math.max(1, x.rows) * 100)}%）` : '—'}</td>
            <td class="muted small">${esc(summary(c, x.rows))}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 class="mem-h">预览（前 ${preview.rows.length} 行）</h3>
        <div class="ds-scroll ds-preview"><table class="chart-grid"><thead><tr>${preview.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${preview.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      </div></div>`
    d.hidden = false
    const name = d.querySelector<HTMLInputElement>('#dsName')!
    name.onchange = async () => { if (name.value.trim()) await api(`/api/datasets/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.value }) }).catch(err => notice((err as Error).message, true)) }
    d.onchange = async e => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>('.ds-label')
      if (!input) return
      try { await api(`/api/datasets/${id}`, { method: 'PATCH', body: JSON.stringify({ labels: { [input.dataset.col!]: input.value } }) }) }
      catch (err) { notice((err as Error).message, true) }
    }
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { close(); return }
      if (t.closest('[data-back]')) { void openList(); return }
      if (t.closest('#dsPhiOk')) {
        const drop: string[] = []
        const keep: string[] = []
        for (const p of x.phi) (d.querySelector<HTMLInputElement>(`input[name="phi-${CSS.escape(p.name)}"]:checked`)?.value === 'keep' ? keep : drop).push(p.name)
        const btn = t.closest<HTMLButtonElement>('#dsPhiOk')!
        btn.disabled = true
        btn.textContent = '处理中…'
        try {
          const r = await api<Dataset>(`/api/datasets/${id}/phi`, { method: 'POST', body: JSON.stringify({ drop, keep }) })
          notice(r.status === 'ready' ? `已处理${drop.length ? `，删除了 ${drop.length} 列` : ''}，可以分析了` : '还有需要处理的列')
        } catch (err) { notice((err as Error).message, true) }
        void openDetail(id)
      }
    }
  }

  // —— 对话框下方：「引用数据」 ——

  function renderPicked(): void {
    const box = document.getElementById('dsPicked')!
    box.hidden = picked.length === 0
    box.innerHTML = picked.map(x => `<span class="chip" data-id="${x.id}" title="AI 会分析这份数据">▦ ${esc(x.name)}<button class="chip-x" aria-label="移除">✕</button></span>`).join('')
  }

  async function openPicker(anchor: HTMLElement): Promise<void> {
    document.querySelector('.kb-picker')?.remove()
    const all = await api<Dataset[]>('/api/datasets')
    const ready = all.filter(x => x.status === 'ready')
    const menu = document.createElement('div')
    menu.className = 'pop-menu kb-picker'
    menu.innerHTML = (ready.length === 0
      ? `<div class="muted small kb-picker-empty">${all.some(x => x.status === 'review') ? '有数据还没处理身份信息' : '还没有可分析的数据'}</div>`
      : ready.map(x => `<label><input type="checkbox" value="${x.id}" ${picked.some(p => p.id === x.id) ? 'checked' : ''}> ${esc(x.name)} <span class="muted small">${x.rows.toLocaleString()} 行</span></label>`).join(''))
      + '<hr><button data-manage>上传与管理数据…</button>'
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, r.left)}px`
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`
    menu.onchange = e => {
      const box = e.target as HTMLInputElement
      const x = ready.find(y => y.id === box.value)!
      picked = box.checked ? [...picked, x] : picked.filter(p => p.id !== x.id)
      renderPicked()
    }
    menu.onclick = e => { if ((e.target as HTMLElement).closest('[data-manage]')) { done(); void openList() } }
    const done = () => { menu.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey) }
    const away = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== anchor) done() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done() }
    setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', onKey) })
  }

  // —— 文档里的分析图：代码与数据来源 ——

  const provCache = new Map<string, Promise<any>>()
  const provenance = (assetId: string) => {
    if (!provCache.has(assetId)) provCache.set(assetId, api<any>(`/api/assets/${assetId}/provenance`).catch(() => null))
    return provCache.get(assetId)!
  }

  async function showProvenance(assetId: string): Promise<void> {
    const p = await provenance(assetId)
    if (!p) return
    const d = dlg()
    d.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="分析来源">
      <div class="dialog-head"><h2>分析来源</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted small">${new Date(p.at).toLocaleString('zh-CN', { hour12: false })} 由 AI 运行代码生成</div>
        ${p.datasets.length ? `<div><b>数据</b>：${p.datasets.map((s: any) => `《${esc(s.name)}》（${Number(s.rows).toLocaleString()} 行，第 ${s.version} 版）`).join('、')}</div>` : ''}
        ${p.code ? `<div class="row"><b>代码</b>${p.code_path ? `<span class="muted small">${esc(p.code_path)}</span>` : ''}<span class="grow"></span><button class="small-btn" id="provCopy">复制</button></div>
          <pre class="ds-code">${esc(p.code)}</pre>` : '<div class="muted">没有记录代码</div>'}
      </div></div>`
    d.hidden = false
    d.onchange = null
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { close(); return }
      if (t.closest('#provCopy')) { await navigator.clipboard.writeText(p.code); notice('已复制代码') }
    }
  }

  document.getElementById('datasetsBtn')!.onclick = () => void openList()
  document.getElementById('dsPickBtn')!.onclick = e => void openPicker(e.currentTarget as HTMLElement)
  document.getElementById('dsPicked')!.onclick = e => {
    const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
    if (id) { picked = picked.filter(p => p.id !== id); renderPicked() }
  }

  return {
    openList,
    /** 研究页上传数据集（返回上传成功的，含重复的已有数据集） */
    upload,
    /** 打开数据集详情（变量、身份信息处理、预览） */
    openDetail,
    /** 文档里的图是否由分析生成（编辑器给图加「来自分析」标记用）。 */
    hasProvenance: async (assetId: string) => Boolean(await provenance(assetId)),
    showProvenance,
    /** 发送时取走选中的数据集 id（发完清空）。 */
    takePicked(): string[] {
      const ids = picked.map(x => x.id)
      picked = []
      renderPicked()
      return ids
    },
  }
}
