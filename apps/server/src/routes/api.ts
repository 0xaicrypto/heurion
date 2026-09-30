import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { DocKind, Store } from '../db.ts'
import type { HarnessPool } from '../harness/pool.ts'
import { BusyError, type TurnService } from '../docs/turn.ts'
import type { DocFiles } from '../docs/workspace.ts'

export interface ApiDeps {
  store: Store
  files: DocFiles
  pool: HarnessPool
  turns: TurnService
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
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    const kind = file ? kindFromName(file.name) : (form.kind === 'pptx' ? 'pptx' : form.kind === 'docx' ? 'docx' : null)
    if (!kind) return c.json({ error: '只支持 .docx / .pptx' }, 400)
    const title = typeof form.title === 'string' && form.title.trim() ? form.title.trim() : (file?.name ?? '未命名')
    const doc = store.createDoc(randomUUID(), title, kind)
    if (file) files.importUpload(doc.id, kind, new Uint8Array(await file.arrayBuffer()))
    return c.json(store.getDoc(doc.id), 201)
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
    return streamSSE(c, async stream => {
      // 串行写入并在结束前等待全部写完：否则回调返回、流关闭时未写出的事件会丢失
      let writes = Promise.resolve()
      const emit = (e: unknown) => { writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) })) }
      try {
        await turns.run(docId, message.trim(), emit)
      } catch (err) {
        console.error('[chat] turn failed', err)
        emit({ type: 'error', message: err instanceof BusyError ? err.message : String((err as Error).message ?? err) })
      }
      emit({ type: 'done' })
      await writes
    })
  })

  app.post('/api/docs/:id/cancel', async c => {
    await pool.cancel(c.req.param('id'))
    return c.json({ ok: true })
  })

  return app
}
