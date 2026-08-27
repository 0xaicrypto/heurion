import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import crypto from 'crypto'
import { renderDocxBuffer, renderPdfBuffer, isExportFormat } from './markdown-export.js'
import { polishSelection, writeMethodsSection, writePaperBackground } from './document-writing.service.js'

function uid() { return crypto.randomBytes(8).toString('hex') }

export async function documentsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Docs CRUD ──
  app.get('/api/v1/docs', async (request) => {
    const docs = await (prisma as any).doc.findMany({
      where: { userId: request.user!.userId }, orderBy: { updatedAt: 'desc' },
    })
    return { docs: docs.map((d: any) => ({
      id: d.id, title: d.title, body: d.body,
      updated_at: d.updatedAt, created_at: d.createdAt, ref_count: 0,
    }))}
  })

  app.post('/api/v1/docs', async (request) => {
    const { title, study_id } = request.body as any
    const id = `doc_${uid()}`
    const now = new Date().toISOString()
    const userId = request.user!.userId
    // #383: creating a paper linked to a study — optionally prefill title
    // and abstract from the study's name/purpose.
    let study: any = null
    if (study_id) {
      study = await (prisma as any).researchStudy.findFirst({ where: { id: study_id, userId } })
      if (!study) return { error: 'Study not found' }
    }
    try {
      await (prisma as any).doc.create({ data: { id, userId, title: title || 'Untitled', body: '', studyId: study_id || null, createdAt: now, updatedAt: now } })
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

  app.get('/api/v1/docs/:docId', async (request, reply) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    // #383: expose the linked study so the editor can show context + methods.
    let study_name: string | null = null
    if (doc.studyId) {
      const st = await (prisma as any).researchStudy.findFirst({ where: { id: doc.studyId } })
      study_name = st?.name || null
    }
    return { id: doc.id, title: doc.title, body: doc.body, created_at: doc.createdAt, updated_at: doc.updatedAt, study_id: doc.studyId || null, study_name }
  })

  app.put('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params as any
    const { title, body } = request.body as any
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: request.user!.userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })

    const now = new Date().toISOString()
    const data: any = { updatedAt: now }
    if (title !== undefined) data.title = title

    // 查重 + 版本:body 未变化时不创建快照、不刷新 updatedAt(避免
    // 重复保存产生空版本/列表跳动);变化时快照旧 body 作为版本。
    const bodyChanged = body !== undefined && body !== existing.body
    if (bodyChanged) {
      await (prisma as any).docSnapshot.create({
        data: {
          docId,
          userId: request.user!.userId,
          body: existing.body,
          label: '保存版本',
          createdAt: now,
        },
      })
      data.body = body
    } else {
      delete data.updatedAt
    }

    await (prisma as any).doc.update({ where: { id: docId }, data })
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    return {
      id: doc!.id, title: doc!.title, body: doc!.body,
      created_at: doc!.createdAt, updated_at: doc!.updatedAt,
      // #598: 前端保存按钮据此提示'内容未变化'.
      unchanged: !bodyChanged,
    }
  })

  app.delete('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })
    await (prisma as any).doc.delete({ where: { id: docId } })
    return { deleted: true }
  })

  // ── Snapshots ──
  app.get('/api/v1/docs/:docId/snapshots', async (request) => {
    const snaps = await (prisma as any).docSnapshot.findMany({
      where: { docId: (request.params as any).docId }, orderBy: { id: 'desc' },
    })
    // #598: 返回字段与前端约定一致(snapshot_id / body_preview),此前
    // id/body 不匹配导致 History 面板渲染 undefined、点击无反应。
    return { snapshots: snaps.map((s: any) => ({
      snapshot_id: String(s.id),
      created_at: s.createdAt,
      body_preview: (s.body || '').slice(0, 80),
      label: s.label || '保存版本',
    })) }
  })

  // #764: 快照全文 — Restore 前先与当前版本做 diff 审阅,确认后才 apply。
  app.get('/api/v1/docs/:docId/snapshots/:snapId', async (request, reply) => {
    const { docId, snapId } = request.params as any
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { id: Number(snapId), docId } })
    if (!snap) return reply.status(404).send({ error: 'Not found' })
    return { id: String(snap.id), created_at: snap.createdAt, label: snap.label || '保存版本', body: snap.body || '' }
  })

  app.post('/api/v1/docs/:docId/snapshots/:snapId/restore', async (request, reply) => {
    const { docId, snapId } = request.params as any
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { id: Number(snapId), docId } })
    if (!snap) return reply.status(404).send({ error: 'Not found' })
    await (prisma as any).doc.update({ where: { id: docId }, data: { body: snap.body, updatedAt: new Date().toISOString() } })
    return { restored: true }
  })

  // ── PHI Scan ──
  app.post('/api/v1/docs/:docId/phi-scan', async (request) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
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

  // #3: AI Polish SSE — uses DeepSeek
  app.post('/api/v1/docs/:docId/polish', async (request, reply) => {
    const { selection, instruction } = request.body as any
    const userId = request.user!.userId
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (d: any) => reply.raw.write(`data: ${JSON.stringify(d)}\n\n`)
    try {
      for await (const chunk of polishSelection(selection, instruction, userId)) {
        send({ text: chunk })
      }
      send({ done: true })
    } catch (err: any) {
      send({ type: 'error', message: err.message })
    } finally {
      reply.raw.end()
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

  app.post('/api/v1/docs/:docId/export', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    // #fix: 支持 ?format=docx|pdf(默认 docx);两个渲染器共享块解析器。
    const rawFormat = String((request.query as any)?.format || 'docx').toLowerCase()
    const format = isExportFormat(rawFormat) ? rawFormat : 'docx'
    const title = doc.title || 'Untitled'
    const body = doc.body || ''

    // #fix: 双格式导出共享块解析器;传 userId 以便内嵌图从本用户
    // uploads 目录读取并嵌入导出文件。
    const buffer = format === 'pdf'
      ? await renderPdfBuffer(title, body, userId)
      : await renderDocxBuffer(title, body, userId)

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
  app.post('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const { kind, content, label, source_patient_hash } = request.body as any
    const id = `ref_${uid()}`
    const now = new Date().toISOString()
    await (prisma as any).docReference.create({
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
    const autoImport = (async () => {
      try {
        if (kind !== 'file' && kind !== 'pdf' && kind !== 'docx') return null
        if (String(doc.body || '').trim()) return null
        const { EditDocumentTool } = await import('../../tools/edit-document-tool.js')
        const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
        const result = await tool.execute({ import_reference: label || content })
        return result.success ? (JSON.parse(result.output as string) as { body: string }).body : null
      } catch {
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
    }
  })

  app.get('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const refs = await (prisma as any).docReference.findMany({
      where: { docId, userId },
      orderBy: { createdAt: 'desc' },
    })
    return {
      references: refs.map((r: any) => {
        let meta: any = {}
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
  app.delete('/api/v1/docs/:docId/references/:referenceId', async (request, reply) => {
    const { docId, referenceId } = request.params as any
    const userId = request.user!.userId
    const ref = await (prisma as any).docReference.findFirst({ where: { id: referenceId, docId, userId } })
    if (!ref) return reply.status(404).send({ error: 'Reference not found' })
    await (prisma as any).docReference.delete({ where: { id: referenceId } })
    return { ok: true }
  })

  // ── #383: research ↔ paper linkage ──
  // Generate a Methods draft from the linked study's protocol rules.
  app.post('/api/v1/docs/:docId/generate-methods', async (request, reply) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    if (!doc.studyId) return reply.status(400).send({ error: 'This paper is not linked to a study' })

    const rules = await (prisma as any).studyProtocolRule.findMany({
      where: { studyId: doc.studyId, status: { not: 'superseded' } },
      orderBy: { category: 'asc' },
    })
    const byCategory: Record<string, string[]> = {}
    for (const r of rules) {
      (byCategory[r.category] ||= []).push(r.rule)
    }
    const study = await (prisma as any).researchStudy.findFirst({ where: { id: doc.studyId } })
    const methods = await writeMethodsSection({ study, byCategory, userId: request.user!.userId })
    return { methods }
  })

  // Inject a statistics output block (from #361 stat tools) into the paper.
  app.post('/api/v1/docs/:docId/inject-results', async (request, reply) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const { label, result } = request.body as any
    if (!label || !result) return reply.status(400).send({ error: 'label and result required' })
    const block = `\n\n## ${String(label)}\n\n${String(result).slice(0, 8000)}\n`
    await (prisma as any).doc.update({
      where: { id: doc.id },
      data: { body: doc.body + block, updatedAt: new Date().toISOString() },
    })
    return { ok: true }
  })

  // One-shot: create a paper from a study with title/abstract background.
  app.post('/api/v1/research/studies/:studyId/paper', async (request, reply) => {
    const { studyId } = request.params as any
    const study = await (prisma as any).researchStudy.findFirst({ where: { id: studyId, userId: request.user!.userId } })
    if (!study) return reply.status(404).send({ error: 'Study not found' })
    const id = `doc_${uid()}`
    const now = new Date().toISOString()
    const title = `${study.name} — Clinical Outcomes`
    const background = await writePaperBackground(title, request.user!.userId)
    await (prisma as any).doc.create({ data: { id, userId: request.user!.userId, title, body: background, studyId, createdAt: now, updatedAt: now } })
    return { doc_id: id, title, body: background }
  })

}
