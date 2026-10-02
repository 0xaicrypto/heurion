import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './style.css'
import * as Y from 'yjs'
import { initUserMenu, showAuthScreen, signOut, storedToken, type Me } from './account.ts'
import { DeckView } from './deck.ts'
import { Editor, type SelectionAnchor } from './editor.ts'
import { Provider, type ProviderStatus } from './provider.ts'

const TOKEN = storedToken()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } })
  // 令牌失效（过期、被停用、在别处改了密码）：回到登录页
  if (res.status === 401) {
    if (TOKEN) signOut()
    throw new Error('请先登录')
  }
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
let pendingAnchor: { node_id: string; snippet: string; paragraph?: number; range?: { from: number; to: number } } | null = null
let refreshTimer: number | undefined

// —— 文档列表 ——

const ICON_DOC = '<svg class="kind doc" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="文档"><path d="M4 1.75h5.5L12.5 4.75v9.5H4z"/><path d="M9.25 1.75v3.25h3.25M6 8h4.5M6 10.75h4.5"/></svg>'
const ICON_DECK = '<svg class="kind deck" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="幻灯片"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M8 11.25v2.5M5.5 13.75h5"/></svg>'

async function loadDocs(): Promise<void> {
  const docs = await api<any[]>('/api/docs')
  $('docList').innerHTML = docs.map(d =>
    `<li data-id="${d.id}" class="${d.id === session?.docId ? 'active' : ''}" title="${esc(d.title)}">${d.kind === 'deck' ? ICON_DECK : ICON_DOC}<span class="label">${esc(d.title)}</span></li>`).join('')
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
  for (const b of ['exportDocxBtn', 'exportMdBtn', 'exportPptxBtn', 'sendBtn']) $<HTMLButtonElement>(b).disabled = false
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
    const failed = new Map<string, { status: string; error: string | null }>((d.failed_turns ?? []).map((t: any) => [t.id, t]))
    for (const m of d.messages) {
      addMsg(m.role, displayMessage(m.text), m.role === 'assistant' && d.revertable.includes(m.turn_id) ? m.turn_id : null)
      // 没正常完成的回合：在该轮用户消息后标出原因（刷新页面后也看得到）
      const f = m.role === 'user' && m.turn_id ? failed.get(m.turn_id) : undefined
      if (f) addStep(`${TURN_STATUS[f.status] ?? f.status}${f.error ? `：${f.error}` : ''}`, 'err')
    }
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

const TURN_STATUS: Record<string, string> = { error: '本轮出错', cancelled: '本轮已取消', timeout: '本轮超时', interrupted: '本轮被中断' }

function displayMessage(text: string): string {
  const m = /^请处理文档 \S+ 中的评论 (\S+)：/.exec(text)
  if (m) return `处理评论 ${m[1]}`
  if (/^请核对文档 \S+ 中带引用的论断/.test(text)) return '核对全部论断'
  return text
}

/** AI 文字常带 **粗体** 与 `代码`：转义后只渲染这两种。 */
function lightMarkdown(text: string): string {
  return esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

function addMsg(role: 'user' | 'assistant', text: string, revertTurn: string | null = null): HTMLElement {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  // AI 回复常带 **粗体** 与 `代码`：转义后只渲染这两种
  if (role === 'assistant') div.innerHTML = lightMarkdown(text)
  else div.textContent = text
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
    case 'queued': addStep(`排队中（第 ${ev.position} 位）：${displayMessage(ev.message).slice(0, 40)}`); void loadQueue(); break
    case 'turn':
      void loadQueue()
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
      void loadQueue()
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
// 「停止」只停当前任务，排在后面的照常执行；清空排队在任务队列里
$('cancelBtn').onclick = async () => {
  await loadQueue() // 刚发送的任务可能还不在缓存里
  if (queue.running) await cancelJob(queue.running.id)
}

// —— 任务队列（同一用户的所有文档共用一个队列） ——

interface QueueItem { id: string; doc_id: string; doc_title: string; label: string; suggest: boolean; since: string }
let queue: { running: QueueItem | null; queued: QueueItem[] } = { running: null, queued: [] }

async function loadQueue(): Promise<void> {
  if (!TOKEN) return
  try {
    queue = await api('/api/queue')
  } catch { return }
  renderQueue()
  // 忙碌状态只按刚取到的队列设置（不用缓存，免得发送后被旧数据覆盖）
  setBusy(!!queue.running)
}

function elapsed(since: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

function renderQueue(): void {
  const items = [...(queue.running ? [{ ...queue.running, running: true }] : []), ...queue.queued.map(q => ({ ...q, running: false }))]
  // 面板常驻：空闲时只显示一行，有任务时展开
  $('queuePanel').classList.toggle('idle', items.length === 0)
  $('queueClear').hidden = items.length === 0
  $('queueSummary').textContent = items.length === 0 ? '空闲' : `${queue.running ? '1 个执行中' : ''}${queue.running && queue.queued.length ? '，' : ''}${queue.queued.length ? `${queue.queued.length} 个排队` : ''}`
  $('queueList').innerHTML = items.map((q, i) => `
    <li class="${q.running ? 'running' : ''}">
      <div class="queue-main">
        <span class="queue-state">${q.running ? '执行中' : `第 ${i + (queue.running ? 0 : 1)} 位`}</span>
        <span class="queue-doc${q.doc_id === session?.docId ? ' here' : ''}" data-open="${esc(q.doc_id)}" title="打开这份文档">《${esc(q.doc_title)}》</span>
        ${q.suggest ? '<span class="queue-tag">修订</span>' : ''}
        <div class="queue-label" title="${esc(q.label)}">${esc(q.label)}</div>
        <div class="muted">${q.running ? '已运行' : '已等待'} ${elapsed(q.since)}</div>
      </div>
      <button data-cancel="${esc(q.id)}">${q.running ? '停止' : '取消'}</button>
    </li>`).join('')
}

async function cancelJob(id: string): Promise<void> {
  try {
    await api(`/api/queue/${id}/cancel`, { method: 'POST' })
  } catch (err) {
    showNotice((err as Error).message, true)
  }
  await loadQueue()
}

$('queueList').onclick = e => {
  const t = e.target as HTMLElement
  const cancel = t.closest('[data-cancel]') as HTMLElement | null
  if (cancel) { void cancelJob(cancel.dataset.cancel!); return }
  const open = t.closest('[data-open]') as HTMLElement | null
  if (open && open.dataset.open !== session?.docId) document.querySelector<HTMLElement>(`li[data-id="${CSS.escape(open.dataset.open!)}"]`)?.click()
}
$('queueClear').onclick = async () => {
  await api('/api/cancel', { method: 'POST' }).catch(err => showNotice((err as Error).message, true))
  await loadQueue()
}
// 队列跨文档（别的文档里的任务、@heurion 自动触发），定时刷新；有任务时刷得勤一些
let queueTick = 0
setInterval(() => {
  if (document.hidden) return
  queueTick++
  if (queue.running || queue.queued.length > 0 || queueTick % 5 === 0) void loadQueue()
}, 2000)
void loadQueue()

// —— 选区评论 ——

function placeFab(): void {
  const fab = $('commentFab')
  if (!anchor) { fab.style.display = 'none'; return }
  const main = document.querySelector('.center')!.getBoundingClientRect()
  fab.style.display = 'block'
  fab.textContent = anchor.blocked ?? (anchor.snippet ? '评论' : '评论此形状')
  fab.classList.toggle('blocked', !!anchor.blocked)
  fab.style.top = `${anchor.rect.top - main.top - 36}px`
  fab.style.left = `${anchor.rect.left - main.left + anchor.rect.width / 2 - 24}px`
}
$('scroller').addEventListener('scroll', () => { $('commentFab').style.display = 'none' })

$('commentFab').onmousedown = e => {
  e.preventDefault()
  if (!anchor || anchor.blocked) return
  pendingAnchor = { node_id: anchor.node_id, snippet: anchor.snippet, paragraph: anchor.paragraph, range: anchor.range }
  $('commentFab').style.display = 'none'
  switchTab('commentPane')
  $('newComment').hidden = false
  $('newCommentQuote').textContent = pendingAnchor.snippet || '（整个形状）'
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
      ${c.replies.map((r: any) => `<div class="reply ${r.role}"><b>${r.role === 'ai' ? 'Heurion' : '我'}</b>：${r.role === 'ai' ? lightMarkdown(r.text) : esc(r.text)}</div>`).join('')}
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

// 待采纳修订：只在有修订时出现在正文上方（不单设页签）；逐处采纳 / 拒绝在正文里的修订条上
let suggestCursor = -1

function renderSuggestions(): void {
  const groups: any[] = detail?.suggestions ?? []
  $('suggestBanner').hidden = groups.length === 0
  if (groups.length === 0) { suggestCursor = -1; return }
  const blocks = groups.reduce((n, g) => n + g.inserts + g.deletes, 0)
  $('suggestSummary').textContent = `${groups.length} 处待采纳修订（涉及 ${blocks} 块）· AI 的修改需你采纳后生效`
  if (suggestCursor >= groups.length) suggestCursor = groups.length - 1
}

$('suggestBanner').onclick = e => {
  const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!t) return
  const groups: any[] = detail?.suggestions ?? []
  if (t.dataset.all) { void resolveSuggestion('all', t.dataset.all === '1'); return }
  if (t.dataset.nav && groups.length > 0) {
    suggestCursor = (suggestCursor + Number(t.dataset.nav) + groups.length) % groups.length
    const el = document.querySelector(`[data-suggest-group="${CSS.escape(groups[suggestCursor].group)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('ai-flash')
    setTimeout(() => el?.classList.remove('ai-flash'), 1200)
  }
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
// 开发者：读视图（用户菜单里，仅开发模式）
document.addEventListener('heurion:readview', async () => {
  if (!session) { showNotice('先打开一份文档'); return }
  const w = window.open('', '_blank')
  const text = await api<string>(`/api/docs/${session.docId}/read`)
  if (w) w.document.body.innerHTML = `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace">${esc(text)}</pre>`
})

// 启动：没有令牌 → 登录页；有令牌 → 取当前用户，失效时 api() 会回到登录页
async function boot(): Promise<void> {
  if (!TOKEN) { $('app').hidden = true; await showAuthScreen(); return }
  const me = await api<Me>('/api/me')
  initUserMenu(me, api, showNotice)
  await loadDocs()
}
boot().catch(err => { $('page').innerHTML = `<div class="empty">${esc((err as Error).message)}</div>` })
