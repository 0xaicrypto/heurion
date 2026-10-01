import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './style.css'
import * as Y from 'yjs'
import { DeckView } from './deck.ts'
import { Editor, type SelectionAnchor } from './editor.ts'
import { Provider, type ProviderStatus } from './provider.ts'

const TOKEN = localStorage.getItem('heurion.token') || 'dev'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } })
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: string; message?: string }
    throw new Error(e.error || e.message || res.statusText)
  }
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>
}

interface Session {
  docId: string
  kind: 'doc' | 'deck'
  stream: EventSource
  /** doc：协同编辑器。 */
  ydoc?: Y.Doc
  provider?: Provider
  editor?: Editor
  /** deck：幻灯片查看器（编辑经对话）。 */
  deck?: DeckView
}

let session: Session | null = null
let detail: any = null
let anchor: SelectionAnchor | null = null
let pendingAnchor: { node_id: string; snippet: string } | null = null
let refreshTimer: number | undefined

// —— 文档列表 ——

async function loadDocs(): Promise<void> {
  const docs = await api<any[]>('/api/docs')
  $('docList').innerHTML = docs.map(d =>
    `<li data-id="${d.id}" class="${d.id === session?.docId ? 'active' : ''}" title="${esc(d.title)}">${d.kind === 'deck' ? '<span class="kind">PPT</span>' : ''}${esc(d.title)}</li>`).join('')
}

$('docList').onclick = e => {
  const li = (e.target as HTMLElement).closest('li')
  if (li?.dataset.id) void open(li.dataset.id)
}

$('newDoc').onclick = async () => {
  const title = prompt('文档标题', '未命名')
  if (title === null) return
  const d = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title }) })
  await loadDocs()
  await open(d.id)
}

$('newDeck').onclick = async () => {
  const title = prompt('幻灯片标题', '未命名汇报')
  if (title === null) return
  const d = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title, kind: 'deck' }) })
  await loadDocs()
  await open(d.id)
}

$('uploadBtn').onclick = () => $('uploadInput').click()
$<HTMLInputElement>('uploadInput').onchange = async e => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  try {
    const d = await api('/api/docs', { method: 'POST', body: fd })
    await loadDocs()
    await open(d.id)
    if (d.warnings?.length) showNotice(`导入提示：${d.warnings.join('；')}`)
  } catch (err) {
    showNotice(`导入失败：${(err as Error).message}`, true)
  }
  input.value = ''
}

// —— 打开文档：Yjs 同步 + 编辑器 + 文档事件流 ——

async function open(docId: string): Promise<void> {
  close()
  $('chatLog').innerHTML = ''
  $('page').innerHTML = ''
  const meta = await api(`/api/docs/${docId}`)
  const stream = new EventSource(`/api/docs/${docId}/stream?token=${encodeURIComponent(TOKEN)}`)
  stream.onmessage = e => onStreamEvent(JSON.parse(e.data))
  const onCommentClick = (thread: string) => {
    switchTab('commentPane')
    document.querySelector(`[data-cid="${CSS.escape(thread)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  if (meta.kind === 'deck') {
    const deck = new DeckView($('page'), { docId, token: TOKEN, onCommentClick, onSelection: a => { anchor = a; placeFab() } })
    session = { docId, kind: 'deck', stream, deck }
    $('page').classList.add('deck')
    setSyncStatus('synced')
    await deck.load()
  } else {
    const ydoc = new Y.Doc()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const provider = new Provider(`${proto}://${location.host}/collab/${docId}?token=${encodeURIComponent(TOKEN)}`, ydoc, setSyncStatus)
    const editor = new Editor($('page'), ydoc.getXmlFragment('body'), {
      assetUrl: id => `/api/assets/${id}?token=${encodeURIComponent(TOKEN)}`,
      uploadImage: async file => {
        const fd = new FormData()
        fd.append('file', file)
        try {
          return (await api(`/api/docs/${docId}/assets`, { method: 'POST', body: fd })).asset_id as string
        } catch (err) {
          showNotice(`图片上传失败：${(err as Error).message}`, true)
          throw err
        }
      },
      onCommentClick,
      onSuggestion: (group, accept) => void resolveSuggestion(group, accept),
      onSelection: a => { anchor = a; placeFab(); syncToolbar() },
    })
    session = { docId, kind: 'doc', stream, ydoc, provider, editor }
    $('page').classList.remove('deck')
  }
  $('toolbar').hidden = meta.kind === 'deck'
  $('exportDocxBtn').hidden = meta.kind === 'deck'
  $('exportMdBtn').hidden = meta.kind === 'deck'
  $('exportPptxBtn').hidden = meta.kind !== 'deck'
  for (const b of ['exportDocxBtn', 'exportMdBtn', 'exportPptxBtn', 'readBtn', 'sendBtn']) $<HTMLButtonElement>(b).disabled = false
  await loadDocs()
  await refresh(true)
}

function close(): void {
  if (!session) return
  session.stream.close()
  session.editor?.destroy()
  session.provider?.destroy()
  session.ydoc?.destroy()
  session.deck?.destroy()
  session = null
}

function setSyncStatus(s: ProviderStatus): void {
  const el = $('syncStatus')
  el.textContent = s === 'synced' ? '已同步' : s === 'connecting' ? '连接中…' : '离线（恢复后自动同步）'
  el.className = `status ${s}`
}

function onStreamEvent(e: any): void {
  if (!session) return
  if (e.type === 'hello') { setBusy(Boolean(e.busy)); return }
  if (e.type === 'commit') {
    const ids = e.changes.filter((c: any) => c.kind !== 'removed').map((c: any) => c.node_id)
    if (session.deck) void session.deck.load().then(() => { if (e.actor === 'ai') session?.deck?.flash(ids) })
    else if (e.actor === 'ai') session.editor?.flash(ids)
    scheduleRefresh()
    return
  }
  if (e.type === 'notice') { showNotice(e.message); return }
  if (e.type === 'turn_event') renderTurnEvent(e.event)
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => void refresh(false), 400)
}

async function refresh(full: boolean): Promise<void> {
  if (!session) return
  const d = await api(`/api/docs/${session.docId}`)
  detail = d
  $('docTitle').textContent = d.title
  if (full) {
    setBusy(d.busy)
    for (const m of d.messages) addMsg(m.role, displayMessage(m.text), m.role === 'assistant' && d.revertable.includes(m.turn_id) ? m.turn_id : null)
  }
  renderComments()
  renderSuggestions()
  renderVersions()
  renderCites()
  syncRevertButtons()
}

$('docTitle').onclick = async () => {
  if (!session || !detail) return
  const title = prompt('重命名', detail.title)
  if (!title?.trim()) return
  await api(`/api/docs/${session.docId}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  await loadDocs()
  await refresh(false)
}

// —— 工具栏 ——

$('toolbar').onclick = e => {
  const btn = (e.target as HTMLElement).closest('button')
  const cmd = btn?.dataset.cmd
  if (!cmd || !session?.editor) return
  const c = session.editor.commands as Record<string, (...a: any[]) => void>
  if (cmd === 'image') { $('imageInput').click(); return }
  if (cmd === 'cite') { void addCitation(); return }
  if (['bold', 'italic', 'underline', 'sup', 'sub'].includes(cmd)) session.editor.commands.mark(cmd as 'bold')
  else c[cmd]?.()
}
async function addCitation(): Promise<void> {
  if (!session?.editor) return
  const doi = prompt('输入要引用文献的 DOI（会经 Crossref 核实）')
  if (!doi?.trim()) return
  try {
    const r = await api(`/api/docs/${session.docId}/citations`, { method: 'POST', body: JSON.stringify({ doi }) })
    session.editor?.insertCitation(r.cite_id)
    showNotice(`已插入引用：${r.formatted}`)
    scheduleRefresh()
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

$<HTMLInputElement>('imageInput').onchange = e => {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (session?.editor && files.length > 0) void session.editor.insertImages(files).catch(() => {})
}
$<HTMLSelectElement>('blockType').onchange = e => {
  const v = (e.target as HTMLSelectElement).value
  if (!session?.editor) return
  if (v === 'p') session.editor.commands.paragraph()
  else session.editor.commands.heading(Number(v.slice(1)))
}
function syncToolbar(): void {
  if (!session?.editor) return
  const t = session.editor.blockType()
  $<HTMLSelectElement>('blockType').value = ['p', 'h1', 'h2', 'h3'].includes(t) ? t : 'p'
}

// —— 通知 ——

let noticeTimer: number | undefined
function showNotice(text: string, error = false): void {
  const el = $('notice')
  el.textContent = text
  el.className = `notice${error ? ' error' : ''}`
  el.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { el.hidden = true }, 8000)
}
$('notice').onclick = () => { $('notice').hidden = true }

// —— 对话 ——

function displayMessage(text: string): string {
  const m = /^请处理文档 \S+ 中的评论 (\S+)：/.exec(text)
  if (m) return `处理评论 ${m[1]}`
  if (/^请核对文档 \S+ 中带引用的论断/.test(text)) return '核对全部论断'
  return text
}

function addMsg(role: 'user' | 'assistant', text: string, revertTurn: string | null = null): HTMLElement {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.textContent = text
  if (revertTurn) attachRevert(div, revertTurn)
  $('chatLog').appendChild(div)
  $('chatLog').scrollTop = 1e9
  return div
}

function attachRevert(el: HTMLElement, turnId: string): void {
  const btn = document.createElement('button')
  btn.className = 'revert'
  btn.dataset.turn = turnId
  btn.textContent = '撤销本轮修改'
  btn.onclick = async () => {
    if (!session) return
    try {
      const r = await api(`/api/docs/${session.docId}/turns/${turnId}/revert`, { method: 'POST' })
      const kept = r.skipped.length > 0 ? `；${r.skipped.length} 处你之后改过，已保留你的版本` : ''
      btn.replaceWith(Object.assign(document.createElement('div'), { className: 'step ok', textContent: `已撤销本轮修改（${r.changes} 处）${kept}` }))
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
  el.appendChild(btn)
}

function syncRevertButtons(): void {
  const ok = new Set<string>(detail?.revertable ?? [])
  document.querySelectorAll<HTMLButtonElement>('button.revert').forEach(b => { if (!ok.has(b.dataset.turn!)) b.remove() })
}

function addStep(text: string, cls = ''): void {
  const div = document.createElement('div')
  div.className = `step ${cls}`
  div.textContent = text
  div.title = text
  $('chatLog').appendChild(div)
  $('chatLog').scrollTop = 1e9
}

let lastAssistant: HTMLElement | null = null

function renderTurnEvent(ev: any): void {
  switch (ev.type) {
    case 'queued': addStep(`排队中（第 ${ev.position} 位）：${displayMessage(ev.message).slice(0, 40)}`); break
    case 'turn':
      lastAssistant = null
      setBusy(true)
      addMsg('user', displayMessage(ev.message))
      break
    case 'assistant': lastAssistant = addMsg('assistant', ev.text); break
    case 'tool_call': addStep(`→ ${String(ev.name).replace(/^mcp__heurion__/, '')} ${String(ev.arguments).slice(0, 160)}`); break
    case 'tool_result': if (ev.isError) addStep(`  ✗ 工具报错${ev.code ? `：${ev.code}` : ''}`, 'err'); break
    case 'doc_updated': addStep(`  ✓ 文档已更新（${ev.changes} 处）`, 'ok'); break
    case 'comment_reply': scheduleRefresh(); break
    case 'version': addStep(`  ✓ 已保存为 v${ev.seq}`, 'ok'); break
    case 'error': addStep(ev.message, 'err'); break
    case 'turn_done':
      setBusy(false)
      if (ev.docs.includes(session?.docId) && ev.status !== 'error') {
        void refresh(false).then(() => {
          if (detail?.revertable.includes(ev.turn_id)) attachRevert(lastAssistant ?? addMsg('assistant', '（本轮已完成）'), ev.turn_id)
        })
      }
      break
  }
}

function setBusy(b: boolean): void {
  $<HTMLButtonElement>('cancelBtn').disabled = !b
  $<HTMLButtonElement>('sendBtn').textContent = b ? '排队发送' : '发送'
}

async function send(): Promise<void> {
  const text = $<HTMLTextAreaElement>('chatInput').value.trim()
  if (!text || !session) return
  $<HTMLTextAreaElement>('chatInput').value = ''
  try {
    await api(`/api/docs/${session.docId}/chat?async=1`, { method: 'POST', body: JSON.stringify({ message: text, suggest: $<HTMLInputElement>('suggestMode').checked }) })
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}
$('sendBtn').onclick = () => void send()
$<HTMLTextAreaElement>('chatInput').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }
$('cancelBtn').onclick = () => void api('/api/cancel', { method: 'POST' })

// —— 选区评论 ——

function placeFab(): void {
  const fab = $('commentFab')
  if (!anchor) { fab.style.display = 'none'; return }
  const main = document.querySelector('.center')!.getBoundingClientRect()
  fab.style.display = 'block'
  fab.style.top = `${anchor.rect.top - main.top - 36}px`
  fab.style.left = `${anchor.rect.left - main.left + anchor.rect.width / 2 - 24}px`
}
$('scroller').addEventListener('scroll', () => { $('commentFab').style.display = 'none' })

$('commentFab').onmousedown = e => {
  e.preventDefault()
  if (!anchor) return
  pendingAnchor = { node_id: anchor.node_id, snippet: anchor.snippet }
  $('commentFab').style.display = 'none'
  switchTab('commentPane')
  $('newComment').hidden = false
  $('newCommentQuote').textContent = pendingAnchor.snippet
  $<HTMLTextAreaElement>('newCommentText').value = ''
  $('newCommentText').focus()
}
$('newCommentCancel').onclick = () => { $('newComment').hidden = true; pendingAnchor = null }

async function saveComment(ask: boolean): Promise<void> {
  const text = $<HTMLTextAreaElement>('newCommentText').value.trim()
  if (!text || !pendingAnchor || !session) return
  try {
    const c = await api(`/api/docs/${session.docId}/comments`, { method: 'POST', body: JSON.stringify({ ...pendingAnchor, text }) })
    $('newComment').hidden = true
    pendingAnchor = null
    if (ask && !c.queued) {
      await api(`/api/docs/${session.docId}/comments/${c.id}/ask?async=1`, { method: 'POST', body: JSON.stringify({ suggest: $<HTMLInputElement>('suggestMode').checked }) })
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}
$('newCommentSave').onclick = () => void saveComment(false)
$('newCommentAsk').onclick = () => void saveComment(true)

function renderComments(): void {
  const list: any[] = detail?.comments ?? []
  $('comments').innerHTML = list.length === 0
    ? '<div class="muted">在正文中选中文字即可评论；写上 @heurion 由 AI 自动处理</div>'
    : list.map(c => `
    <div class="card ${c.status}" data-cid="${c.id}">
      <div class="quote ${c.anchor.located ? '' : 'lost'}">${esc(c.anchor.text || c.snippet || '（整块）')}${c.anchor.located ? '' : ' · 锚点已移除'}</div>
      ${c.replies.map((r: any) => `<div class="reply ${r.role}"><b>${r.role === 'ai' ? 'Heurion' : '我'}</b>：${esc(r.text)}</div>`).join('')}
      <div class="row">
        ${c.status === 'open'
          ? `<input type="text" placeholder="追问或补充（含 @heurion 自动处理）" data-reply><button data-act="reply">回复</button><button data-act="ask" class="ai">让 AI 处理</button><button data-act="resolve">关闭</button><button data-act="delete" title="删除评论">删除</button>`
          : `<span class="muted">已关闭（${c.resolved_by === 'ai' ? 'AI' : '我'}）</span><button data-act="reopen">重新打开</button><button data-act="delete" title="删除评论">删除</button>`}
      </div>
    </div>`).join('')
}

$('comments').onclick = async e => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null
  if (!btn || !session) return
  const card = btn.closest('[data-cid]') as HTMLElement
  const cid = card.dataset.cid!
  const input = card.querySelector<HTMLInputElement>('[data-reply]')
  const text = input?.value.trim() ?? ''
  try {
    if (btn.dataset.act === 'reply') {
      if (!text) return
      await api(`/api/docs/${session.docId}/comments/${cid}/replies`, { method: 'POST', body: JSON.stringify({ text }) })
    } else if (btn.dataset.act === 'ask') {
      await api(`/api/docs/${session.docId}/comments/${cid}/ask?async=1`, { method: 'POST', body: JSON.stringify({ text, suggest: $<HTMLInputElement>('suggestMode').checked }) })
      switchTab('chatPane')
    } else if (btn.dataset.act === 'delete') {
      if (!confirm('删除这条评论？')) return
      await api(`/api/docs/${session.docId}/comments/${cid}`, { method: 'DELETE' })
    } else {
      await api(`/api/docs/${session.docId}/comments/${cid}/${btn.dataset.act}`, { method: 'POST' })
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

// —— 修订 ——

async function resolveSuggestion(group: string, accept: boolean): Promise<void> {
  if (!session) return
  try {
    await api(`/api/docs/${session.docId}/suggestions/${group}/${accept ? 'accept' : 'reject'}`, { method: 'POST' })
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

function renderSuggestions(): void {
  const groups: any[] = detail?.suggestions ?? []
  $('suggestCount').textContent = groups.length ? String(groups.length) : ''
  $('suggestions').innerHTML = groups.length === 0
    ? '<div class="muted">勾选「修订模式」后，AI 的修改会先作为待采纳修订出现在正文里</div>'
    : `<div class="row" style="margin-bottom:8px"><button data-all="1" class="primary">全部采纳</button><button data-all="0">全部拒绝</button></div>` +
      groups.map(g => `<div class="card" data-group="${g.group}"><div>新增 ${g.inserts} 块 · 删除 ${g.deletes} 块</div>
        <div class="row end"><button data-jump>定位</button><button data-accept="0">拒绝</button><button data-accept="1" class="primary">采纳</button></div></div>`).join('')
}

$('suggestions').onclick = e => {
  const t = e.target as HTMLElement
  if (t.dataset.all) { void resolveSuggestion('all', t.dataset.all === '1'); return }
  const card = t.closest('[data-group]') as HTMLElement | null
  if (!card) return
  if (t.dataset.accept) void resolveSuggestion(card.dataset.group!, t.dataset.accept === '1')
  if (t.hasAttribute('data-jump')) document.querySelector(`[data-suggest-group="${CSS.escape(card.dataset.group!)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// —— 版本与引用 ——

const SOURCE: Record<string, string> = { create: '新建', import: '导入', turn: 'AI', user: '保存', restore: '回滚' }

function renderVersions(): void {
  $('versions').innerHTML = `<div class="row" style="margin-bottom:8px"><button id="saveVersion">保存当前为版本</button></div>` +
    (detail?.versions ?? []).map((v: any) => `<div class="vitem"><div><b>v${v.seq}</b> · ${SOURCE[v.source] ?? v.source} · ${esc(v.note)}<div class="muted">rev ${v.rev} · ${new Date(v.created_at).toLocaleString()}</div></div>
      <div class="row"><button data-diff="${v.seq}">对比</button><button data-restore="${v.seq}">回滚</button></div></div>`).join('')
  $('saveVersion').onclick = async () => {
    if (!session) return
    await api(`/api/docs/${session.docId}/save`, { method: 'POST' })
    await refresh(false)
  }
}

$('versions').onclick = async e => {
  const d = (e.target as HTMLElement).dataset
  if (!session) return
  if (d.restore && confirm(`回滚到 v${d.restore}？（会生成新版本，历史保留）`)) {
    try {
      await api(`/api/docs/${session.docId}/versions/${d.restore}/restore`, { method: 'POST' })
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
  if (d.diff) {
    const r = await api(`/api/docs/${session.docId}/diff?from=${d.diff}`)
    const label: Record<string, string> = { added: '新增', removed: '删除', modified: '修改' }
    $('diffView').innerHTML = `<h4>v${d.diff} → 当前</h4>` + (r.changes.length === 0 ? '<div class="muted">无变化</div>' : r.changes.map((c: any) =>
      `<div class="${c.kind}">[${label[c.kind]}] ${esc(c.kind === 'removed' ? c.before : c.after)}${c.kind === 'modified' ? `<div class="muted">原：${esc(c.before)}</div>` : ''}</div>`).join(''))
  }
}

const VERDICT: Record<string, string> = { supported: '支持', unsupported: '不支持', unclear: '无法判断', missing_citation: '缺出处' }

function renderCites(): void {
  const list: any[] = detail?.citations ?? []
  const checks: any[] = detail?.claim_checks ?? []
  const counts = checks.reduce((m: Record<string, number>, c: any) => { m[c.verdict] = (m[c.verdict] ?? 0) + 1; return m }, {})
  const summary = checks.length === 0 ? '<span class="muted">还没有核对过</span>'
    : Object.entries(counts).map(([v, n]) => `<span class="verdict ${v}">${VERDICT[v] ?? v} ${n}</span>`).join(' ')
  const flagged = checks.filter(c => c.verdict !== 'supported').map(c =>
    `<div class="claim"><span class="verdict ${c.verdict}">${VERDICT[c.verdict] ?? c.verdict}</span> ${esc(c.sentence)}<div class="muted">${esc(c.reason)}</div></div>`).join('')
  $('cites').innerHTML = `<div class="card"><div class="row"><b>论断核对</b><span class="grow"></span><button id="verifyBtn" class="ai">核对全部论断</button></div>
      <div class="muted" style="margin:4px 0">对照所引文献的 PubMed 摘要逐句核对；有问题的句子会挂一条 AI 评论，不会自动改写。</div>
      <div>${summary}</div>${flagged}</div>` +
    (list.length === 0 ? '<div class="muted">AI 通过文献检索登记的引用会显示在这里</div>' : list.map(c =>
      `<div class="card"><b>${c.number ? `[${c.number}]` : '未使用'}</b> ${esc(c.formatted)} <a href="${esc(c.url || `https://doi.org/${c.doi}`)}" target="_blank" rel="noopener">原文</a></div>`).join(''))
  $('verifyBtn').onclick = async () => {
    if (!session) return
    try {
      await api(`/api/docs/${session.docId}/verify?async=1`, { method: 'POST' })
      switchTab('chatPane')
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
}

// —— 杂项 ——

function switchTab(id: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === id))
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === id))
}
document.querySelector<HTMLElement>('.tabs')!.onclick = e => {
  const tab = (e.target as HTMLElement).closest('button')?.dataset.tab
  if (tab) switchTab(tab)
}

$('exportDocxBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.docx?token=${encodeURIComponent(TOKEN)}` }
$('exportPptxBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.pptx?token=${encodeURIComponent(TOKEN)}` }
$('exportMdBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.md?token=${encodeURIComponent(TOKEN)}` }
$('readBtn').onclick = async () => {
  if (!session) return
  const w = window.open('', '_blank')
  const text = await api<string>(`/api/docs/${session.docId}/read`)
  if (w) w.document.body.innerHTML = `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace">${esc(text)}</pre>`
}

loadDocs().catch(err => { $('page').innerHTML = `<div class="empty">${esc((err as Error).message)}（令牌：localStorage heurion.token）</div>` })
