import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import crypto from 'crypto'
import type { DocSnapshot, ResearchStudy } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { SCHEMA_VERSION } from '@heurion/contracts'
import type { PolishStreamChunk } from '@heurion/contracts'
import { renderDocxBuffer, renderPdfBuffer, isExportFormat } from './markdown-export.js'
import { polishSelection, polishSelectionFallback, writeMethodsSection, writePaperBackground, MAX_POLISH_CHARS, resolvePolishModel, resolvePolishDeadlineMs } from './document-writing.service.js'
// #777: pptx 解析导入 — deck/文章双落点（后台执行）。
import { extractPptxContentFromUpload, pptxSlidesToDeck } from '../../lib/pptx-extractor.js'
// #787: 上传即草稿的导入编排收敛到 doc-import 单点。
import { ensureDraftBody } from '../../tools/doc-import.js'
// #789: doc 写回单点 owner。
import { writeDocVersion } from '../../tools/doc-version-writer.js'
import { makeLogger } from '../../common/logger.js'
import { refreshFileUrls } from '../../common/chart-token.js'
import { lintDocument } from '../../common/doc-lint.js'
// #790: polish 流复用共享 SSE 传输。
import { createRawSseSender } from '../chat/chat-sse.js'

const slog = makeLogger('documents.polish')

const log = makeLogger('documents')

// #923 类型收口:路由参数/请求体显式类型(替代 request.params as any)。
interface DocParams { docId: string }
interface DocSnapParams extends DocParams { snapId: string }
interface DocRefParams extends DocParams { referenceId: string }
interface StudyParams { studyId: string }

function uid() { return crypto.randomBytes(8).toString('hex') }

/** #773: Doc.deck 存 JSON 字符串 — 线上返回解析后的对象（损坏容错为 null）。 */
function parseDeck(deck: unknown): unknown {
  if (typeof deck !== 'string' || !deck) return null
  try { return JSON.parse(deck) } catch { return null }
}

/** #fix: deck 内嵌图片 URL 自愈（refreshFileUrls 的 JSON 结构包装）。 */
function refreshDeckUrls(deck: unknown, userId: string): unknown {
  if (!deck) return deck
  try { return JSON.parse(refreshFileUrls(JSON.stringify(deck), userId)) } catch { return deck }
}

export async function documentsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Docs CRUD ──
  app.get('/api/v1/docs', async (request) => {
    const docs = await prisma.doc.findMany({
      where: { userId: request.user!.userId }, orderBy: { updatedAt: 'desc' },
    })
    return { docs: docs.map((d) => ({
      id: d.id, title: d.title,
      // #fix: 图片 URL 自愈 — 旧版坏链/过期 token 在读取时统一重签。
      body: refreshFileUrls(d.body, request.user!.userId),
      updated_at: d.updatedAt, created_at: d.createdAt, ref_count: 0,
    }))}
  })

  app.post<{ Body: { title?: string; study_id?: string } }>('/api/v1/docs', async (request) => {
    const { title, study_id } = request.body
    const id = `doc_${uid()}`
    const now = new Date().toISOString()
    const userId = request.user!.userId
    // #383: creating a paper linked to a study — optionally prefill title
    // and abstract from the study's name/purpose.
    let study: ResearchStudy | null = null
    if (study_id) {
      study = await prisma.researchStudy.findFirst({ where: { id: study_id, userId } })
      if (!study) return { error: 'Study not found' }
    }
    try {
      await prisma.doc.create({ data: { id, userId, title: title || 'Untitled', body: '', studyId: study_id || null, createdAt: now, updatedAt: now } })
    } catch (err: any) {
      // If FK constraint fails (user not in DB yet — staging/CI), retry without FK
      if (err?.message?.includes('foreign key')) {
        await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF")
        await prisma.$executeRawUnsafe("INSERT INTO docs (id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, userId, title || 'Untitled', '', now, now)
        await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON")
      } else {
        throw err
      }
    }
    return { id, title: title || 'Untitled', body: '', created_at: now, updated_at: now }
  })

  app.get<{ Params: DocParams }>('/api/v1/docs/:docId', async (request, reply) => {
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    // #383: expose the linked study so the editor can show context + methods.
    let study_name: string | null = null
    if (doc.studyId) {
      const st = await prisma.researchStudy.findFirst({ where: { id: doc.studyId } })
      study_name = st?.name || null
    }
    return { id: doc.id, title: doc.title, body: refreshFileUrls(doc.body, request.user!.userId), deck: refreshDeckUrls(parseDeck(doc.deck), request.user!.userId), created_at: doc.createdAt, updated_at: doc.updatedAt, study_id: doc.studyId || null, study_name }
  })

  app.put<{ Params: DocParams; Body: { title?: string; body?: string; deck?: unknown; base_sha?: string; force?: boolean } }>('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params
    const { title, body, deck, base_sha, force } = request.body
    const existing = await prisma.doc.findFirst({ where: { id: docId, userId: request.user!.userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })

    const now = new Date().toISOString()
    const data: Prisma.DocUpdateInput = { updatedAt: now }
    if (title !== undefined) data.title = title

    // #773: deck 视图手动编辑的保存路径 — deck 以对象传入，序列化落库；
    // undefined = 不触碰 deck。
    let deckChanged = false
    if (deck !== undefined) {
      const deckJson = deck === null ? null : JSON.stringify(deck)
      deckChanged = deckJson !== (existing.deck ?? null)
      if (deckChanged) data.deck = deckJson
    }

    // 查重 + 版本:body/deck 未变化时不创建快照、不刷新 updatedAt(避免
    // 重复保存产生空版本/列表跳动);变化时快照旧 body+deck 同帧作为版本
    // (#773 方案 A — 恢复时一致回滚)。
    const bodyChanged = body !== undefined && body !== existing.body
    if (bodyChanged) {
      // #882: 并发保护(僵尸 tab)— base_sha 是客户端最后同步的服务端正文
      // 指纹(sha1)。不匹配 = 客户端视图过期,整篇覆盖会静默丢失另一窗口的
      // 修改(AI 写回/新 tab 编辑)。显式 force: true 跳过(冲突横幅的
      // 「保留我的版本」)。不带 base_sha 的旧客户端不受影响(向后兼容)。
      if (!force && typeof base_sha === 'string' && base_sha.length > 0 &&
          crypto.createHash('sha1').update(String(existing.body)).digest('hex') !== base_sha) {
        return reply.status(409).send({
          error: '文档已在其他窗口被修改，为避免覆盖未做保存',
          code: 'stale_base',
          current_updated_at: existing.updatedAt,
        })
      }
      data.body = body
    }
    if (bodyChanged || deckChanged) {
      // #908: 快照+更新包同一事务 — 此前两段写，中断会留下「有快照无更新」
      // 错位（孤儿快照，History 面板出现幽灵版本）。与 doc-version-writer
      // #789/#904 同款强度。
      await prisma.$transaction([
        prisma.docSnapshot.create({
          data: {
            docId,
            userId: request.user!.userId,
            body: existing.body,
            deck: existing.deck ?? null,
            label: '保存版本',
            createdAt: now,
          },
        }),
        prisma.doc.update({ where: { id: docId }, data }),
      ])
    } else {
      // body/deck 未变化不刷新 updatedAt（保存按钮 unchanged 提示依赖），
      // 仅 title 等字段仍可单独更新。
      delete data.updatedAt
      await prisma.doc.update({ where: { id: docId }, data })
    }
    const doc = await prisma.doc.findFirst({ where: { id: docId } })

    // #821: 保存时预渲染预热 — 扫描学术图 fire-and-forget ensureFigures,
    // 导出时基本全命中 FigureRender 缓存(冷导出 15s/图预算只是兜底)。
    if (bodyChanged && body) {
      try {
        const ownerId = request.user!.userId
        const { scanFigures } = await import('../figures/figure-markdown.js')
        const { ensureFigures } = await import('../figures/figure.service.js')
        const { figures } = scanFigures(String(body))
        if (figures.length > 0) {
          void ensureFigures(ownerId, figures).catch(() => {})
        }
      } catch { /* 预热是纯优化 — 任何失败不影响保存 */ }
    }

    return {
      id: doc!.id, title: doc!.title, body: doc!.body, deck: parseDeck(doc!.deck),
      created_at: doc!.createdAt, updated_at: doc!.updatedAt,
      // #598: 前端保存按钮据此提示'内容未变化'.
      unchanged: !bodyChanged && !deckChanged,
    }
  })

  app.delete<{ Params: DocParams }>('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params
    const userId = request.user!.userId
    const existing = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })
    await prisma.doc.delete({ where: { id: docId } })
    return { deleted: true }
  })

  // ── Snapshots ──
  // #809: 一致性 lint（纯规则）— 缩写纪律/图表编号/heading 跳级。
  app.get<{ Params: DocParams }>('/api/v1/docs/:docId/lint', async (request) => {
    const docId = request.params.docId
    const doc = await prisma.doc.findFirst({
      where: { id: docId, userId: request.user!.userId },
      select: { body: true },
    })
    if (!doc) return { issues: [], error: 'not found' }
    return { issues: lintDocument(String(doc.body || '')) }
  })

  app.get<{ Params: DocParams }>('/api/v1/docs/:docId/snapshots', async (request, reply) => {
    const docId = request.params.docId
    // #898: 归属守卫 — 文档不属于调用者一律 404（此前任意用户可枚举他人快照）。
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    const snaps = await prisma.docSnapshot.findMany({
      where: { docId, userId: request.user!.userId }, orderBy: { id: 'desc' },
    })
    // #598: 返回字段与前端约定一致(snapshot_id / body_preview),此前
    // id/body 不匹配导致 History 面板渲染 undefined、点击无反应。
    return { snapshots: snaps.map((s: DocSnapshot) => ({
      snapshot_id: String(s.id),
      created_at: s.createdAt,
      body_preview: (s.body || '').slice(0, 80),
      label: s.label || '保存版本',
    })) }
  })

  // #870: 气泡 apply 补快照 — 客户端已就地替换选区,这里补一条版本快照,
  // 与聊天 edit_document 的 'AI edit' 快照对齐(撤销/审计能力一致)。
  // 写回走 DocVersionWriter 单点(同帧带旧 deck)。
  app.post<{ Params: DocParams; Body: { body?: string; label?: string; base_sha?: string } }>('/api/v1/docs/:docId/snapshots', async (request, reply) => {
    const { docId } = request.params
    const userId = request.user!.userId
    // #907(服务端): base_sha 可选 — 客户端最后一次读到的服务端正文指纹。
    const { body, label, base_sha } = request.body || {}
    if (typeof body !== 'string' || !body.trim()) {
      return reply.status(400).send({ error: 'body required' })
    }
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Doc not found' })
    // #907(服务端)/#870: 气泡 apply 的 base_sha 守卫 — 与 PUT /docs/:docId
    // #882 同语义同算法同字段名（sha1 指纹）：客户端就地替换选区后提交，
    // 若服务端正文已被并发修改（AI 写回/其他窗口），不匹配 → 409，避免
    // apply 静默覆盖丢改动。未提供 base_sha 的旧客户端不受影响（向后兼容，
    // 前端接入由并行任务完成）。
    if (typeof base_sha === 'string' && base_sha.length > 0 &&
        crypto.createHash('sha1').update(String(doc.body)).digest('hex') !== base_sha) {
      return reply.status(409).send({ error: 'stale_base' })
    }
    const written = await writeDocVersion({ userId, docId, body, snapshotLabel: String(label || 'AI polish').slice(0, 40) })
    // #904: writer 乐观锁冲突（服务端视角正文在读取后又变）→ 409 可重试。
    if (written.error) return reply.status(written.conflict ? 409 : 400).send({ error: written.error })
    return { ok: true }
  })

  // #764: 快照全文 — Restore 前先与当前版本做 diff 审阅,确认后才 apply。
  app.get<{ Params: DocSnapParams }>('/api/v1/docs/:docId/snapshots/:snapId', async (request, reply) => {
    const { docId, snapId } = request.params
    // #898: 归属守卫 — doc 归属 + 快照带 userId 双重过滤,防跨用户读快照全文。
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    const snap = await prisma.docSnapshot.findFirst({ where: { id: Number(snapId), docId, userId: request.user!.userId } })
    if (!snap) return reply.status(404).send({ error: 'Not found' })
    // #773: 同帧返回 deck — 恢复审阅可见,恢复时 body+deck 一致回滚。
    return { id: String(snap.id), created_at: snap.createdAt, label: snap.label || '保存版本', body: refreshFileUrls(snap.body || '', request.user!.userId), deck: refreshDeckUrls(parseDeck(snap.deck), request.user!.userId) }
  })

  app.post<{ Params: DocSnapParams }>('/api/v1/docs/:docId/snapshots/:snapId/restore', async (request, reply) => {
    const { docId, snapId } = request.params
    const userId = request.user!.userId
    // #898: 归属守卫 — doc 与快照都必须属于调用者,否则可篡改他人文档。
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    const snap = await prisma.docSnapshot.findFirst({ where: { id: Number(snapId), docId, userId } })
    if (!snap) return reply.status(404).send({ error: 'Not found' })
    // #898: 恢复前先把当前 body+deck 落一条快照 — 当前态可再撤销,不被永久覆盖。
    await prisma.docSnapshot.create({
      data: {
        docId,
        userId,
        body: doc.body,
        deck: doc.deck ?? null,
        label: '恢复前版本',
        createdAt: new Date().toISOString(),
      },
    })
    // #773: body+deck 一致回滚（deck 未快照的历史行恢复为 null = 无 deck）。
    await prisma.doc.update({ where: { id: docId }, data: { body: snap.body, deck: snap.deck ?? null, updatedAt: new Date().toISOString() } })
    return { restored: true }
  })

  // ── PHI Scan ──
  app.post<{ Params: DocParams }>('/api/v1/docs/:docId/phi-scan', async (request) => {
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId: request.user!.userId } })
    if (!doc) return { findings: [] }
    const suggestions: Record<string, string> = {
      SSN: 'Potential Social Security Number — consider removing or replacing with a surrogate ID.',
      Name: 'Potential patient name — consider using initials or a de-identified label.',
    }
    const findings: Array<{ kind: string; text: string; start: number; end: number; suggestion: string }> = []
    for (const { regex, kind } of [
      { regex: /\b\d{3}-\d{2}-\d{4}\b/g, kind: 'SSN' },
      { regex: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, kind: 'Name' },
    ]) {
      let match
      while ((match = regex.exec(doc.body)) !== null) {
        findings.push({ kind, text: match[0], start: match.index, end: match.index + match[0].length, suggestion: suggestions[kind] || 'Review for potential PHI.' })
      }
    }
    return { findings }
  })

  // #3: AI Polish SSE — uses DeepSeek/GLM
  // #752-qa 全面加固:归属校验(S1)/长度上限(S2)/客户端断开→abort 上游(S3)/
  // 15s 心跳(S4)/150s 总超时(S5)/fallback 全文净化(S7)。
  app.post<{ Params: DocParams; Body: { selection?: string; instruction?: string } }>('/api/v1/docs/:docId/polish', async (request, reply) => {
    const { docId } = request.params
    const { selection, instruction } = request.body
    const userId = request.user!.userId

    // S1: 文档归属校验 — 此前 docId 完全未使用,任意登录用户可调用
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Doc not found' })
    // S2: 选区长度上限
    if (typeof selection !== 'string' || !selection.trim()) {
      return reply.status(400).send({ error: 'selection required' })
    }
    if (selection.length > MAX_POLISH_CHARS) {
      return reply.status(413).send({ error: `选区过长(${selection.length} 字符),上限 ${MAX_POLISH_CHARS}` })
    }

    // #790: SSE 传输复用 createRawSseSender（断连 abort 信号 + 防写死
    // socket），不再手写 writeHead / (d:any) => raw.write。
    const sse = createRawSseSender(reply)
    // #797: 产出端过契约 — 发送形状由 PolishStreamChunk 编译期锁定。
    const send = (d: PolishStreamChunk) => sse.send(d)

    // S3+S5: 取消传导 — 客户端断开或总超时(随选区放宽,#869)都 abort 上游生成
    const controller = new AbortController()
    let finished = false
    const finish = () => { if (!finished) { finished = true; sse.end() } }
    reply.raw.on('close', () => controller.abort())
    // #869: 150s 基线 + 10ms/字符,上限 600s — 大选区+思维链不再被掐。
    const deadline = setTimeout(() => controller.abort(), resolvePolishDeadlineMs(selection.length))
    // S4: 心跳 — 长思考静默期防代理空闲掐断(SSE 注释行,客户端解析器自动忽略)
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n') } catch { /* closed */ }
    }, 15_000)

    try {
      let textChunks = 0
      for await (const chunk of polishSelection(selection, instruction, userId, (reasoning) => {
        send({ type: 'reasoning', text: reasoning })
      }, controller.signal)) {
        textChunks++
        send({ text: chunk })
      }
      if (textChunks === 0) {
        // 空流自动降级:非流式 chatWithMeta(#548 双倍额度重试)—
        // #687: LLM 调用与净化都在 writing service,router 只做 SSE 映射。
        slog.warn(`[polish] empty stream, falling back to non-streaming (model=${resolvePolishModel()}, selection=${selection.length}c)`)
        const text = await polishSelectionFallback(selection, instruction, userId, controller.signal, (reasoning) => send({ type: 'reasoning', text: reasoning }))
        send({ text })
      }
      send({ done: true })
    } catch (err: any) {
      if (controller.signal.aborted) {
        // 客户端取消/总超时 — 连接已死,仅记日志
        slog.info(`[polish] aborted (${err?.name === 'AbortError' ? 'client/timeout' : err?.message?.slice(0, 80)})`)
      } else {
        let message = err?.message || 'AI 服务错误'
        if (err?.name === 'LlmTruncatedError') {
          message = err.hadReasoning && !err.hadContent
            ? '模型思考超出输出额度且未产出正文,请缩小选中范围后重试'
            : '回答因输出额度被截断,请缩小选中范围后重试'
        }
        send({ type: 'error', message })
      }
    } finally {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      finish()
    }
  })

  // #3: Doc Chat SSE — structured output that can edit the document
  // §15.4: the standalone doc chat is deprecated — writing chat now runs
  // through the unified /agent/chat pipeline (session doc-{docId}).
  // §15.4: the standalone doc chat is deprecated — writing chat now runs
  // through the unified /agent/chat pipeline (session doc-{docId}).
  app.post('/api/v1/docs/:docId/chat', async (_request, reply) => {
    return reply.status(410).send({
      error: 'Gone',
      message: 'Document chat is now part of the main chat pipeline — use /api/v1/agent/chat with session_id doc-<docId>',
    })
  })

  app.post<{ Params: DocParams; Querystring: { format?: string } }>('/api/v1/docs/:docId/export', async (request, reply) => {
    const { docId } = request.params
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    // #fix: 支持 ?format=docx|pdf(默认 docx);两个渲染器共享块解析器。
    const rawFormat = String(request.query?.format || 'docx').toLowerCase()
    const format = isExportFormat(rawFormat) ? rawFormat : 'docx'
    const title = doc.title || 'Untitled'
    const body = doc.body || ''

    // #fix: 双格式导出共享块解析器;传 userId 以便内嵌图从本用户
    // uploads 目录读取并嵌入导出文件。
    // #821 管线 A: mermaid 围栏/公式行先 ensureFigure → 托管图片行
    // (失败降级原文本,15s/图预算,缓存命中不等待)。
    const { resolveFiguresToImageLines } = await import('../figures/figure-markdown.js')
    const { ensureFigure } = await import('../figures/figure.service.js')
    const exportBody = await resolveFiguresToImageLines(userId, body, ensureFigure)
    const buffer = format === 'pdf'
      ? await renderPdfBuffer(title, exportBody, userId)
      : await renderDocxBuffer(title, exportBody, userId)

    const safeName = (doc.title || 'document').replace(/[^a-z0-9\u4e00-\u9fa5 _-]/gi, '_').trim() || 'document'
    const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_')
    const encoded = encodeURIComponent(safeName)
    const contentType = format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    return reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `attachment; filename="${asciiName}.${format}"; filename*=UTF-8''${encoded}.${format}`)
      .send(buffer)
  })

  // ── References ──
  app.post<{ Params: DocParams; Body: { kind?: string; content?: string; label?: string; source_patient_hash?: string } }>('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const { kind, content, label, source_patient_hash } = request.body
    const id = `ref_${uid()}`
    const now = new Date().toISOString()
    await prisma.docReference.create({
      data: {
        id,
        docId,
        userId,
        refType: kind || 'note',
        targetId: source_patient_hash || '',
        snapshot: content || '',
        sourceNodes: JSON.stringify({ label: label || '' }),
        granularity: 'doc',
        createdAt: now,
      },
    })
    // #fix: 上传即草稿 — 文件类参考(pdf/docx/file)挂到空文档时自动导入
    // 为正文(含图片托管 + 快照),用户上传后立即能在编辑框看到原文,
    // 模型上下文也直接有 Current Document,不再"解读+计划+确认"循环。
    // #777: pptx 走后台异步解析（上传响应不等待 — 50MB pptx 解包秒级）：
    // deck 落点（Doc.deck，deck 视图可编辑）+ 空 doc 正文导入 markdown。
    const refFileName = String(label || content || '')
    const isPptxRef = (kind || 'note') === 'file' && /\.pptx$/i.test(refFileName)
    let pptxParse: { started: boolean; reason?: string } | null = null
    if (isPptxRef) {
      const fileIndex = await prisma.fileIndex.findFirst({ where: { userId, name: refFileName, deletedAt: null } }).catch(() => null)
      if (!fileIndex) {
        pptxParse = { started: false, reason: '上传记录缺失，无法解析 PPT' }
      } else if (Number(fileIndex.sizeBytes || 0) > 50 * 1024 * 1024) {
        pptxParse = { started: false, reason: '文件超过 50MB，已跳过 PPT 解析' }
      } else {
        pptxParse = { started: true }
        void (async () => {
          try {
            const parsed = extractPptxContentFromUpload(userId, fileIndex.id)
            if (parsed.error) return
            // deck 落点：覆盖写入（同帧快照旧 deck，label 'AI deck'，与
            // organize 重生成一致）；文章正文不受影响。
            const deck = pptxSlidesToDeck(parsed.slides, parsed.images, doc.title || refFileName, SCHEMA_VERSION)
            if (deck) {
              // #789: 写回走 DocVersionWriter 单点 — 事务 + 同帧快照旧
              // body+deck；writer 内部重读新行,不再用 handler 早前捕获的
              // doc（后台执行时可能已过期）。
              const written = await writeDocVersion({
                userId, docId, deck, snapshotLabel: 'AI deck',
              })
              if (written.error) {
                log.warn('pptx deck write-back failed', { docId, reason: written.error.slice(0, 200) })
              }
            }
            // 文章落点：正文为空时导入 markdown（## 分节 + 图片托管）。
            // #787: 编排走 ensureDraftBody（此前此处内联了第三份导入决策）。
            if (!String(doc.body || '').trim()) {
              await ensureDraftBody(userId, docId, { scenario: 'upload', preferLabel: refFileName })
            }
          } catch (err) {
            // #787: 后台解析失败不阻断上传 — 但必须留痕(此前空 catch)。
            log.warn('pptx background parse failed', { docId, reason: (err as Error)?.message?.slice(0, 200) })
          }
        })()
      }
    }
    const autoImport = (async () => {
      try {
        if (isPptxRef) return null // #777: pptx 走后台，不阻塞上传响应
        if (kind !== 'file' && kind !== 'pdf' && kind !== 'docx') return null
        // 契约:ensureDraftBody 只在空正文时调用 — 已有正文不导入不覆盖。
        if (String(doc.body || '').trim()) return null
        const ensured = await ensureDraftBody(userId, docId, { scenario: 'upload', preferLabel: label || content || '' })
        // #787: 不再实例化 EditDocumentTool(Tool 是模型入口,不是 service);
        // 空/多参考的引导文案对上传路径无意义,失败静默但保留日志。
        return ensured.error ? null : ensured.body
      } catch (err) {
        log.warn('reference auto-import failed', { docId, reason: (err as Error)?.message?.slice(0, 200) })
        return null
      }
    })()
    const importedBody = await autoImport
    return {
      reference_id: id, kind: kind || 'note', content: content || '', label: label || '',
      source_patient_hash: source_patient_hash || '', created_at: now,
      // #fix: 上传即草稿 — 自动导入后的正文(空文档 + 文件类参考时)。
      imported_body: importedBody,
      imported: importedBody !== null,
      // #777: pptx 上传即后台解析（deck 落点）— 前端据 started 轮询刷新。
      pptx_parse: pptxParse,
    }
  })

  app.get<{ Params: DocParams }>('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params
    const userId = request.user!.userId
    const refs = await prisma.docReference.findMany({
      where: { docId, userId },
      orderBy: { createdAt: 'desc' },
    })
    return {
      references: refs.map((r) => {
        let meta: { label?: string } = {}
        try { meta = JSON.parse(r.sourceNodes || '{}') } catch { /* ignore */ }
        return {
          reference_id: r.id,
          kind: r.refType,
          content: r.snapshot,
          label: meta.label || '',
          source_patient_hash: r.targetId,
          created_at: r.createdAt,
        }
      }),
    }
  })

  // #711: 参考材料可删除 — 传错文件/不再需要的材料要从 AI 上下文中移除。
  app.delete<{ Params: DocRefParams }>('/api/v1/docs/:docId/references/:referenceId', async (request, reply) => {
    const { docId, referenceId } = request.params
    const userId = request.user!.userId
    const ref = await prisma.docReference.findFirst({ where: { id: referenceId, docId, userId } })
    if (!ref) return reply.status(404).send({ error: 'Reference not found' })
    await prisma.docReference.delete({ where: { id: referenceId } })
    return { ok: true }
  })

  // ── #383: research ↔ paper linkage ──
  // Generate a Methods draft from the linked study's protocol rules.
  app.post<{ Params: DocParams }>('/api/v1/docs/:docId/generate-methods', async (request, reply) => {
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    if (!doc.studyId) return reply.status(400).send({ error: 'This paper is not linked to a study' })

    const rules = await prisma.studyProtocolRule.findMany({
      where: { studyId: doc.studyId, status: { not: 'superseded' } },
      orderBy: { category: 'asc' },
    })
    const byCategory: Record<string, string[]> = {}
    for (const r of rules) {
      (byCategory[r.category] ||= []).push(r.rule)
    }
    const study = await prisma.researchStudy.findFirst({ where: { id: doc.studyId } })
    const methods = await writeMethodsSection({ study, byCategory, userId: request.user!.userId })
    return { methods }
  })

  // Inject a statistics output block (from #361 stat tools) into the paper.
  app.post<{ Params: DocParams; Body: { label?: string; result?: unknown } }>('/api/v1/docs/:docId/inject-results', async (request, reply) => {
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const { label, result } = request.body
    if (!label || !result) return reply.status(400).send({ error: 'label and result required' })
    const block = `\n\n## ${String(label)}\n\n${String(result).slice(0, 8000)}\n`
    // #927: 写回走 DocVersionWriter 单点 — 事务 + 同帧快照(label 'AI inject
    // results')+ #904 乐观锁;并发修改时拒绝而非静默覆盖,与 edit_document
    // 等工具路径同语义(此前裸 doc.update 无快照无并发保护)。
    const written = await writeDocVersion({
      userId: request.user!.userId,
      docId: doc.id,
      body: doc.body + block,
      snapshotLabel: 'AI inject results',
    })
    if (written.error) {
      return reply.status(written.conflict ? 409 : 500).send({ error: written.error })
    }
    return { ok: true }
  })

  // One-shot: create a paper from a study with title/abstract background.
  app.post<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/paper', async (request, reply) => {
    const { studyId } = request.params
    const study = await prisma.researchStudy.findFirst({ where: { id: studyId, userId: request.user!.userId } })
    if (!study) return reply.status(404).send({ error: 'Study not found' })
    const id = `doc_${uid()}`
    const now = new Date().toISOString()
    const title = `${study.name} — Clinical Outcomes`
    const background = await writePaperBackground(title, request.user!.userId)
    await prisma.doc.create({ data: { id, userId: request.user!.userId, title, body: background, studyId, createdAt: now, updatedAt: now } })
    return { doc_id: id, title, body: background }
  })

}
