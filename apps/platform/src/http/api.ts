import { Hono, type Context } from 'hono'
import { Transform } from 'prosemirror-transform'
import { streamSSE } from 'hono/streaming'
import { getConnInfo } from '@hono/node-server/conninfo'
import { AuthError, type Accounts } from '../auth/accounts.ts'
import { duplicateDoc } from '../model/duplicate.ts'
import type { SearchIndex } from '../model/search-index.ts'
import { ExtractError } from '../kb/extract.ts'
import type { KbService } from '../kb/service.ts'
import { MemoryError, type MemoryService } from '../memory/service.ts'
import type { Notice, PostCheck } from '../collab/postcheck.ts'
import { verifyPrompt } from '../claims/service.ts'
import { docxFor, pptxFor } from '../convert/exports.ts'
import { bindDeckAssets, importPptx, PptxImportError } from '../convert/pptx-import.ts'
import { readLayouts } from '../convert/pptx-layouts.ts'
import { pptxTemplate } from '../convert/pptx-template.ts'
import { DECK_THEMES } from '../model/deck-themes.ts'
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
  accounts: Accounts
  /** 开发模式：允许把开发用户的数据转给正式账户。 */
  devMode: boolean
  /** 全文索引（改名、复制后立即更新）。 */
  search?: SearchIndex
  /** 参考资料库。 */
  kb?: KbService
  memory?: MemoryService
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
  // 健康检查（部署脚本、容器 healthcheck、反向代理用）：数据库可读即健康；嵌入服务状态只报告不影响结果
  app.get('/healthz', async c => {
    store.db.prepare('SELECT 1').get()
    return c.json({ ok: true, vector: deps.kb ? (await deps.kb.status()).vector : false })
  })

  const { accounts } = deps
  const requestToken = (c: Context) => {
    const header = c.req.header('authorization')
    return header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
  }
  const clientIp = (c: Context) => {
    try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' }
  }
  const authFailure = (c: Context, err: unknown) => {
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }

  // —— 账户（不需要登录） ——
  app.get('/api/auth/config', c => c.json({ has_users: store.countUsers() > 0, dev_mode: deps.devMode }))
  // 防机器人：注册 / 登录前领一道工作量证明题（见 auth/bot-guard.ts）
  app.get('/api/auth/challenge', c => {
    c.header('Cache-Control', 'no-store')
    return c.json(accounts.bots.issue(clientIp(c)))
  })
  app.post('/api/auth/register', async c => {
    try {
      return c.json(accounts.register(await c.req.json(), clientIp(c)), 201)
    } catch (err) { return authFailure(c, err) }
  })
  // 找回密码：发验证码（不暴露邮箱是否注册）→ 验证码 + 新密码
  app.post('/api/auth/password-code', async c => {
    try {
      return c.json(await accounts.sendResetCode(await c.req.json(), clientIp(c)))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/auth/reset-password', async c => {
    try {
      return c.json(accounts.resetPassword(await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/auth/login', async c => {
    try {
      return c.json(accounts.login(await c.req.json(), clientIp(c)))
    } catch (err) { return authFailure(c, err) }
  })

  // 鉴权：账户令牌（开发模式下也接受开发令牌，见 auth/accounts.ts）。EventSource / <img> 用 ?token=。
  app.use('/api/*', async (c, next) => {
    const user = accounts.userFor(requestToken(c))
    if (!user) return c.json({ error: '请先登录', code: 'unauthorized' }, 401)
    c.set('user', user)
    await next()
  })

  app.get('/api/me', c => c.json({ ...accounts.me(c.get('user')), dev_mode: deps.devMode }))
  app.patch('/api/me', async c => {
    try {
      return c.json(accounts.updateProfile(c.get('user'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  // 绑定邮箱（找回密码用）：发码 → 核对
  app.post('/api/me/email-code', async c => {
    try {
      return c.json(await accounts.sendBindCode(c.get('user'), (await c.req.json<{ email?: string }>()).email, clientIp(c)))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/me/email', async c => {
    try {
      return c.json(accounts.bindEmail(c.get('user'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/auth/logout-everywhere', c => {
    accounts.logoutEverywhere(c.get('user'))
    return c.json({ ok: true })
  })
  // 开发模式：管理员把开发期（开发令牌）的文档与资产转到自己的账户
  app.post('/api/me/claim-dev-data', c => {
    if (!deps.devMode || !accounts.isAdmin(c.get('user'))) return c.json({ error: '只有开发模式下的管理员可以认领' }, 403)
    return c.json(store.transferOwnership(deps.devUser, c.get('user')))
  })

  // —— 管理员 ——
  app.use('/api/admin/*', async (c, next) => {
    if (!accounts.isAdmin(c.get('user'))) return c.json({ error: '需要管理员权限' }, 403)
    await next()
  })
  app.get('/api/admin/users', c => c.json(accounts.listUsers()))
  app.patch('/api/admin/users/:uid', async c => {
    try {
      return c.json(accounts.adminUpdate(c.get('user'), c.req.param('uid'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/admin/users/:uid/reset-password', async c => {
    try {
      accounts.adminResetPassword(c.req.param('uid'), (await c.req.json<{ password?: string }>()).password ?? '')
      return c.json({ ok: true })
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/admin/users/:uid/logout', c => {
    try {
      accounts.adminLogout(c.req.param('uid'))
      return c.json({ ok: true })
    } catch (err) { return authFailure(c, err) }
  })

  // 管理员：本实例停用记忆（同时删除所有用户的记忆）
  app.get('/api/admin/settings', c => c.json({ memory_enabled: deps.memory?.instanceEnabled() ?? false }))
  app.put('/api/admin/settings', async c => {
    const body = await c.req.json<{ memory_enabled?: boolean }>()
    let deleted = 0
    if (deps.memory && typeof body.memory_enabled === 'boolean') deleted = deps.memory.setInstanceEnabled(body.memory_enabled)
    return c.json({ memory_enabled: deps.memory?.instanceEnabled() ?? false, deleted })
  })

  // —— 记忆（R3） ——
  const memoryFailure = (c: Context, err: unknown) => {
    if (err instanceof MemoryError) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : 400)
    throw err
  }
  app.get('/api/memory', c => {
    const m = deps.memory
    if (!m) return c.json({ enabled: false, instance: false, paused: false, items: [] })
    const user = c.get('user')
    const items = store.listMemories(user, ['proposed', 'active']).map(x => ({ ...x, source_doc_title: x.source_doc_id ? store.getDoc(x.source_doc_id)?.title ?? null : null }))
    return c.json({ enabled: m.active(user), instance: m.instanceEnabled(), paused: m.paused(user), items })
  })
  app.put('/api/memory/settings', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const { paused } = await c.req.json<{ paused?: boolean }>()
    if (typeof paused === 'boolean') deps.memory.setPaused(c.get('user'), paused)
    return c.json({ paused: deps.memory.paused(c.get('user')) })
  })
  app.post('/api/memory', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const body = await c.req.json<{ content?: string; kind?: string; scope?: 'global' | 'project'; project_id?: string | null }>()
    try {
      const r = await deps.memory.propose(c.get('user'), { content: body.content ?? '', kind: (body.kind ?? 'preference') as never, scope: 'global' }, { source: 'manual', actor: 'user' })
      // 手动添加的项目记忆：直接指定项目
      if (body.scope === 'project' && body.project_id) await deps.memory.edit(c.get('user'), r.memory.id, { scope: 'project', project_id: projectOf(c, body.project_id) || null })
      return c.json({ ...r, memory: store.getMemory(r.memory.id) }, 201)
    } catch (err) { return memoryFailure(c, err) }
  })
  app.patch('/api/memory/:mid', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    try {
      const body = await c.req.json<Parameters<MemoryService['edit']>[2]>()
      if (body.project_id && projectOf(c, body.project_id) === false) return c.json({ error: '项目不存在' }, 404)
      return c.json(await deps.memory.edit(c.get('user'), c.req.param('mid'), body))
    } catch (err) { return memoryFailure(c, err) }
  })
  app.delete('/api/memory/:mid', c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    return deps.memory.remove(c.get('user'), c.req.param('mid')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })
  app.get('/api/memory/:mid/events', c => {
    const m = store.getMemory(c.req.param('mid'))
    if (!m || m.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    return c.json(store.memoryEvents(m.id))
  })
  /** 清空自己的全部记忆（不可恢复）。 */
  app.delete('/api/memory', c => c.json({ deleted: store.clearMemories(c.get('user')) }))
  app.get('/api/memory-export', c => {
    if (!deps.memory) return c.json([])
    return new Response(JSON.stringify({ format: 'heurion-memory', version: 1, exported_at: new Date().toISOString(), items: deps.memory.exportAll(c.get('user')) }, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="heurion-memory.json"' },
    })
  })
  app.post('/api/memory-import', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const body = await c.req.json<{ items?: unknown[] } | unknown[]>()
    const items = (Array.isArray(body) ? body : body.items ?? []) as Array<{ content?: unknown; kind?: unknown }>
    try {
      return c.json(await deps.memory.importItems(c.get('user'), items))
    } catch (err) { return memoryFailure(c, err) }
  })

  /** 自己的、不在回收站里的文档（回收站里的只能恢复或彻底删除）。 */
  const owned = (c: Context<{ Variables: { user: string } }>) => {
    const row = store.getDoc(c.req.param('id')!)
    return row && row.owner === c.get('user') && !row.deleted_at ? row : null
  }
  const ownedInTrash = (c: Context<{ Variables: { user: string } }>) => {
    const row = store.getDoc(c.req.param('id')!)
    return row && row.owner === c.get('user') && row.deleted_at ? row : null
  }
  /** 请求里的项目 id 必须是自己的项目（null / 空为未分组）。 */
  const projectOf = (c: Context<{ Variables: { user: string } }>, id: unknown): string | null | false => {
    if (id === null || id === undefined || id === '') return null
    const p = store.getProject(String(id))
    return p && p.owner === c.get('user') ? p.id : false
  }
  const assetUrl = (token: string) => (id: string) => `/api/assets/${id}?token=${encodeURIComponent(token)}`

  app.get('/api/docs', c => c.json(store.listDocs(c.get('user'))))

  app.post('/api/docs', async c => {
    const user = c.get('user')
    if (c.req.header('content-type')?.includes('application/json')) {
      const body = await c.req.json<{ title?: string; markdown?: string; kind?: string; project_id?: string | null }>()
      const title = body.title?.trim() || '未命名'
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      const place = (row: { id: string }) => { if (project) store.setDocProject(row.id, project); return store.getDoc(row.id)! }
      if (body.kind === 'deck') {
        const pkg = pptxTemplate()
        const row = docs.create({ owner: user, title, kind: 'deck', content: newDeckContent(readLayouts(pkg).layouts, title) })
        store.putPackage(row.id, 'pptx', pkg)
        return c.json(place(row), 201)
      }
      const content = body.markdown?.trim() ? schema.node('doc', null, parseBlocks(body.markdown)) : undefined
      return c.json(place(docs.create({ owner: user, title, content })), 201)
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
    const body = await c.req.json<{ title?: string; project_id?: string | null }>()
    if (body.title?.trim()) { store.renameDoc(row.id, body.title.trim()); deps.search?.reindex(row.id) }
    if ('project_id' in body) {
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      store.setDocProject(row.id, project)
    }
    return c.json(store.getDoc(row.id))
  })

  // —— 文档仓库（R2）：项目、搜索、回收站、复制 ——
  app.get('/api/projects', c => c.json(store.listProjects(c.get('user'))))
  app.post('/api/projects', async c => {
    const name = (await c.req.json<{ name?: string }>()).name?.trim().slice(0, 60)
    if (!name) return c.json({ error: '项目名不能为空' }, 400)
    return c.json(store.createProject(c.get('user'), name), 201)
  })
  app.patch('/api/projects/:pid', async c => {
    const p = store.getProject(c.req.param('pid'))
    if (!p || p.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    const name = (await c.req.json<{ name?: string }>()).name?.trim().slice(0, 60)
    if (!name) return c.json({ error: '项目名不能为空' }, 400)
    store.renameProject(p.id, name)
    return c.json(store.getProject(p.id))
  })
  app.delete('/api/projects/:pid', c => {
    const p = store.getProject(c.req.param('pid'))
    if (!p || p.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    store.deleteProject(p.id) // 文档回到未分组，不删除
    return c.json({ ok: true })
  })
  // —— 参考资料库（R2b） ——
  const ownedFile = (c: Context<{ Variables: { user: string } }>) => {
    const f = store.getKbFile(c.req.param('fid')!)
    return f && f.owner === c.get('user') ? f : null
  }
  app.get('/api/kb', c => {
    const project = c.req.query('project')
    return c.json(store.listKbFiles(c.get('user'), project === undefined ? undefined : project || null))
  })
  app.post('/api/kb', async c => {
    if (!deps.kb) return c.json({ error: '资料库未启用' }, 503)
    const form = await c.req.parseBody({ all: true })
    const files = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: '请选择文件' }, 400)
    const project = projectOf(c, form.project_id)
    if (project === false) return c.json({ error: '项目不存在' }, 404)
    const out: unknown[] = []
    for (const f of files) {
      try {
        const r = await deps.kb.upload(c.get('user'), { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), project_id: project })
        out.push({ ...r.file, duplicate: r.duplicate })
      } catch (err) {
        if (err instanceof ExtractError) out.push({ name: f.name, error: err.message })
        else throw err
      }
    }
    return c.json(out, 201)
  })
  app.patch('/api/kb/:fid', async c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ project_id?: string | null; name?: string }>()
    if ('project_id' in body) {
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      store.updateKbFile(f.id, { project_id: project })
    }
    if (body.name?.trim()) store.updateKbFile(f.id, { name: body.name.trim().slice(0, 200) })
    return c.json(store.getKbFile(f.id))
  })
  app.delete('/api/kb/:fid', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    store.deleteKbFile(f.id)
    return c.json({ ok: true })
  })
  app.get('/api/kb/:fid/text', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    return c.json({ file: f, pages: store.kbText(f.id, Number(c.req.query('from') ?? 1), Number(c.req.query('to') ?? Number.MAX_SAFE_INTEGER)) })
  })
  app.get('/api/kb/:fid/file', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    return new Response(Buffer.from(store.getKbBytes(f.id) ?? new Uint8Array()), { headers: { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` } })
  })
  app.get('/api/kb-status', async c => c.json(deps.kb ? await deps.kb.status() : { enabled: false, vector: false }))
  app.get('/api/kb-search', async c => {
    if (!deps.kb) return c.json([])
    const files = c.req.query('files')?.split(',').filter(Boolean)
    return c.json(await deps.kb.search(c.get('user'), c.req.query('q') ?? '', { limit: 10, fileIds: files }))
  })

  app.get('/api/search', c => c.json(store.searchDocs(c.get('user'), c.req.query('q') ?? '', 30)))
  app.get('/api/trash', c => c.json(store.listTrash(c.get('user'))))
  app.post('/api/docs/:id/restore', c => {
    const row = ownedInTrash(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    store.trashDoc(row.id, false)
    return c.json(store.getDoc(row.id))
  })
  app.delete('/api/docs/:id/purge', c => {
    const row = ownedInTrash(c)
    if (!row) return c.json({ error: '只能彻底删除回收站里的文档' }, 404)
    docs.unload(row.id)
    store.deleteDoc(row.id)
    store.unindexDoc(row.id)
    return c.json({ ok: true })
  })
  app.post('/api/docs/:id/duplicate', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const copy = duplicateDoc(docs, row, c.get('user'))
    deps.search?.reindex(copy.id)
    return c.json(copy, 201)
  })

  // 删除 = 移进回收站（30 天后自动彻底删除；可恢复）
  app.delete('/api/docs/:id', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    store.trashDoc(row.id, true)
    return c.json({ ok: true, trashed: true })
  })

  app.get('/api/docs/:id/html', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const seq = c.req.query('version')
    const doc = seq ? docs.versionDoc(row.id, Number(seq)) : docs.get(row.id)
    if (!doc) return c.json({ error: 'version not found' }, 404)
    return c.json({ rev: docs.rev(row.id), html: renderHtml(doc, store.listCitations(row.id), assetUrl(requestToken(c) ?? '')) })
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
    // ph_styles：各版式占位符继承的文字样式（画布显示导入的占位符用）
    const ph_styles = Object.fromEntries(info.layouts.map(l => [l.part, l.placeholders.map(p => ({ type: p.type, idx: p.idx, style: p.style ?? {} }))]))
    return c.json({ rev: docs.rev(row.id), size: info.size, layouts: info.layouts.map(l => l.name), ph_styles, doc: docs.get(row.id).toJSON() })
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
  // 幻灯片主题（画布的主题选择与颜色板用；与 MCP apply_theme 同一份定义）
  app.get('/api/deck-themes', c => c.json(DECK_THEMES))

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
  // 重试一轮（失败 / 超时 / 被停止的回合）：同样的要求、同样的选项重新排队
  app.post('/api/docs/:id/turns/:turnId/retry', c => {
    const row = owned(c)
    const turn = row ? store.getTurn(c.req.param('turnId')) : undefined
    if (!row || !turn || turn.doc_id !== row.id || turn.user_id !== c.get('user')) return c.json({ error: 'not found' }, 404)
    if (turn.status === 'running') return c.json({ error: '这一轮还在执行' }, 409)
    let opts: TurnOptions = {}
    try { opts = JSON.parse(turn.opts || '{}') as TurnOptions } catch { /* 默认选项 */ }
    void turns.submit(c.get('user'), row.id, turn.message, undefined, opts)
    return c.json({ queued: true }, 202)
  })

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
    const { message, suggest, kb_files, memory } = await c.req.json<{ message?: string; suggest?: boolean; kb_files?: string[]; memory?: boolean }>()
    if (!message?.trim()) return c.json({ error: 'message 必填' }, 400)
    // 对话里选中的参考资料：告诉 AI 用哪几份（只认自己的资料）
    const picked = (kb_files ?? []).slice(0, 20).map(id => store.getKbFile(id)).filter(f => f && f.owner === c.get('user'))
    const note = picked.length === 0 ? '' : `\n\n［参考资料］请依据这些资料（kb_search 用 file_ids 限定检索，kb_read 读原文）：${picked.map(f => `《${f!.name}》(file_id=${f!.id})`).join('、')}`
    return streamTurn(c, deps, row.id, message.trim() + note, { suggest, ...(memory === false ? { memory: false } : {}) })
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
