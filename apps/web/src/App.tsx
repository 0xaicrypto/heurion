import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Doc, type DocDetail, type DocKind, type UiEvent } from './api.ts'

interface LiveStep { kind: 'reasoning' | 'assistant' | 'tool' | 'notice' | 'error'; text: string }

const SOURCE_LABEL = { upload: '上传', ai: 'AI', restore: '回滚' } as const

export function App() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const refreshDocs = useCallback(() => api.listDocs().then(setDocs), [])
  useEffect(() => { void refreshDocs() }, [refreshDocs])

  return (
    <div className="shell">
      <Sidebar docs={docs} activeId={activeId} onSelect={setActiveId} onCreated={d => { void refreshDocs(); setActiveId(d.id) }} />
      {activeId ? <Workspace key={activeId} docId={activeId} onChanged={refreshDocs} /> : <div className="empty">选择或新建一份文档</div>}
    </div>
  )
}

function Sidebar({ docs, activeId, onSelect, onCreated }: {
  docs: Doc[]; activeId: string | null; onSelect: (id: string) => void; onCreated: (d: Doc) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const create = async (kind: DocKind) => onCreated(await api.createDoc({ title: kind === 'docx' ? '新文档' : '新幻灯片', kind }))
  return (
    <aside className="sidebar">
      <h1>Heurion 2.0</h1>
      <div className="row">
        <button onClick={() => void create('docx')}>+ Word</button>
        <button onClick={() => void create('pptx')}>+ PPT</button>
        <button onClick={() => fileRef.current?.click()}>上传</button>
        <input ref={fileRef} type="file" accept=".docx,.pptx" hidden onChange={async e => {
          const file = e.target.files?.[0]
          if (file) onCreated(await api.createDoc({ file }))
          e.target.value = ''
        }} />
      </div>
      <ul className="doclist">
        {docs.map(d => (
          <li key={d.id}>
            <button className={d.id === activeId ? 'active' : ''} onClick={() => onSelect(d.id)}>
              <span className="badge">{d.kind === 'docx' ? 'W' : 'P'}</span>{d.title}
              <span className="muted"> v{d.head_seq}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function Workspace({ docId, onChanged }: { docId: string; onChanged: () => void }) {
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveStep[]>([])
  const reload = useCallback(() => api.getDoc(docId).then(d => { setDoc(d); setRunning(d.busy) }), [docId])
  useEffect(() => { void reload() }, [reload])

  const onEvent = (e: UiEvent) => {
    const push = (s: LiveStep) => setLive(prev => [...prev, s])
    switch (e.type) {
      case 'reasoning': return push({ kind: 'reasoning', text: e.text })
      case 'assistant': return push({ kind: 'assistant', text: e.text })
      case 'tool_call': return push({ kind: 'tool', text: e.name.replace(/^mcp__heurion-literature__/, '文献·') })
      case 'citation_audit': return push(e.ok
        ? { kind: 'notice', text: '引用校验通过' }
        : { kind: 'error', text: `未登记的 DOI：${e.unregisteredDois.join(', ')}` })
      case 'version': return push({ kind: 'notice', text: `已保存为 v${e.seq}` })
      case 'id_survival_warning': return push({ kind: 'error', text: `检测到疑似整文重写（id 存活率 ${(e.rate * 100).toFixed(0)}%），评论锚点可能已失效` })
      case 'error': return push({ kind: 'error', text: e.message })
      default: return
    }
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
      setRunning(false)
      // 过程步骤随回合结束收起，错误与保存结果保留到下一次发送
      setLive(prev => prev.filter(s => s.kind === 'error' || s.kind === 'notice'))
      await reload()
      onChanged()
    }
  }

  if (!doc) return <div className="empty">加载中…</div>
  const head = doc.versions[0]
  return (
    <main className="workspace">
      <section className="chat">
        <header>
          <strong>{doc.title}</strong>
          {head
            ? <a className="button" href={api.downloadUrl(doc.id, head.seq)}>下载 v{head.seq}</a>
            : <span className="muted">还没有文件，让 AI 起草一份</span>}
        </header>
        <div className="messages">
          {doc.messages.map(m => <div key={m.id} className={`msg ${m.role}`}>{m.text}</div>)}
          {live.map((s, i) => <div key={`l${i}`} className={`step ${s.kind}`}>{s.text}</div>)}
          {running && <div className="step notice">AI 正在编辑…</div>}
        </div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send() }}>
          <textarea
            value={input}
            placeholder={doc.kind === 'docx' ? '例如：把讨论部分改得更精炼，并补充两篇支持性文献' : '例如：新增一页总结主要终点结果'}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }}
          />
          {running
            ? <button type="button" onClick={() => void api.cancel(docId)}>停止</button>
            : <button type="submit" disabled={!input.trim()}>发送</button>}
        </form>
      </section>
      <aside className="panel">
        <h2>版本</h2>
        <ul className="versions">
          {doc.versions.map(v => (
            <li key={v.seq}>
              <span>v{v.seq} · {SOURCE_LABEL[v.source]}</span>
              <span className="muted ellipsis" title={v.note}>{v.note}</span>
              <span className="actions">
                <a href={api.downloadUrl(doc.id, v.seq)}>下载</a>
                {v.seq !== head?.seq && !running && (
                  <button className="link" onClick={async () => { await api.restore(doc.id, v.seq); await reload(); onChanged() }}>回滚</button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <h2>引用（{doc.citations.length}）</h2>
        <ol className="citations">{doc.citations.map(c => <li key={c.doi}>{c.formatted}</li>)}</ol>
      </aside>
    </main>
  )
}
