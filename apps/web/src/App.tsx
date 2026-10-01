import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Comment, type Doc, type DocDetail, type DocKind, type Projection, type ProjectionNode, type UiEvent, type Version } from './api.ts'

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

interface LiveStep { kind: 'reasoning' | 'assistant' | 'tool' | 'notice' | 'error'; text: string }

const SOURCE_META: Record<Version['source'], { label: string; cls: string }> = {
  upload: { label: '上传', cls: 'src-upload' },
  user: { label: '手动', cls: 'src-user' },
  ai: { label: 'AI', cls: 'src-ai' },
  restore: { label: '回滚', cls: 'src-restore' },
}

export function App() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const refreshDocs = useCallback(() => api.listDocs().then(setDocs), [])
  useEffect(() => { void refreshDocs() }, [refreshDocs])

  return (
    <div className="shell">
      <Sidebar docs={docs} activeId={activeId} onSelect={setActiveId} onCreated={d => { void refreshDocs(); setActiveId(d.id) }} onChanged={refreshDocs} />
      {activeId ? <Workspace key={activeId} docId={activeId} onChanged={refreshDocs} /> : <div className="empty">选择或新建一份文档</div>}
    </div>
  )
}

function Sidebar({ docs, activeId, onSelect, onCreated, onChanged }: {
  docs: Doc[]; activeId: string | null; onSelect: (id: string | null) => void; onCreated: (d: Doc) => void; onChanged: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const create = async (kind: DocKind) => onCreated(await api.createDoc({ title: kind === 'docx' ? '新文档' : '新幻灯片', kind }))
  const remove = async (id: string, title: string) => {
    if (!confirm(`删除「${title}」？版本与评论一并删除，不可恢复。`)) return
    await api.deleteDoc(id)
    if (activeId === id) onSelect(null)
    onChanged()
  }
  return (
    <aside className="sidebar">
      <h1><span className="logo">H</span>Heurion 2.0</h1>
      <div className="row">
        <button className="btn" onClick={() => void create('docx')}>+ Word</button>
        <button className="btn" onClick={() => void create('pptx')}>+ PPT</button>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>上传</button>
        <input ref={fileRef} type="file" accept=".docx,.pptx" hidden onChange={async e => {
          const file = e.target.files?.[0]
          if (file) onCreated(await api.createDoc({ file }))
          e.target.value = ''
        }} />
      </div>
      <ul className="doclist">
        {docs.map(d => (
          <li key={d.id} className="doc-item">
            <button className={d.id === activeId ? 'active' : ''} onClick={() => onSelect(d.id)}>
              <span className={`badge ${d.kind}`}>{d.kind === 'docx' ? 'W' : 'P'}</span>
              <span className="doc-title">{d.title}</span>
              <span className="muted">v{d.head_seq}</span>
            </button>
            <button className="doc-del" title="删除文档" onClick={e => { e.stopPropagation(); void remove(d.id, d.title) }}>×</button>
          </li>
        ))}
      </ul>
      <footer className="muted small">评论驱动的并行协作编辑 · 执行层 dsh</footer>
    </aside>
  )
}

function Workspace({ docId, onChanged }: { docId: string; onChanged: () => void }) {
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveStep[]>([])
  const [processing, setProcessing] = useState<Record<string, boolean>>({})
  const [tab, setTab] = useState<'comments' | 'versions' | 'citations'>('comments')
  const [diffSeq, setDiffSeq] = useState<number | null>(null)

  const reloadComments = useCallback(() => api.listComments(docId).then(r => setComments(r.comments)), [docId])
  const reload = useCallback(() => api.getDoc(docId).then(d => { setDoc(d); setRunning(d.busy) }), [docId])
  useEffect(() => { void reload(); void reloadComments() }, [reload, reloadComments])

  const onEvent = (e: UiEvent) => {
    const push = (s: LiveStep) => setLive(prev => [...prev, s])
    switch (e.type) {
      case 'reasoning': return push({ kind: 'reasoning', text: e.text })
      case 'assistant': return push({ kind: 'assistant', text: e.text })
      case 'tool_call': return push({ kind: 'tool', text: e.name.replace(/^mcp__heurion-literature__/, '文献·') })
      case 'tool_result': return push(e.isError && e.code ? { kind: 'error', text: `失败（${e.code}）` } : { kind: 'tool', text: '✓' })
      case 'citation_audit': return push(e.ok
        ? { kind: 'notice', text: '引用校验通过' }
        : { kind: 'error', text: `未登记的 DOI：${e.unregisteredDois.join(', ')}` })
      case 'version':
        push({ kind: 'notice', text: `已保存为 v${e.seq}（编辑器将自动刷新）` })
        void reload()
        return
      case 'id_survival_warning': return push({ kind: 'error', text: `疑似整文重写（id 存活率 ${(e.rate * 100).toFixed(0)}%），评论锚点可能失效` })
      case 'comment_updates':
        void reloadComments()
        if (e.drifted.length > 0) push({ kind: 'error', text: `${e.drifted.length} 条评论锚点漂移` })
        return
      case 'merge_result': {
        void reloadComments()
        const parts: string[] = []
        if (e.applied.length > 0) parts.push(`合并 ${e.applied.length} 处 AI 改动`)
        if (e.overridden.length > 0) parts.push(`你手动更新的 ${e.overridden.length} 处保留了你的版本`)
        if (parts.length > 0) push({ kind: 'notice', text: `并行合并：${parts.join('；')}` })
        return
      }
      case 'error': return push({ kind: 'error', text: e.message })
      default: return
    }
  }

  const finishTurn = async () => {
    setRunning(false)
    setLive(prev => prev.filter(s => s.kind === 'error' || s.kind === 'notice'))
    await reload()
    await reloadComments()
    onChanged()
  }

  const send = async () => {
    const message = input.trim()
    if (!message || running) return
    setInput('')
    setRunning(true)
    setLive([])
    try {
      await api.chat(docId, message, onEvent)
    } catch (err) {
      onEvent({ type: 'error', message: (err as Error).message })
    } finally {
      await finishTurn()
    }
  }

  /** 评论触发 AI 回合（#3）：prompt 由服务端组装，前端只发信号。 */
  const processComment = async (cid: string) => {
    if (running || processing[cid]) return
    setProcessing(prev => ({ ...prev, [cid]: true }))
    setRunning(true)
    setLive([])
    try {
      await api.processComment(docId, cid, onEvent)
    } catch (err) {
      onEvent({ type: 'error', message: (err as Error).message })
    } finally {
      setProcessing(prev => ({ ...prev, [cid]: false }))
      await finishTurn()
    }
  }

  if (!doc) return <div className="empty">加载中…</div>
  const head = doc.versions[0]
  return (
    <main className="workspace">
      {/* 中栏：对话（AI 过程可视化） */}
      <section className="chat">
        <header className="pane-head">
          <strong>{doc.title}</strong>
          <span className="muted small">{head ? `v${head.seq}` : '无版本'}</span>
        </header>
        <div className="messages">
          {doc.messages.map(m => <div key={m.id} className={`msg ${m.role}`}>{m.text}</div>)}
          {live.map((s, i) => <div key={`l${i}`} className={`step ${s.kind}`}>{s.text}</div>)}
          {running && <div className="step notice">AI 正在编辑…（改动落版后编辑器自动刷新）</div>}
        </div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send() }}>
          <textarea
            value={input}
            placeholder={doc.kind === 'docx' ? '对 AI 下整体指令，例如：把讨论部分改得更精炼' : '例如：新增一页总结主要终点结果'}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }}
          />
          {running
            ? <button type="button" className="btn danger" onClick={() => void api.cancel(docId)}>停止</button>
            : <button type="submit" className="btn primary" disabled={!input.trim()}>发送</button>}
        </form>
      </section>

      {/* 编辑器：常驻（Collabora iframe），AI 落版后由外部变更检测自动刷新 */}
      <section className="editor">
        {head
          ? <EditorPane docId={docId} title={doc.title} headSeq={head.seq} busy={running} openAutoComments={openCount(comments)} />
          : <div className="editor-empty">
              <p>还没有文件。</p>
              <p className="muted">在左侧对话里说一句需求，让 AI 起草全文（引用会自动走文献库）；<br />或点右上角「上传」导入现有 docx/pptx。</p>
            </div>}
      </section>

      {/* 右栏：评论 / 版本 / 引用 */}
      <aside className="panel">
        <nav className="tabs">
          <button className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>
            评论{openCount(comments) > 0 && <span className="tab-badge">{openCount(comments)}</span>}
          </button>
          <button className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>版本</button>
          <button className={tab === 'citations' ? 'on' : ''} onClick={() => setTab('citations')}>引用 {doc.citations.length}</button>
        </nav>
        <div className="pane-body">
          {tab === 'comments' && (
            <CommentsPanel docId={docId} kind={doc.kind} comments={comments} running={running} processing={processing}
              onProcess={cid => void processComment(cid)} onChanged={() => void reloadComments()} />
          )}
          {tab === 'versions' && (
            <VersionsPanel doc={doc} comments={comments} running={running} diffSeq={diffSeq} setDiffSeq={setDiffSeq}
              onRestore={async seq => { await api.restore(doc.id, seq); await finishTurn() }}
              onChanged={() => { void reloadComments(); void reload() }} />
          )}
          {tab === 'citations' && (
            <ol className="citations">{doc.citations.map(c => <li key={c.doi}>{c.formatted}</li>)}</ol>
          )}
        </div>
      </aside>
    </main>
  )
}

const openCount = (cs: Comment[]) => cs.filter(c => c.status === 'open').length

/** 编辑器面板：Collabora iframe 常驻；表单提交 access_token（WOPI 标准嵌入）。 */
function EditorPane({ docId, title, headSeq, busy, openAutoComments }: {
  docId: string; title: string; headSeq: number; busy: boolean; openAutoComments: number
}) {
  const [info, setInfo] = useState<{ urlsrc: string; access_token: string; wopisrc: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    setInfo(null); setErr(null)
    api.getEditor(docId).then(setInfo).catch(e => setErr((e as Error).message))
  }, [docId])
  useEffect(() => {
    if (!info) return
    const t = setTimeout(() => formRef.current?.submit(), 150)
    return () => clearTimeout(t)
  }, [info])
  return (
    <div className="editor-inner">
      <div className="pane-head editor-bar">
        <strong>{title}</strong>
        <span className="muted small">在编辑器里选中内容添加评论，写 @heurion 保存后自动处理</span>
        <a className="btn ghost small" href={api.downloadUrl(docId, headSeq)}>下载</a>
      </div>
      {busy && (
        <div className="ai-banner">
          <span className="pulse" /> AI 正在修改文档{openAutoComments > 0 ? `（评论队列 ${openAutoComments} 条待处理）` : ''} — 完成落版后编辑器会自动刷新，此刻保存会被暂时拒绝
        </div>
      )}
      {err
        ? <div className="editor-empty">
            <p>{err}</p>
            <button className="btn" onClick={() => { void api.getEditor(docId).then(setInfo).catch(e => setErr((e as Error).message)) }}>重试</button>
          </div>
        : !info
          ? <div className="editor-empty"><p>编辑器加载中…</p></div>
          : <>
            <form ref={formRef}
              action={`${info.urlsrc}WOPISrc=${encodeURIComponent(info.wopisrc)}&title=${encodeURIComponent(title)}`}
              method="post" target="coolframe" style={{ display: 'none' }}>
              <input type="hidden" name="access_token" value={info.access_token} />
              <input type="hidden" name="access_token_ttl" value="0" />
            </form>
            <iframe name="coolframe" title="Collabora" className="editor-frame" />
          </>}
    </div>
  )
}

/** 评论面板：编辑器内评论是主入口；线程卡 + 请 AI 处理 + 回复/关闭。 */
function CommentsPanel({ docId, kind, comments, running, processing, onProcess, onChanged }: {
  docId: string
  kind: DocKind
  comments: Comment[]
  running: boolean
  processing: Record<string, boolean>
  onProcess: (cid: string) => void
  onChanged: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const open = comments.filter(c => c.status === 'open')
  const resolved = comments.filter(c => c.status === 'resolved')

  const thread = (c: Comment) => {
    const isExpanded = expanded[c.id] ?? c.status === 'open'
    const busy = processing[c.id] || (running && c.status === 'open' && c.last_auto_reply_id != null)
    const lastReply = c.replies[c.replies.length - 1]
    const autoPending = busy && c.last_auto_reply_id != null && lastReply?.role === 'user'
    return (
      <li key={c.id} className={`card comment ${c.status} ${c.drifted ? 'drifted' : ''} ${autoPending ? 'working' : ''}`}>
        <button className="comment-head" onClick={() => setExpanded(p => ({ ...p, [c.id]: !isExpanded }))}>
          <span className={`chip ${c.status === 'open' ? 'chip-open' : 'chip-done'}`}>{c.status === 'open' ? '待处理' : '已关闭'}</span>
          {c.drifted && <span className="chip chip-warn">漂移</span>}
          {c.last_auto_reply_id && <span className="chip chip-auto">@heurion</span>}
          <span className="ellipsis quote-preview">{c.anchor.text_snippet || '（整文档指令）'}</span>
        </button>
        {isExpanded && (
          <div className="comment-body">
            {c.anchor.text_snippet && <blockquote className="anchor-quote">{c.anchor.text_snippet}</blockquote>}
            {c.located === false && c.candidates && c.candidates.length > 0 && (
              <p className="hint">锚点漂移，候选位置：{c.candidates.map(x => x.text.slice(0, 30)).join(' / ')}</p>
            )}
            <ul className="replies">
              {c.replies.map((r, i) => (
                <li key={r.id} className={`bubble ${r.role}`}>
                  <div className="bubble-meta">
                    {r.role === 'ai'
                      ? <><span className="avatar">H</span><strong>Heurion</strong></>
                      : <><span className="avatar user-avatar">你</span><strong>你</strong></>}
                    <span className="muted">{fmtTime(r.created_at)}</span>
                  </div>
                  <div className="bubble-text">{r.text}</div>
                </li>
              ))}
            </ul>
            {autoPending && <div className="bubble working-hint"><span className="pulse" /> AI 正在根据这条评论修改文档…（完成后这里会出现说明，编辑器自动刷新）</div>}
            {c.status === 'open' && (
              <div className="comment-actions">
                <input
                  className="reply-input" placeholder="让 Heurion 修改…"
                  value={drafts[c.id] ?? ''}
                  disabled={busy || running}
                  onChange={e => setDrafts(p => ({ ...p, [c.id]: e.target.value }))}
                  onKeyDown={async e => {
                    const v = (drafts[c.id] ?? '').trim()
                    if (e.key === 'Enter' && v) {
                      setDrafts(p => ({ ...p, [c.id]: '' }))
                      await api.askHeurion(docId, c.id, v)
                      onChanged()
                    }
                  }}
                />
                <button className="btn ghost small" disabled={busy || running} onClick={async () => { await api.resolveComment(docId, c.id); onChanged() }}>完成</button>
              </div>
            )}
            {c.status === 'resolved' && (
              <div className="comment-actions">
                <span className="muted small">由 {c.resolved_by === 'ai' ? 'AI' : '你'} 关闭</span>
                <button className="btn ghost small" onClick={async () => { await api.reopenComment(docId, c.id); onChanged() }}>重新打开</button>
              </div>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="comments-pane">
      <p className="hint guide">
        {kind === 'docx'
          ? '在编辑器里选中文字 → Comment → 写「@heurion + 要求」→ Ctrl+S 保存，AI 自动处理；不带 @heurion 的评论用线程里的「请 AI 处理」手动触发。'
          : '在编辑器/画布里给形状加评论，评论里写「@heurion + 要求」→ 保存后 AI 自动处理。'}
      </p>
      {open.map(thread)}
      {resolved.map(thread)}
      {comments.length === 0 && <p className="muted small center">还没有评论</p>}
    </div>
  )
}

/** 版本面板：来源徽标 + 锚点连续率 + 对比 diff + 回滚（+ deck 画布评审）。 */
function VersionsPanel({ doc, comments, running, diffSeq, setDiffSeq, onRestore, onChanged }: {
  doc: DocDetail
  comments: Comment[]
  running: boolean
  diffSeq: number | null
  setDiffSeq: (v: number | null) => void
  onRestore: (seq: number) => Promise<void>
  onChanged: () => void
}) {
  const head = doc.versions[0]
  return (
    <div>
      <ul className="versions">
        {doc.versions.map(v => {
          const rate = v.meta?.id_survival
          return (
            <li key={v.seq} className="version-row">
              <span className={`chip src ${SOURCE_META[v.source].cls}`}>{SOURCE_META[v.source].label}</span>
              <span className="ver-seq">v{v.seq}</span>
              <span className="ellipsis ver-note" title={v.note}>{v.note}</span>
              <span className="actions">
                {rate !== undefined && rate !== null && (
                  <span className={`chip small-chip ${rate < 0.8 ? 'chip-warn' : 'chip-ok'}`}>锚点 {Math.round(rate * 100)}%</span>
                )}
                {v.seq > 1 && (
                  <button className="btn ghost small" onClick={() => setDiffSeq(diffSeq === v.seq ? null : v.seq)}>
                    {diffSeq === v.seq ? '收起' : '对比'}
                  </button>
                )}
                <a className="btn ghost small" href={api.downloadUrl(doc.id, v.seq)}>下载</a>
                {v.seq !== head?.seq && !running && (
                  <button className="btn ghost small" onClick={() => void onRestore(v.seq)}>回滚</button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {diffSeq && <DiffView docId={doc.id} seq={diffSeq} />}
      {doc.kind === 'pptx' && head && <DeckCanvas docId={doc.id} headSeq={head.seq} comments={comments} onChanged={onChanged} />}
    </div>
  )
}

/** 版本对比：与上一版投影按 id 三态 diff。 */
function DiffView({ docId, seq }: { docId: string; seq: number }) {
  const [rows, setRows] = useState<Array<{ state: 'added' | 'removed' | 'modified'; text: string }> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let ok = true
    void (async () => {
      try {
        const now = await api.getProjection(docId, seq)
        const prev = await api.getProjection(docId, seq - 1)
        const flat = (p: Projection) => [...(p.nodes ?? []), ...(p.slides ?? []).flatMap(s => s.shapes)]
        const prevById = new Map(flat(prev.projection).map(n => [n.id, n]))
        const out: Array<{ state: 'added' | 'removed' | 'modified'; text: string }> = []
        for (const n of flat(now.projection)) {
          const p = prevById.get(n.id)
          if (!p) out.push({ state: 'added', text: n.text })
          else if (p.text !== n.text) out.push({ state: 'modified', text: `${p.text.slice(0, 40)} → ${n.text.slice(0, 40)}` })
        }
        const nowIds = new Set(flat(now.projection).map(n => n.id))
        for (const n of flat(prev.projection)) if (!nowIds.has(n.id)) out.push({ state: 'removed', text: n.text })
        if (ok) setRows(out)
      } catch (e) { if (ok) setErr((e as Error).message) }
    })()
    return () => { ok = false }
  }, [docId, seq])
  if (err) return <p className="hint">diff 不可用：{err}</p>
  if (!rows) return <p className="muted small">计算 diff…</p>
  if (rows.length === 0) return <p className="muted small">v{seq - 1} → v{seq} 无文本变化</p>
  return (
    <ul className="diff card">
      {rows.map((r, i) => (
        <li key={i} className={`diff-${r.state}`}>
          <span>{r.state === 'added' ? '+' : r.state === 'removed' ? '−' : '~'}</span>{r.text}
        </li>
      ))}
    </ul>
  )
}

/** deck 评审画布：投影几何 + 评论锚点两态 overlay + 三态 diff + 点形状加评论。 */
const SLIDE_W = 12192000
const SLIDE_H = 6858000

function DeckCanvas({ docId, headSeq, comments, onChanged }: {
  docId: string; headSeq: number; comments: Comment[]; onChanged: () => void
}) {
  const [proj, setProj] = useState<Projection | null>(null)
  const [prev, setPrev] = useState<Projection | null>(null)
  const [diffOn, setDiffOn] = useState(true)
  const [pending, setPending] = useState<ProjectionNode | null>(null)
  const [pendingText, setPendingText] = useState('')
  useEffect(() => {
    void api.getProjection(docId).then(r => setProj(r.projection)).catch(() => setProj(null))
    if (headSeq > 1) void api.getProjection(docId, headSeq - 1).then(r => setPrev(r.projection)).catch(() => setPrev(null))
  }, [docId, headSeq])

  const shapeState = (n: ProjectionNode): 'added' | 'removed' | 'modified' | null => {
    if (!diffOn || !prev) return null
    const prevShapes = new Map((prev.slides ?? []).flatMap(s => s.shapes).map(x => [x.id, x]))
    const p = prevShapes.get(n.id)
    if (!p) return 'added'
    if (p.text !== n.text) return 'modified'
    return null
  }
  const openComments = comments.filter(c => c.status === 'open' && c.anchor.shape_id)
  const commentByShape = new Map(openComments.map(c => [c.anchor.shape_id!, c]))

  const submitShapeComment = async () => {
    if (!pending || !pendingText.trim()) return
    await api.createComment(docId, {
      text: pendingText.trim(),
      shape_id: pending.id,
      slide_id: (proj?.slides ?? []).find(s => s.shapes.some(x => x.id === pending.id))?.id,
      text_snippet: pending.text || undefined,
    })
    setPending(null)
    setPendingText('')
    onChanged()
  }

  if (!proj) return <p className="muted small">暂无画布投影</p>
  return (
    <div className="deck-canvas">
      <div className="deck-bar">
        {prev && <label className="muted small"><input type="checkbox" checked={diffOn} onChange={e => setDiffOn(e.target.checked)} /> 形状级 diff（对照上一版）</label>}
        <span className="muted small">点形状加评论</span>
      </div>
      {(proj.slides ?? []).map(slide => (
        <div key={slide.id} className="slide">
          <div className="slide-label">第 {slide.index} 页</div>
          <div className="slide-canvas">
            {slide.shapes.map(sh => {
              const st = shapeState(sh)
              const c = commentByShape.get(sh.id)
              const cls = ['shape', c ? (c.drifted ? 'anchor-drift' : 'anchor') : '', st ? `diff-${st}` : ''].filter(Boolean).join(' ')
              const g = sh.geometry
              const style = g ? {
                left: `${(g.x / SLIDE_W) * 100}%`, top: `${(g.y / SLIDE_H) * 100}%`,
                width: `${(g.w / SLIDE_W) * 100}%`, height: `${(g.h / SLIDE_H) * 100}%`,
                transform: g.rot ? `rotate(${g.rot}deg)` : undefined,
              } : undefined
              return (
                <div key={sh.id} className={cls} style={style} title={sh.id} onClick={() => g && setPending(sh)}>
                  {sh.kind === 'opaque' && !sh.text ? <span className="muted">[无预览对象]</span> : sh.text}
                  {st && <span className="diff-tag">{st}</span>}
                  {c && <span className="diff-tag">{c.drifted ? '评论漂移' : '评论'}</span>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {pending && (
        <div className="card pending-comment">
          <p className="small"><strong>给选中形状加评论</strong><span className="muted"> · {pending.text.slice(0, 30) || pending.id}</span></p>
          <textarea autoFocus value={pendingText} placeholder="要求 AI 对这个形状做什么…" onChange={e => setPendingText(e.target.value)} />
          <div className="comment-actions">
            <button className="btn ghost small" onClick={() => setPending(null)}>取消</button>
            <button className="btn primary small" disabled={!pendingText.trim()} onClick={() => void submitShapeComment()}>添加</button>
          </div>
        </div>
      )}
    </div>
  )
}
