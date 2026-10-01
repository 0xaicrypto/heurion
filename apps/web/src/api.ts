export type DocKind = 'docx' | 'pptx'

export interface Doc {
  id: string
  title: string
  kind: DocKind
  head_seq: number
  updated_at: string
}

export interface Version { seq: number; source: 'upload' | 'user' | 'ai' | 'restore'; note: string; created_at: string; meta?: { id_survival?: number | null } }
export interface Message { id: number; role: 'user' | 'assistant'; text: string }
export interface Citation { doi: string; formatted: string }
export interface DocDetail extends Doc { busy: boolean; versions: Version[]; messages: Message[]; citations: Citation[] }

export interface CommentAnchor { para_id?: string; shape_id?: string; slide_id?: string; text_snippet: string; section_index?: number }
export interface CommentReply { id: string; role: 'user' | 'ai'; text: string; created_at: string }
export interface Comment {
  id: string; kind: DocKind; anchor: CommentAnchor
  status: 'open' | 'resolved'; resolved_by: 'user' | 'ai' | null; drifted: boolean
  created_at: string; replies: CommentReply[]
  located?: boolean; candidates?: Array<{ id: string; text: string }>
  /** 最近一次 @heurion 自动触发时的用户回复 id（非 null = 已配置自动处理）。 */
  last_auto_reply_id?: string | null
}

export type UiEvent =
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; isError: boolean; code?: string }
  | { type: 'turn_end'; reason: string }
  | { type: 'version'; seq: number }
  | { type: 'citation_audit'; ok: boolean; unregisteredDois: string[] }
  | { type: 'id_survival_warning'; rate: number }
  | { type: 'comment_updates'; updated: string[]; drifted: string[] }
  | { type: 'merge_result'; applied: string[]; overridden: Array<{ id: string; text: string }> }
  | { type: 'error'; message: string }
  | { type: 'done' }

// 多用户鉴权落地前：开发令牌（与服务端 HEURION_DEV_TOKEN 一致）。
const TOKEN = import.meta.env.VITE_HEURION_TOKEN ?? 'dev'
const auth = { Authorization: `Bearer ${TOKEN}` }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export interface ProjectionNode {
  id: string
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'opaque'
  level?: number
  text: string
  geometry?: { x: number; y: number; w: number; h: number; rot?: number }
  locked?: boolean
}
export interface ProjectionSlide { id: string; index: number; shapes: ProjectionNode[] }
export interface Projection { nodes?: ProjectionNode[]; slides?: ProjectionSlide[] }

export const api = {
  listDocs: () => fetch('/api/docs', { headers: auth }).then(r => json<Doc[]>(r)),
  deleteDoc: (id: string) => fetch(`/api/docs/${id}`, { method: 'DELETE', headers: auth }).then(r => json<{ ok: boolean }>(r)),
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

  listComments: (id: string) => fetch(`/api/docs/${id}/comments`, { headers: auth }).then(r => json<{ comments: Comment[] }>(r)),
  getEditor: (id: string) => fetch(`/api/docs/${id}/editor`, { headers: auth }).then(r => json<{ urlsrc: string; access_token: string; wopisrc: string }>(r)),
  getProjection: (id: string, seq?: number) =>
    fetch(`/api/docs/${id}/projection${seq ? `?seq=${seq}` : ''}`, { headers: auth }).then(r => json<{ seq: number; projection: Projection }>(r)),
  createComment: (id: string, input: { text_snippet?: string; text?: string; shape_id?: string; slide_id?: string }) =>
    fetch(`/api/docs/${id}/comments`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(r => json<Comment>(r)),
  replyComment: (id: string, cid: string, text: string) =>
    fetch(`/api/docs/${id}/comments/${cid}/replies`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => json<CommentReply>(r)),
  resolveComment: (id: string, cid: string) =>
    fetch(`/api/docs/${id}/comments/${cid}/resolve`, { method: 'POST', headers: auth }).then(r => json<{ ok: boolean }>(r)),
  /** 线程内召唤 Heurion 修改（多轮追问）：输入即触发，无需 @heurion。 */
  askHeurion: (id: string, cid: string, text: string) =>
    fetch(`/api/docs/${id}/comments/${cid}/ask`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => json<{ ok: boolean; queued: boolean }>(r)),
  reopenComment: (id: string, cid: string) =>
    fetch(`/api/docs/${id}/comments/${cid}/reopen`, { method: 'POST', headers: auth }).then(r => json<{ ok: boolean }>(r)),

  /** POST + 读 SSE 流（EventSource 不支持 POST）。 */
  async postSse(path: string, body: Record<string, unknown>, onEvent: (e: UiEvent) => void): Promise<void> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

  chat(id: string, message: string, onEvent: (e: UiEvent) => void): Promise<void> {
    return api.postSse(`/api/docs/${id}/chat`, { message }, onEvent)
  },

  /** 评论触发 AI 回合（S3）：prompt 由服务端组装。 */
  processComment(id: string, cid: string, onEvent: (e: UiEvent) => void): Promise<void> {
    return api.postSse(`/api/docs/${id}/comments/${cid}/process`, {}, onEvent)
  },
}
