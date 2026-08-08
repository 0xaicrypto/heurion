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
    }
    if (!body.title || !String(body.title).trim()) {
      return reply.status(400).send({ error: '标题不能为空' })
    }
    try {
      const { coverLetter, highlights } = await generateCoverLetter({
        title: String(body.title),
        abstract: String(body.abstract || ''),
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
