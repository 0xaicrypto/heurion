export type DocKind = 'docx' | 'pptx'

export interface Doc {
  id: string
  title: string
  kind: DocKind
  head_seq: number
  updated_at: string
}

export interface Version { seq: number; source: 'upload' | 'ai' | 'restore'; note: string; created_at: string }
export interface Message { id: number; role: 'user' | 'assistant'; text: string }
export interface Citation { doi: string; formatted: string }
export interface DocDetail extends Doc { busy: boolean; versions: Version[]; messages: Message[]; citations: Citation[] }

export type UiEvent =
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; isError: boolean }
  | { type: 'turn_end'; reason: string }
  | { type: 'version'; seq: number }
  | { type: 'citation_audit'; ok: boolean; unregisteredDois: string[] }
  | { type: 'error'; message: string }
  | { type: 'done' }

// 多用户鉴权落地前：开发令牌（与服务端 HEURION_DEV_TOKEN 一致）。
const TOKEN = import.meta.env.VITE_HEURION_TOKEN ?? 'dev'
const auth = { Authorization: `Bearer ${TOKEN}` }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  listDocs: () => fetch('/api/docs', { headers: auth }).then(r => json<Doc[]>(r)),
  getDoc: (id: string) => fetch(`/api/docs/${id}`, { headers: auth }).then(r => json<DocDetail>(r)),
  createDoc: (input: { title: string; kind: DocKind } | { file: File }) => {
    const form = new FormData()
    if ('file' in input) form.set('file', input.file)
    else { form.set('title', input.title); form.set('kind', input.kind) }
    return fetch('/api/docs', { method: 'POST', headers: auth, body: form }).then(r => json<Doc>(r))
  },
  restore: (id: string, seq: number) =>
    fetch(`/api/docs/${id}/versions/${seq}/restore`, { method: 'POST', headers: auth }).then(r => json<Version>(r)),
  cancel: (id: string) => fetch(`/api/docs/${id}/cancel`, { method: 'POST', headers: auth }),
  downloadUrl: (id: string, seq: number) => `/api/docs/${id}/versions/${seq}/file?token=${encodeURIComponent(TOKEN)}`,

  /** POST + 读 SSE 流（EventSource 不支持 POST）。 */
  async chat(id: string, message: string, onEvent: (e: UiEvent) => void): Promise<void> {
    const res = await fetch(`/api/docs/${id}/chat`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
        if (data) onEvent(JSON.parse(data) as UiEvent)
      }
    }
  },
}
