import { Hono, type Context } from 'hono'
import { Transform } from 'prosemirror-transform'
import { streamSSE } from 'hono/streaming'
import { devUserFor } from '../auth/dev.ts'
import type { Notice, PostCheck } from '../collab/postcheck.ts'
import { verifyPrompt } from '../claims/service.ts'
import { docxFor, pptxFor } from '../convert/exports.ts'
import { bindDeckAssets, importPptx, PptxImportError } from '../convert/pptx-import.ts'
import { readLayouts } from '../convert/pptx-layouts.ts'
import { pptxTemplate } from '../convert/pptx-template.ts'
import { newDeckContent } from '../ops/deck.ts'
import { readFileSync } from 'node:fs'
import type { SlideRenderer } from '../render/slides.ts'
import type { CrossrefClient } from '../literature/crossref.ts'
import { formatAma, normalizeDoi } from '../literature/format.ts'
import { bindAssets, DocxImportError, importDocx } from '../convert/docx-import.ts'
import { AnchorError, attachComment, locate, threadMarks } from '../model/anchors.ts'
import { parseBlocks } from '../model/markdown.ts'
import type { CommitEvent, Documents } from '../model/runtime.ts'
import { schema } from '../model/schema.ts'
import type { OpService } from '../ops/service.ts'
import { pendingGroups, resolveSuggestions, withoutPending } from '../ops/suggest.ts'
import { EditBatch, OpError } from '../ops/types.ts'
import { DeckEditBatch } from '../ops/deck.ts'
import { commentPrompt, wantsAi, type TurnBusEvent, type TurnOptions, type TurnService } from '../turns/service.ts'
import { citationOrder, diff, read } from '../views/read.ts'
import { deckRead } from '../views/deck.ts'
import { exportMarkdown, renderHtml } from '../views/render.ts'

export interface ApiDeps {
  docs: Documents
  ops: OpService
  turns: TurnService
  postcheck: PostCheck
  crossref: CrossrefClient
  renderer: SlideRenderer
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

  // 开发期鉴权（见 auth.ts）。EventSource / <img> 用 ?token=。
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    const user = devUserFor(token, deps.devToken, deps.devUser)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    c.set('user', user)
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
      const body = await c.req.json<{ title?: string; markdown?: string; kind?: string }>()
      const title = body.title?.trim() || '未命名'
      if (body.kind === 'deck') {
        const pkg = pptxTemplate()
        const row = docs.create({ owner: user, title, kind: 'deck', content: newDeckContent(readLayouts(pkg).layouts, title) })
        store.putPackage(row.id, 'pptx', pkg)
        return c.json(row, 201)
      }
      const content = body.markdown?.trim() ? schema.node('doc', null, parseBlocks(body.markdown)) : undefined
      return c.json(docs.create({ owner: user, title, content }), 201)
    }
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    if (file && /\.pptx$/i.test(file.name)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const imported = importPptx(bytes)
        const ids = new Map(imported.assets.map(a => [a.key, store.putAsset({ owner: user, mime: a.mime, name: a.name, bytes: a.bytes }).id]))
        const row = docs.create({ owner: user, title: file.name.replace(/\.pptx$/i, ''), kind: 'deck', content: bindDeckAssets(imported.doc, ids), source: 'import' })
        store.putNodeSrc(row.id, imported.src)
        store.putPackage(row.id, 'pptx', bytes)
        return c.json({ ...row, warnings: imported.warnings }, 201)
      } catch (err) {
        if (err instanceof PptxImportError) return c.json({ error: err.message }, 400)
        throw err
      }
    }
    if (!file || !/\.docx$/i.test(file.name)) return c.json({ error: '只支持上传 .docx / .pptx' }, 400)
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
      failed_turns: store.failedTurns(row.id),
      suggestions: pendingGroups(doc),
      claim_checks: store.listClaimChecks(row.id),
      revertable: [...new Set(store.listMessages(row.id).map(m => m.turn_id).filter((t): t is string => !!t))].filter(t => docs.canRevertTurn(row.id, t)),
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
    if (row.kind === 'deck') return c.text(deckRead(docs.get(row.id), docs.rev(row.id)))
    return c.text(read({ doc: docs.get(row.id), docId: row.id, rev: docs.rev(row.id), comments: store.listComments(row.id, 'open') }))
  })

  app.get('/api/docs/:id/export.md', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.body(exportMarkdown(withoutPending(docs.get(row.id)), store.listCitations(row.id)), 200, {
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

  app.get('/api/docs/:id/export.pptx', c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    const result = pptxFor(docs, row.id)
    return c.body(Buffer.from(result.bytes), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.pptx`,
    })
  })

  /** deck 模型（页面渲染用）：幻灯片、形状、页面尺寸。 */
  app.get('/api/docs/:id/deck', c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    const info = ops.deckContextInfo(row.id)
    return c.json({ rev: docs.rev(row.id), size: info.size, layouts: info.layouts.map(l => l.name), doc: docs.get(row.id).toJSON() })
  })

  /** 幻灯片的精确预览（LibreOffice 渲染，按 rev 缓存）。 */
  app.get('/api/docs/:id/slides/:index/render.png', async c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    try {
      const pngs = await deps.renderer.render(`${row.id}/${docs.rev(row.id)}`, () => pptxFor(docs, row.id).bytes)
      const png = pngs[Number(c.req.param('index'))]
      if (!png) return c.json({ error: 'slide not found' }, 404)
      return c.body(readFileSync(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503)
    }
  })

  /** 用户编辑（P1 编辑器上线前的入口）：同一操作层，actor=user。 */
  app.post('/api/docs/:id/edit', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const parsed = (row.kind === 'deck' ? DeckEditBatch : EditBatch).safeParse({ ...(await c.req.json<object>()), doc_id: row.id })
    if (!parsed.success) return c.json({ code: 'validation_error', message: parsed.error.message }, 400)
    try {
      return c.json(ops.edit(parsed.data, { actor: 'user', turnId: null }))
    } catch (err) {
      if (err instanceof OpError) return c.json(err.toJSON(), 409)
      throw err
    }
  })

  /** 用户按 DOI 登记引用（Crossref 核实），返回 cite_id，编辑器在光标处插入引用。 */
  app.post('/api/docs/:id/citations', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { doi } = await c.req.json<{ doi?: string }>()
    if (!doi?.trim()) return c.json({ error: 'doi 必填' }, 400)
    const article = await deps.crossref.lookup(doi.trim())
    if (!article) return c.json({ error: `DOI ${normalizeDoi(doi)} 在 Crossref 查不到` }, 404)
    const cite = store.upsertCitation({ doc_id: row.id, doi: article.doi!, pmid: null, formatted: formatAma(article), url: `https://doi.org/${article.doi}` })
    return c.json({ cite_id: cite.id, formatted: cite.formatted }, 201)
  })

  /** 核对全部论断：排一个只核对、不改正文的回合。 */
  app.post('/api/docs/:id/verify', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return streamTurn(c, deps, row.id, verifyPrompt(row.id))
  })

  /** 采纳 / 拒绝待采纳修订（group = all 表示全部）。 */
  app.post('/api/docs/:id/suggestions/:group/:action{accept|reject}', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    docs.flush(row.id)
    const group = c.req.param('group') === 'all' ? null : c.req.param('group')
    const accept = c.req.param('action') === 'accept'
    const next = resolveSuggestions(docs.get(row.id), group, accept)
    const event = docs.commit(row.id, next, { actor: 'user', turnId: null, ops: [{ op: accept ? 'accept_suggestion' : 'reject_suggestion', group }] })
    return c.json({ rev: docs.rev(row.id), changes: event?.changes.length ?? 0 })
  })

  /** 撤销某个 AI 回合对本文档的改动（用户在此期间的编辑保留）。 */
  app.post('/api/docs/:id/turns/:turnId/revert', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const turnId = c.req.param('turnId')
    if (!docs.canRevertTurn(row.id, turnId)) return c.json({ error: '这一轮已经撤销过，或没有改动可撤销' }, 409)
    const result = docs.revertTurn(row.id, turnId)
    const version = docs.snapshot(row.id, 'user', '撤销一轮 AI 修改')
    return c.json({ rev: docs.rev(row.id), changes: result?.event?.changes.length ?? 0, skipped: result?.skipped ?? [], version })
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
      const queue: unknown[] = []
      let wake: (() => void) | null = null
      const push = (e: unknown) => { queue.push(e); wake?.() }
      const onCommit = (e: CommitEvent) => {
        if (e.docId === row.id) push({ type: 'commit', rev: e.rev, actor: e.actor, turn_id: e.turnId, changes: e.changes })
      }
      // 该用户的回合事件（含 @heurion 自动触发的回合）：只转发与本文档相关的
      const onTurn = (e: TurnBusEvent) => {
        if (e.userId === c.get('user') && e.docId === row.id && e.event.type !== 'reasoning') push({ type: 'turn_event', event: e.event })
      }
      const onNotice = (n: Notice) => { if (n.doc_id === row.id) push({ type: 'notice', ...n }) }
      docs.on('commit', onCommit)
      turns.events.on('event', onTurn)
      deps.postcheck.on('notice', onNotice)
      stream.onAbort(() => { closed = true; wake?.() })
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello', rev: docs.rev(row.id), busy: turns.isBusy(c.get('user')) }) })
      try {
        while (!closed) {
          if (queue.length === 0) await new Promise<void>(r => { wake = r; setTimeout(r, 25_000) })
          wake = null
          const batch = queue.splice(0)
          if (batch.length === 0) await stream.writeSSE({ event: 'ping', data: '' })
          for (const e of batch) await stream.writeSSE({ data: JSON.stringify(e) })
        }
      } finally {
        docs.off('commit', onCommit)
        turns.events.off('event', onTurn)
        deps.postcheck.off('notice', onNotice)
      }
    })
  })

  // —— 评论 ——

  app.post('/api/docs/:id/comments', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ node_id?: string; snippet?: string; paragraph?: number; range?: { from: number; to: number }; text?: string }>()
    if (!body.node_id || !body.text?.trim()) return c.json({ error: 'node_id 与 text 必填' }, 400)
    const comment = store.addComment({ doc_id: row.id, node_id: body.node_id, snippet: body.snippet ?? '' })
    try {
      const anchored = attachComment(docs.get(row.id), body.node_id, body.snippet ?? '', comment.id, body.paragraph, body.range)
      docs.commit(row.id, anchored.doc, { actor: 'user', turnId: null, ops: [{ op: 'comment', thread: comment.id }] })
      store.setCommentAnchor(comment.id, body.node_id, anchored.snippet)
    } catch (err) {
      store.db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
      if (err instanceof AnchorError) return c.json({ error: err.message }, 400)
      throw err
    }
    store.addReply(comment.id, 'user', body.text.trim())
    // @heurion：评论即指令，自动排队处理
    if (wantsAi(body.text)) void turns.submit(c.get('user'), row.id, commentPrompt(row.id, comment.id, row.kind), undefined, { commentId: comment.id })
    return c.json({ ...store.getComment(row.id, comment.id), queued: wantsAi(body.text) }, 201)
  })

  app.post('/api/docs/:id/comments/:cid/replies', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: 'text 必填' }, 400)
    const reply = store.addReply(c.req.param('cid'), 'user', text.trim())
    if (wantsAi(text)) void turns.submit(c.get('user'), row.id, commentPrompt(row.id, c.req.param('cid'), row.kind), undefined, { commentId: c.req.param('cid') })
    return c.json({ ...reply, queued: wantsAi(text) }, 201)
  })

  app.post('/api/docs/:id/comments/:cid/:action{resolve|reopen}', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const resolve = c.req.param('action') === 'resolve'
    return c.json({ ok: store.setCommentStatus(row.id, c.req.param('cid'), resolve ? 'resolved' : 'open', resolve ? 'user' : null) })
  })

  /** 删除评论：去掉正文里的锚点标记与线程。 */
  app.delete('/api/docs/:id/comments/:cid', c => {
    const row = owned(c)
    const cid = c.req.param('cid')
    if (!row || !store.getComment(row.id, cid)) return c.json({ error: 'not found' }, 404)
    const doc = docs.get(row.id)
    const tr = new Transform(doc)
    tr.removeMark(0, doc.content.size, doc.type.schema.marks.comment!.create({ thread: cid }))
    docs.commit(row.id, tr.doc, { actor: 'user', turnId: null, ops: [{ op: 'delete_comment', thread: cid }] })
    store.db.prepare('DELETE FROM comments WHERE doc_id = ? AND id = ?').run(row.id, cid)
    return c.json({ ok: true })
  })

  /** 让 AI 处理这条评论（可附追问）。 */
  app.post('/api/docs/:id/comments/:cid/ask', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text?: string; suggest?: boolean }>().catch(() => ({} as { text?: string; suggest?: boolean }))
    if (body.text?.trim()) store.addReply(c.req.param('cid'), 'user', body.text.trim())
    return streamTurn(c, deps, row.id, commentPrompt(row.id, c.req.param('cid'), row.kind), { suggest: body.suggest, commentId: c.req.param('cid') })
  })

  // —— 对话 ——

  app.post('/api/docs/:id/chat', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { message, suggest } = await c.req.json<{ message?: string; suggest?: boolean }>()
    if (!message?.trim()) return c.json({ error: 'message 必填' }, 400)
    return streamTurn(c, deps, row.id, message.trim(), { suggest })
  })

  // 任务队列：正在执行的一个 + 排队中的；可逐个取消
  app.get('/api/queue', c => c.json(turns.view(c.get('user'))))
  app.post('/api/queue/:jid/cancel', async c => {
    const ok = await turns.cancelJob(c.get('user'), c.req.param('jid'))
    return ok ? c.json({ ok: true }) : c.json({ error: '任务已结束或不存在' }, 404)
  })

  app.post('/api/cancel', async c => {
    await turns.cancel(c.get('user'))
    return c.json({ ok: true })
  })

  // —— 资产 ——

  /** 用户在编辑器里插图：上传图片为资产（导出 docx 支持 png / jpeg / gif）。 */
  app.post('/api/docs/:id/assets', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    if (!file) return c.json({ error: '缺少图片文件' }, 400)
    if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) return c.json({ error: '只支持 png / jpg / gif 图片' }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ error: '图片超过 10MB' }, 400)
    const asset = store.putAsset({ owner: c.get('user'), mime: file.type, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    return c.json({ asset_id: asset.id, name: asset.name }, 201)
  })

  app.get('/api/assets/:id', c => {
    const asset = store.getAsset(c.req.param('id'))
    if (!asset || asset.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    return c.body(Buffer.from(store.getAssetBytes(asset.id)!), 200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=31536000, immutable' })
  })

  return app
}

/**
 * 对话 / 评论触发的回合。默认以 SSE 返回本回合事件（API 调用方）；`?async=1` 立即返回 202，
 * 事件经文档流（/stream）推送（页面用这种方式，自动触发的回合也走同一条路）。
 */
function streamTurn(c: Context<{ Variables: { user: string } }>, deps: ApiDeps, docId: string, message: string, opts: TurnOptions = {}) {
  const user = c.get('user')
  if (c.req.query('async')) {
    void deps.turns.submit(user, docId, message, undefined, opts)
    return c.json({ queued: deps.turns.isBusy(user) }, 202)
  }
  return streamSSE(c, async stream => {
    // 串行写出，结束前等全部写完
    let writes = Promise.resolve()
    const emit = (e: unknown) => { writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {}) }
    await deps.turns.submit(user, docId, message, emit, opts)
    await writes
  })
}
