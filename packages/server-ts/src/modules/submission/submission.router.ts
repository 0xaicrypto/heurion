/**
 * #362: submission workflow — journal recommendation, cover letter
 * generation, format templates, and persistent drafts.
 * Phase 1 scope: recommend-journals / cover-letter / templates / drafts.
 */
import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { matchJournals } from './journals.js'
import { generateCoverLetter, FORMAT_TEMPLATES, buildPrefilledTemplate } from './cover-letter.js'

export async function submissionRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── 选刊推荐：标题/摘要 → Top 5 期刊 ──────────────────────────────
  app.post('/api/v1/submission/recommend-journals', async (request, reply) => {
    const { title, abstract, limit } = request.body as { title?: string; abstract?: string; limit?: number }
    if (!title || !String(title).trim()) {
      return reply.status(400).send({ error: '标题不能为空' })
    }
    const matches = matchJournals(String(title), String(abstract || ''), Math.min(limit || 5, 10))
    if (matches.length === 0) {
      return { journals: [], message: '未找到匹配期刊，可尝试补充摘要关键词' }
    }
    return {
      journals: matches.map(({ journal, score, reason }) => ({
        id: journal.id,
        name: journal.name,
        impact_factor: journal.impactFactor,
        acceptance_rate: journal.acceptanceRate,
        review_weeks: journal.reviewWeeks,
        cas_zone: journal.casZone,
        match_score: score,
        reason,
      })),
    }
  })

  // ── Cover letter 生成 ──────────────────────────────────────────────
  app.post('/api/v1/submission/cover-letter', async (request, reply) => {
    const body = request.body as {
      title?: string
      abstract?: string
      authors?: string[]
      journal_name?: string
      highlights?: string[]
      corresponding_author?: string
      doc_id?: string
    }
    if (!body.title || !String(body.title).trim()) {
      return reply.status(400).send({ error: '标题不能为空' })
    }
    try {
      // #382 联动点 5: 若论文已写入写作文档，把正文交给 LLM 提取亮点。
      let docText = ''
      if (body.doc_id) {
        const doc = await (prisma as any).doc.findFirst({ where: { id: body.doc_id, userId: request.user!.userId } })
        if (doc?.body) docText = doc.body.slice(0, 6000)
      }
      const { coverLetter, highlights } = await generateCoverLetter({
        title: String(body.title),
        abstract: body.abstract && !docText ? String(body.abstract) : docText ? `FULL DOCUMENT:\n${docText}` : String(body.abstract || ''),
        authors: body.authors,
        journalName: body.journal_name,
        highlights: body.highlights,
        correspondingAuthor: body.corresponding_author,
      })
      return { cover_letter: coverLetter, highlights }
    } catch (err: any) {
      return reply.status(502).send({ error: `Cover letter 生成失败：${err?.message?.slice(0, 120) || 'LLM 不可用'}` })
    }
  })

  // ── 期刊模板列表 + 预填充 ─────────────────────────────────────────
  app.get('/api/v1/submission/templates', async () => {
    return {
      templates: FORMAT_TEMPLATES.map((t) => ({
        id: t.id,
        journal_name: t.journalName,
        journal_id: t.journalId,
        sections: t.sections,
        reference_style: t.referenceStyle,
        word_limit: t.wordLimit,
        notes: t.notes,
      })),
    }
  })

  app.post('/api/v1/submission/templates/prefill', async (request, reply) => {
    const { template_id, title, abstract, authors } = request.body as {
      template_id?: string
      title?: string
      abstract?: string
      authors?: string[]
    }
    const template = FORMAT_TEMPLATES.find((t) => t.id === template_id)
    if (!template) return reply.status(404).send({ error: '模板不存在' })
    return {
      template_id: template.id,
      journal_name: template.journalName,
      content: buildPrefilledTemplate(template, { title: String(title || '[论文标题]'), abstract: String(abstract || ''), authors }),
    }
  })

  // ── 投稿前检查清单（#362 阶段2）───────────────────────────────────
  app.get('/api/v1/submission/checklist', async (request) => {
    const draft = await (prisma as any).submissionDraft.findFirst({
      where: { userId: request.user!.userId, status: { not: 'submitted' } },
      orderBy: { updatedAt: 'desc' },
    })
    const checks = [
      { id: 'title', label: '标题已填写', ok: !!(draft?.articleTitle && String(draft.articleTitle).trim().length >= 5) },
      { id: 'abstract', label: '摘要已填写', ok: !!(draft?.abstract && String(draft.abstract).trim().length >= 50) },
      { id: 'authors', label: '作者列表完整', ok: !!(draft?.authors && JSON.parse(draft.authors).length > 0) },
      { id: 'journal', label: '已选定目标期刊', ok: !!draft?.targetJournal },
      { id: 'cover', label: 'Cover letter 已生成', ok: !!(draft?.coverLetter && String(draft.coverLetter).length > 100) },
      { id: 'template', label: '已套用期刊模板', ok: !!draft?.templateId },
      { id: 'ethics', label: '伦理/IRB 声明（建议包含）', ok: !!(draft?.coverLetter && /IRB|ethical|institutional review|伦理/i.test(draft.coverLetter)) },
      { id: 'originality', label: '原创性声明（建议包含）', ok: !!(draft?.coverLetter && /not (been )?published|original|原创/i.test(draft.coverLetter)) },
      { id: 'conflict', label: '利益冲突声明（建议包含）', ok: !!(draft?.coverLetter && /conflict|利益冲突|disclosure/i.test(draft.coverLetter)) },
    ]
    const passed = checks.filter((c) => c.ok).length
    return { checks, passed, total: checks.length, ready: passed === checks.length }
  })

  // ── 投稿状态追踪（#362 阶段2）─────────────────────────────────────
  app.post('/api/v1/submission/status', async (request, reply) => {
    const { status } = request.body as any
    const allowed = ['draft', 'ready', 'submitted', 'revision', 'published']
    if (!allowed.includes(status)) return reply.status(400).send({ error: `status must be one of: ${allowed.join(', ')}` })
    const draft = await (prisma as any).submissionDraft.findFirst({
      where: { userId: request.user!.userId, status: { not: 'submitted' } },
      orderBy: { updatedAt: 'desc' },
    })
    if (!draft) return reply.status(404).send({ error: 'No draft to update' })
    const now = new Date().toISOString()
    const updated = await (prisma as any).submissionDraft.update({
      where: { id: draft.id },
      data: { status, updatedAt: now },
    })
    return { draft: toDraft(updated), ok: true }
  })

  // ── 投稿草稿（刷新不丢失）────────────────────────────────────────
  app.get('/api/v1/submission/drafts', async (request) => {
    const drafts = await (prisma as any).submissionDraft.findMany({
      where: { userId: request.user!.userId },
      orderBy: { updatedAt: 'desc' },
    })
    return { drafts: drafts.map(toDraft) }
  })

  app.post('/api/v1/submission/drafts', async (request, reply) => {
    const body = request.body as {
      article_title?: string
      abstract?: string
      keywords?: string
      authors?: string[]
      target_journal?: string
      cover_letter?: string
      template_id?: string
      status?: string
    }
    if (!body.article_title || !String(body.article_title).trim()) {
      return reply.status(400).send({ error: '标题不能为空' })
    }
    const now = new Date().toISOString()

    // Single active draft per user for phase 1: upsert on the latest row.
    const existing = await (prisma as any).submissionDraft.findFirst({
      where: { userId: request.user!.userId, status: body.status || 'draft' },
      orderBy: { updatedAt: 'desc' },
    })
    const data = {
      userId: request.user!.userId,
      articleTitle: String(body.article_title).trim(),
      abstract: body.abstract ?? null,
      keywords: body.keywords ?? null,
      authors: body.authors ? JSON.stringify(body.authors) : null,
      targetJournal: body.target_journal ?? null,
      coverLetter: body.cover_letter ?? null,
      templateId: body.template_id ?? null,
      status: body.status || 'draft',
      updatedAt: now,
    }
    let saved
    if (existing) {
      saved = await (prisma as any).submissionDraft.update({ where: { id: existing.id }, data })
    } else {
      saved = await (prisma as any).submissionDraft.create({ data: { ...data, createdAt: now } })
    }
    return { draft: toDraft(saved), ok: true }
  })
}

function toDraft(d: any) {
  return {
    id: d.id,
    article_title: d.articleTitle,
    abstract: d.abstract,
    keywords: d.keywords,
    authors: d.authors ? JSON.parse(d.authors) : [],
    target_journal: d.targetJournal,
    cover_letter: d.coverLetter,
    template_id: d.templateId,
    status: d.status,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  }
}
