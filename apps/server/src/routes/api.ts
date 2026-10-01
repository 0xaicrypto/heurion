import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { DocKind, Store } from '../db.ts'
import { auditCommentAnchors, locateAnchor } from '../docs/comments.ts'
import type { CommentAutomation } from '../docs/comment-automation.ts'
import { buildCommentPrompt } from '../docs/turn.ts'
import type { HarnessPool } from '../harness/pool.ts'
import { BusyError, type TurnService } from '../docs/turn.ts'
import type { DocFiles } from '../docs/workspace.ts'

export interface ApiDeps {
  store: Store
  files: DocFiles
  pool: HarnessPool
  turns: TurnService
  automation: CommentAutomation
  devToken: string
}

const MIME: Record<DocKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function kindFromName(name: string): DocKind | null {
  const ext = name.toLowerCase().split('.').pop()
  return ext === 'docx' || ext === 'pptx' ? ext : null
}

export function buildApi(deps: ApiDeps): Hono {
  const { store, files, pool, turns } = deps
  const app = new Hono()

  // 多用户鉴权落地前的占位：单一开发令牌。下载链接用 ?token=（<a> 无法带 header）。
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    if (token !== deps.devToken) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  app.get('/api/docs', c => c.json(store.listDocs()))

  app.post('/api/docs', async c => {
    // JSON（程序/API 调用）与 multipart（上传）都收。
    if (c.req.header('content-type')?.includes('application/json')) {
      const body = await c.req.json<{ title?: string; kind?: string }>()
      const kind: DocKind | null = body.kind === 'pptx' ? 'pptx' : body.kind === 'docx' ? 'docx' : null
      if (!kind) return c.json({ error: 'kind 必须是 docx / pptx' }, 400)
      const doc = store.createDoc(randomUUID(), body.title?.trim() || '未命名', kind)
      return c.json(store.getDoc(doc.id), 201)
    }
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    const kind = file ? kindFromName(file.name) : (form.kind === 'pptx' ? 'pptx' : form.kind === 'docx' ? 'docx' : null)
    if (!kind) return c.json({ error: '只支持 .docx / .pptx' }, 400)
    const title = typeof form.title === 'string' && form.title.trim() ? form.title.trim() : (file?.name ?? '未命名')
    const doc = store.createDoc(randomUUID(), title, kind)
    if (file) files.importUpload(doc.id, kind, new Uint8Array(await file.arrayBuffer()))
    return c.json(store.getDoc(doc.id), 201)
  })

  app.delete('/api/docs/:id', c => {
    const docId = c.req.param('id')
    if (!store.getDoc(docId)) return c.json({ error: 'not found' }, 404)
    if (pool.isBusy(docId)) return c.json({ error: 'AI 正在编辑这份文档' }, 409)
    void pool.cancel(docId) // dsh 进程一起回收
    store.deleteDoc(docId)
    files.deleteDocFiles(docId)
    return c.json({ ok: true })
  })

  app.get('/api/docs/:id', c => {
    const doc = store.getDoc(c.req.param('id'))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({
      ...doc,
      busy: pool.isBusy(doc.id),
      versions: store.listVersions(doc.id),
      messages: store.listMessages(doc.id),
      citations: store.listCitations(doc.id),
    })
  })

  // 版本投影（S1）：前端预览/diff/锚点定位的统一数据源。
  app.get('/api/docs/:id/projection', c => {
    const doc = store.getDoc(c.req.param('id'))
    if (!doc) return c.json({ error: 'not found' }, 404)
    const seqParam = c.req.query('seq')
    const seq = seqParam ? Number(seqParam) : doc.head_seq
    const row = store.getProjection(doc.id, seq)
    if (!row) return c.json({ error: 'no projection' }, 404)
    return c.json({ doc_id: doc.id, seq, projection: row.projection })
  })

  app.get('/api/docs/:id/versions/:seq/file', c => {
    const doc = store.getDoc(c.req.param('id'))
    const seq = Number(c.req.param('seq'))
    if (!doc || !store.getVersion(doc.id, seq)) return c.json({ error: 'not found' }, 404)
    const bytes = files.readVersion(doc.id, seq)
    const name = encodeURIComponent(`${doc.title.replace(/\.(docx|pptx)$/i, '')}-v${seq}.${doc.kind}`)
    return c.body(Buffer.from(bytes), 200, {
      'Content-Type': MIME[doc.kind],
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    })
  })

  app.post('/api/docs/:id/versions/:seq/restore', c => {
    const doc = store.getDoc(c.req.param('id'))
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (pool.isBusy(doc.id)) return c.json({ error: 'AI 正在编辑这份文档' }, 409)
    return c.json(files.restore(doc.id, Number(c.req.param('seq'))))
  })

  app.post('/api/docs/:id/chat', async c => {
    const docId = c.req.param('id')
    if (!store.getDoc(docId)) return c.json({ error: 'not found' }, 404)
    if (pool.isBusy(docId)) return c.json({ error: 'AI 正在编辑这份文档' }, 409)
    const { message } = await c.req.json<{ message?: string }>()
    if (!message?.trim()) return c.json({ error: 'message required' }, 400)
    return streamTurn(c, deps, docId, message.trim())
  })

  // —— 评论（S2/S3） ——

  app.get('/api/docs/:id/comments', c => {
    const docId = c.req.param('id')
    if (!store.getDoc(docId)) return c.json({ error: 'not found' }, 404)
    const doc = store.getDoc(docId)!
    const projection = doc.head_seq > 0 ? store.getProjection(docId, doc.head_seq)?.projection : undefined
    if (projection) {
      // 读取时惰性重审计：drifted 标志与最新投影保持一致（幂等、开销可忽略）。
      auditCommentAnchors(store, docId, doc.head_seq, projection)
    }
    const comments = store.listComments(docId).map(c => ({
      ...c,
      ...(c.status === 'open' && projection ? locateAnchor(c.anchor, projection) : {}),
    }))
    return c.json({ comments })
  })

  app.post('/api/docs/:id/comments', async c => {
    const docId = c.req.param('id')
    if (!store.getDoc(docId)) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text_snippet?: string; para_id?: string; shape_id?: string; slide_id?: string; section_index?: number; text?: string }>()
    const snippet = body.text_snippet?.trim()
    const comment = body.text?.trim()
    if (!snippet && !comment) return c.json({ error: 'text_snippet 或 text 至少填一项' }, 400)
    const row = store.addComment(docId, {
      para_id: body.para_id || undefined,
      shape_id: body.shape_id || undefined,
      slide_id: body.slide_id || undefined,
      section_index: body.section_index,
      // 无选区评论（纯指令）没有片段冗余，锚定退化为「整文档」级。
      text_snippet: snippet ?? '',
    })
    if (comment) store.addReply(docId, row.id, 'user', comment)
    // @heurion 自动触发（评论即指令）
    deps.automation.scan(docId, [row.id])
    return c.json(row, 201)
  })

  app.post('/api/docs/:id/comments/:cid/replies', async c => {
    const docId = c.req.param('id')
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: 'text required' }, 400)
    if (!store.getComment(docId, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const reply = store.addReply(docId, c.req.param('cid'), 'user', text.trim())
    deps.automation.scan(docId, [c.req.param('cid')])
    return c.json(reply, 201)
  })

  app.post('/api/docs/:id/comments/:cid/resolve', c => {
    const docId = c.req.param('id')
    if (!store.getComment(docId, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: store.resolveComment(docId, c.req.param('cid'), 'user') })
  })

  app.post('/api/docs/:id/comments/:cid/reopen', c => {
    const docId = c.req.param('id')
    if (!store.getComment(docId, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: store.reopenComment(docId, c.req.param('cid')) })
  })

  // 线程内召唤（Claude 式「Ask Claude to edit」）：输入即触发，无需 @heurion。
  app.post('/api/docs/:id/comments/:cid/ask', async c => {
    const docId = c.req.param('id')
    const cid = c.req.param('cid')
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: 'text required' }, 400)
    if (!store.getComment(docId, cid)) return c.json({ error: 'not found' }, 404)
    if (pool.isBusy(docId)) return c.json({ error: 'AI 正在编辑这份文档，稍候' }, 409)
    store.addReply(docId, cid, 'user', text.trim())
    deps.automation.force(docId, cid)
    return c.json({ ok: true, queued: true })
  })

  app.delete('/api/docs/:id/comments/:cid', c => {
    const docId = c.req.param('id')
    return c.json({ ok: store.deleteComment(docId, c.req.param('cid')) })
  })

  // 评论触发 AI 回合（S3）：prompt 由服务端组装，前端不拼自然语言。
  app.post('/api/docs/:id/comments/:cid/process', c => {
    const docId = c.req.param('id')
    const cid = c.req.param('cid')
    if (!store.getDoc(docId)) return c.json({ error: 'not found' }, 404)
    if (!store.getComment(docId, cid)) return c.json({ error: 'not found' }, 404)
    if (pool.isBusy(docId)) return c.json({ error: 'AI 正在编辑这份文档' }, 409)
    return streamTurn(c, deps, docId, buildCommentPrompt(cid), { commentId: cid })
  })

  app.post('/api/docs/:id/cancel', async c => {
    await pool.cancel(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}

/** 聊天与评论触发共用的 SSE 回合管线。 */
function streamTurn(c: Context, deps: ApiDeps, docId: string, message: string, opts: { commentId?: string } = {}) {
  const { turns } = deps
  return streamSSE(c, async stream => {
    // 串行写入并在结束前等待全部写完：否则回调返回、流关闭时未写出的事件会丢失
    let writes = Promise.resolve()
    const emit = (e: unknown) => { writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) })) }
    try {
      await turns.run(docId, message, emit, opts)
    } catch (err) {
      console.error('[chat] turn failed', err)
      emit({ type: 'error', message: err instanceof BusyError ? err.message : String((err as Error).message ?? err) })
    }
    emit({ type: 'done' })
    await writes
  })
}
