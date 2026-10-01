import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { exportDocx } from '../convert/docx-export.ts'
import { bindAssets, DocxImportError, importDocx } from '../convert/docx-import.ts'
import { AnchorError, attachComment, locate, threadMarks } from '../model/anchors.ts'
import { parseBlocks } from '../model/markdown.ts'
import type { CommitEvent, Documents } from '../model/runtime.ts'
import { schema } from '../model/schema.ts'
import type { OpService } from '../ops/service.ts'
import { EditBatch, OpError } from '../ops/types.ts'
import { BusyError, commentPrompt, type TurnService } from '../turns/service.ts'
import { citationOrder, diff, read } from '../views/read.ts'
import { exportMarkdown, renderHtml } from '../views/render.ts'

export interface ApiDeps {
  docs: Documents
  ops: OpService
  turns: TurnService
  devToken: string
  devUser: string
}

/**
 * 给 web 前端的 REST + SSE。用户写入（编辑、评论锚点、回滚）以 actor=user 进入同一操作层，
 * 不受 AI 守卫阻挡（PLATFORM.md §5.3）。
 */
export function buildApi(deps: ApiDeps): Hono<{ Variables: { user: string } }> {
  const { docs, ops, turns } = deps
  const store = docs.store
  const app = new Hono<{ Variables: { user: string } }>()

  // 开发期鉴权：单一令牌映射到单一用户（M2 换成账户体系）。EventSource / <img> 用 ?token=。
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    if (token !== deps.devToken) return c.json({ error: 'unauthorized' }, 401)
    c.set('user', deps.devUser)
    await next()
  })

  const owned = (c: Context<{ Variables: { user: string } }>) => {
    const row = store.getDoc(c.req.param('id')!)
    return row && row.owner === c.get('user') ? row : null
  }
  const assetUrl = (token: string) => (id: string) => `/api/assets/${id}?token=${encodeURIComponent(token)}`

  app.get('/api/docs', c => c.json(store.listDocs(c.get('user'))))

  app.post('/api/docs', async c => {
    const user = c.get('user')
    if (c.req.header('content-type')?.includes('application/json')) {
      const body = await c.req.json<{ title?: string; markdown?: string }>()
      const content = body.markdown?.trim() ? schema.node('doc', null, parseBlocks(body.markdown)) : undefined
      return c.json(docs.create({ owner: user, title: body.title?.trim() || '未命名', content }), 201)
    }
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    if (!file || !/\.docx$/i.test(file.name)) return c.json({ error: '只支持上传 .docx（pptx 在 P2）' }, 400)
    try {
      const imported = importDocx(new Uint8Array(await file.arrayBuffer()))
      const ids = new Map(imported.assets.map(a => [a.key, store.putAsset({ owner: user, mime: a.mime, name: a.name, bytes: a.bytes }).id]))
      const row = docs.create({ owner: user, title: file.name.replace(/\.docx$/i, ''), content: bindAssets(imported.doc, ids), source: 'import' })
      store.putNodeSrc(row.id, imported.src)
      store.putPackage(row.id, 'docx', new Uint8Array(await file.arrayBuffer()))
      return c.json({ ...row, warnings: imported.warnings }, 201)
    } catch (err) {
      if (err instanceof DocxImportError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.get('/api/docs/:id', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const doc = docs.get(row.id)
    const order = citationOrder(doc)
    const marks = threadMarks(doc)
    return c.json({
      ...row,
      rev: docs.rev(row.id),
      busy: turns.isBusy(c.get('user')),
      versions: store.listVersions(row.id),
      messages: store.listMessages(row.id),
      citations: store.listCitations(row.id).map(x => ({ ...x, number: order.includes(x.id) ? order.indexOf(x.id) + 1 : null })),
      comments: store.listComments(row.id).map(x => ({ ...x, anchor: locate(doc, x, marks) })),
    })
  })

  app.patch('/api/docs/:id', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { title } = await c.req.json<{ title?: string }>()
    if (title?.trim()) store.renameDoc(row.id, title.trim())
    return c.json(store.getDoc(row.id))
  })

  app.delete('/api/docs/:id', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    docs.unload(row.id)
    store.deleteDoc(row.id)
    return c.json({ ok: true })
  })

  app.get('/api/docs/:id/html', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const seq = c.req.query('version')
    const doc = seq ? docs.versionDoc(row.id, Number(seq)) : docs.get(row.id)
    if (!doc) return c.json({ error: 'version not found' }, 404)
    return c.json({ rev: docs.rev(row.id), html: renderHtml(doc, store.listCitations(row.id), assetUrl(c.req.query('token') ?? deps.devToken)) })
  })

  /** 读视图（与 MCP doc_read 相同），便于调试模型看到的内容。 */
  app.get('/api/docs/:id/read', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.text(read({ doc: docs.get(row.id), docId: row.id, rev: docs.rev(row.id), comments: store.listComments(row.id, 'open') }))
  })

  app.get('/api/docs/:id/export.md', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.body(exportMarkdown(docs.get(row.id), store.listCitations(row.id)), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.md`,
    })
  })

  app.get('/api/docs/:id/export.docx', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const result = docxFor(docs, row.id)
    return c.body(Buffer.from(result.bytes), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.docx`,
      ...(result.warnings.length > 0 ? { 'X-Heurion-Warnings': encodeURIComponent(result.warnings.join('；')) } : {}),
    })
  })

  /** 用户编辑（P1 编辑器上线前的入口）：同一操作层，actor=user。 */
  app.post('/api/docs/:id/edit', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const parsed = EditBatch.safeParse({ ...(await c.req.json<object>()), doc_id: row.id })
    if (!parsed.success) return c.json({ code: 'validation_error', message: parsed.error.message }, 400)
    try {
      return c.json(ops.edit(parsed.data, { actor: 'user', turnId: null }))
    } catch (err) {
      if (err instanceof OpError) return c.json(err.toJSON(), 409)
      throw err
    }
  })

  /** 用户显式保存一个版本。 */
  app.post('/api/docs/:id/save', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({ version: docs.snapshot(row.id, 'user', '手动保存') })
  })

  app.post('/api/docs/:id/versions/:seq/restore', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    if (turns.isBusy(c.get('user'))) return c.json({ error: 'AI 正在编辑，先取消或等待完成' }, 409)
    return c.json({ version: docs.restore(row.id, Number(c.req.param('seq'))), rev: docs.rev(row.id) })
  })

  app.get('/api/docs/:id/diff', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const before = docs.versionDoc(row.id, Number(c.req.query('from')))
    const to = c.req.query('to')
    const after = to ? docs.versionDoc(row.id, Number(to)) : docs.get(row.id)
    if (!before || !after) return c.json({ error: 'version not found' }, 404)
    return c.json({ changes: diff(before, after) })
  })

  /** 文档变更推送（预览实时刷新）。 */
  app.get('/api/docs/:id/stream', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return streamSSE(c, async stream => {
      let closed = false
      const queue: CommitEvent[] = []
      let wake: (() => void) | null = null
      const listener = (e: CommitEvent) => {
        if (e.docId !== row.id) return
        queue.push(e)
        wake?.()
      }
      docs.on('commit', listener)
      stream.onAbort(() => { closed = true; wake?.() })
      await stream.writeSSE({ data: JSON.stringify({ rev: docs.rev(row.id) }) })
      try {
        while (!closed) {
          if (queue.length === 0) await new Promise<void>(r => { wake = r; setTimeout(r, 25_000) })
          wake = null
          const batch = queue.splice(0)
          const last = batch.at(-1)
          await stream.writeSSE(last ? { data: JSON.stringify({ rev: last.rev, actor: last.actor }) } : { event: 'ping', data: '' })
        }
      } finally {
        docs.off('commit', listener)
      }
    })
  })

  // —— 评论 ——

  app.post('/api/docs/:id/comments', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ node_id?: string; snippet?: string; text?: string }>()
    if (!body.node_id || !body.text?.trim()) return c.json({ error: 'node_id 与 text 必填' }, 400)
    const comment = store.addComment({ doc_id: row.id, node_id: body.node_id, snippet: body.snippet ?? '' })
    try {
      const anchored = attachComment(docs.get(row.id), body.node_id, body.snippet ?? '', comment.id)
      docs.commit(row.id, anchored.doc, { actor: 'user', turnId: null, ops: [{ op: 'comment', thread: comment.id }] })
    } catch (err) {
      store.db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
      if (err instanceof AnchorError) return c.json({ error: err.message }, 400)
      throw err
    }
    store.addReply(comment.id, 'user', body.text.trim())
    return c.json(store.getComment(row.id, comment.id), 201)
  })

  app.post('/api/docs/:id/comments/:cid/replies', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: 'text 必填' }, 400)
    return c.json(store.addReply(c.req.param('cid'), 'user', text.trim()), 201)
  })

  app.post('/api/docs/:id/comments/:cid/:action{resolve|reopen}', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const resolve = c.req.param('action') === 'resolve'
    return c.json({ ok: store.setCommentStatus(row.id, c.req.param('cid'), resolve ? 'resolved' : 'open', resolve ? 'user' : null) })
  })

  /** 让 AI 处理这条评论（可附追问）。 */
  app.post('/api/docs/:id/comments/:cid/ask', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }))
    if (body.text?.trim()) store.addReply(c.req.param('cid'), 'user', body.text.trim())
    return streamTurn(c, deps, row.id, commentPrompt(row.id, c.req.param('cid')))
  })

  // —— 对话 ——

  app.post('/api/docs/:id/chat', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { message } = await c.req.json<{ message?: string }>()
    if (!message?.trim()) return c.json({ error: 'message 必填' }, 400)
    return streamTurn(c, deps, row.id, message.trim())
  })

  app.post('/api/cancel', async c => {
    await turns.cancel(c.get('user'))
    return c.json({ ok: true })
  })

  // —— 资产 ——

  app.get('/api/assets/:id', c => {
    const asset = store.getAsset(c.req.param('id'))
    if (!asset || asset.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    return c.body(Buffer.from(store.getAssetBytes(asset.id)!), 200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=31536000, immutable' })
  })

  return app
}

/** 导出 docx：导入的文档以原始文件包为底座、未改动的块原样写回。 */
export function docxFor(docs: Documents, docId: string) {
  const store = docs.store
  const pkg = store.getPackage(docId)
  const first = store.listVersions(docId).at(-1)
  return exportDocx({
    doc: docs.get(docId),
    baseline: pkg && first?.source === 'import' ? docs.versionDoc(docId, first.seq) : null,
    pkg,
    src: id => store.getNodeSrc(docId, id),
    citations: store.listCitations(docId),
    comments: store.listComments(docId),
    asset: id => {
      const a = store.getAsset(id)
      return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null
    },
  })
}

function streamTurn(c: Context<{ Variables: { user: string } }>, deps: ApiDeps, docId: string, message: string) {
  const user = c.get('user')
  if (deps.turns.isBusy(user)) return c.json({ error: 'AI 正在处理上一条请求' }, 409)
  return streamSSE(c, async stream => {
    // 串行写出，结束前等全部写完
    let writes = Promise.resolve()
    const emit = (e: unknown) => { writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) })) }
    try {
      await deps.turns.run(user, docId, message, emit)
    } catch (err) {
      emit({ type: 'error', message: err instanceof BusyError ? err.message : String((err as Error).message ?? err) })
    }
    emit({ type: 'done' })
    await writes
  })
}
