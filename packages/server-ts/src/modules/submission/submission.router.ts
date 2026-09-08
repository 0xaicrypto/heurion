/**
 * #362: submission workflow — journal recommendation, cover letter
 * generation, format templates, and persistent drafts.
 * Phase 1 scope: recommend-journals / cover-letter / templates / drafts.
 */
import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { getJournalRepository } from './journal-repository.js'
import { recommendTiers } from './selection-engine.js'
import { enrichJournal, enrichRecommendations } from './journal-enrich.js'
import { fetchGuideForAuthors, precheckAgainstGuide } from './guide-for-authors.js'
import type { JournalRecord, Recommendation, SelectionProfile } from './journal-types.js'
import { generateCoverLetter, FORMAT_TEMPLATES, buildPrefilledTemplate } from './cover-letter.js'

/** JournalRecord → snake_case DTO(前端契约)。 */
function toJournalDto(j: JournalRecord) {
  return {
    id: j.id,
    name: j.name,
    issn: j.issn ?? null,
    publisher: j.publisher ?? null,
    zh_name: j.zhName ?? null,
    description: j.description ?? null,
    metrics: {
      impact_factor: j.metrics.impactFactor ?? null,
      cas_zone: j.metrics.casZone ?? null,
      acceptance_rate: j.metrics.acceptanceRate ?? null,
      review_weeks_median: j.metrics.reviewWeeksMedian ?? null,
      apc: j.metrics.apc ?? null,
      open_alex: j.metrics.openAlex ?? null,
      article_type_distribution: j.metrics.articleTypeDistribution ?? null,
    },
    scope: j.scope,
    article_types: j.articleTypes,
    oa: j.oa ?? false,
    guide_url: j.guideUrl ?? null,
    similar_works: j.similarWorks ?? null,
    warnings: j.warnings,
    logo: j.logo,
    freshness: j.freshness,
  }
}

function toRecommendationDto(r: Recommendation) {
  return {
    journal: toJournalDto(r.journal),
    tier: r.tier,
    total_score: r.totalScore,
    breakdown: r.breakdown.map((b) => ({ dimension: b.dimension, score: b.score, evidence: b.evidence })),
  }
}

export async function submissionRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── 选刊推荐 v2(#848/#850):SelectionProfile → 三档梯度 + 红线区 ──
  app.post('/api/v1/submission/recommend-journals', async (request, reply) => {
    const body = request.body as {
      title?: string; abstract?: string; article_type?: string
      priority?: string; self_pay_oa?: boolean; language?: string
    }
    if (!body.title || !String(body.title).trim()) {
      return reply.status(400).send({ error: '标题不能为空' })
    }
    const profile: SelectionProfile = {
      title: String(body.title),
      abstract: body.abstract ? String(body.abstract) : undefined,
      articleType: body.article_type || undefined,
      priority: (['impact', 'speed', 'acceptance'] as const).includes(body.priority as never) ? body.priority as SelectionProfile['priority'] : undefined,
      selfPayOa: !!body.self_pay_oa,
      language: body.language === 'zh' || body.language === 'en' ? body.language : undefined,
    }
    const result = recommendTiers(profile)
    // #852 动态富化:仅对入档 picks 外呼(≤9 本);失败回落 seed,不阻塞。
    // 方案1:稿件标题作为同类文章检索词 — 每本 pick 附该刊近两年相似工作。
    const tiers = {
      reach: await enrichRecommendations(result.tiers.reach, profile.title),
      match: await enrichRecommendations(result.tiers.match, profile.title),
      safety: await enrichRecommendations(result.tiers.safety, profile.title),
    }
    return {
      engine: result.engine,
      profile_echo: {
        priority: result.profileEcho.priority,
        article_type: result.profileEcho.articleType ?? null,
        self_pay_oa: result.profileEcho.selfPayOa,
      },
      tiers: {
        reach: tiers.reach.map(toRecommendationDto),
        match: tiers.match.map(toRecommendationDto),
        safety: tiers.safety.map(toRecommendationDto),
      },
      redline: result.redline.map(({ journal }) => toJournalDto(journal)),
      warning_list_asof: result.redline[0]?.journal.warnings[0]?.asOf ?? null,
    }
  })

  // ── 期刊检索/目录(#849 Repository 直查)─────────────────────────
  app.get('/api/v1/submission/journals', async (request) => {
    const { q, scope } = request.query as { q?: string; scope?: string }
    const repo = getJournalRepository()
    const journals = q ? repo.search(q) : scope ? repo.listByScope(scope) : repo.listAll()
    return {
      total: repo.count,
      journals: journals.slice(0, 50).map(toJournalDto),
    }
  })

  // ── 期刊详情(动态富化:OpenAlex/DOAJ,失败回落 seed)────────────
  app.get('/api/v1/submission/journals/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const journal = getJournalRepository().get(id)
    if (!journal) return reply.status(404).send({ error: '期刊不存在' })
    const enriched = await enrichJournal(journal)
    return { journal: toJournalDto(enriched) }
  })

  // ── Guide for Authors(#851):抓取 + 结构化抽取(24h 缓存)────────
  app.post('/api/v1/submission/guide-for-authors', async (request, reply) => {
    const { journal_id } = request.body as { journal_id?: string }
    const journal = journal_id ? getJournalRepository().get(journal_id) : null
    if (!journal) return reply.status(400).send({ error: 'journal_id 无效' })
    const result = await fetchGuideForAuthors(journal)
    if (!result.ok) {
      // 降级不是错误:HTTP 200 + ok:false + 人工核对路径
      return { ok: false, reason: result.reason, manual_url: result.manualUrl ?? null }
    }
    return {
      ok: true,
      requirements: {
        journal_id: result.requirements.journalId,
        journal_name: result.requirements.journalName,
        body_word_limit: result.requirements.bodyWordLimit ?? null,
        abstract_word_limit: result.requirements.abstractWordLimit ?? null,
        abstract_structure: result.requirements.abstractStructure ?? null,
        figure_limit: result.requirements.figureLimit ?? null,
        reference_style: result.requirements.referenceStyle ?? null,
        required_statements: result.requirements.requiredStatements ?? [],
        confidence: result.requirements.confidence,
        source_url: result.requirements.sourceUrl ?? null,
        fetched_at: result.requirements.fetchedAt,
      },
    }
  })

  // ── 投稿前检查(#851):文档 vs 该刊要求逐项 ✓✗/人工 ─────────────
  app.post('/api/v1/submission/precheck', async (request, reply) => {
    const { journal_id, doc_id, text } = request.body as { journal_id?: string; doc_id?: string; text?: string }
    const journal = journal_id ? getJournalRepository().get(journal_id) : null
    if (!journal) return reply.status(400).send({ error: 'journal_id 无效' })
    let docText = String(text || '')
    if (!docText && doc_id) {
      const doc = await prisma.doc.findFirst({ where: { id: doc_id, userId: request.user!.userId } })
      if (doc?.body) docText = doc.body
    }
    const guide = await fetchGuideForAuthors(journal)
    const requirements = guide.ok ? guide.requirements : null
    const items = precheckAgainstGuide(requirements, docText)
    return {
      journal_id: journal.id,
      ok: guide.ok,
      reason: guide.ok ? null : guide.reason,
      manual_url: guide.ok ? null : guide.manualUrl ?? null,
      items,
      passed: items.filter((i) => i.ok === true).length,
      manual_count: items.filter((i) => i.ok === null).length,
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
        const doc = await prisma.doc.findFirst({ where: { id: body.doc_id, userId: request.user!.userId } })
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
    const userId = request.user!.userId
    const docId = (request.query as any).doc_id as string | undefined
    // #726: 按文档隔离 — 无 doc_id 时回退旧行为(最新一条)。
    const draft = docId
      ? await prisma.submissionDraft.findFirst({
          where: { userId, docId },
          orderBy: { updatedAt: 'desc' },
        })
      : await prisma.submissionDraft.findFirst({
          where: { userId, status: { not: 'submitted' } },
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
    const { status, doc_id } = request.body as any
    const allowed = ['draft', 'ready', 'submitted', 'revision', 'published']
    if (!allowed.includes(status)) return reply.status(400).send({ error: `status must be one of: ${allowed.join(', ')}` })
    // #726: 按文档隔离状态追踪。
    const draft = doc_id
      ? await prisma.submissionDraft.findFirst({
          where: { userId: request.user!.userId, docId: doc_id },
          orderBy: { updatedAt: 'desc' },
        })
      : await prisma.submissionDraft.findFirst({
          where: { userId: request.user!.userId, status: { not: 'submitted' } },
          orderBy: { updatedAt: 'desc' },
        })
    if (!draft) return reply.status(404).send({ error: 'No draft to update' })
    const now = new Date().toISOString()
    const updated = await prisma.submissionDraft.update({
      where: { id: draft.id },
      data: { status, updatedAt: now },
    })
    return { draft: toDraft(updated), ok: true }
  })

  // ── 投稿草稿（刷新不丢失）────────────────────────────────────────
  app.get('/api/v1/submission/drafts', async (request) => {
    const drafts = await prisma.submissionDraft.findMany({
      where: { userId: request.user!.userId },
      orderBy: { updatedAt: 'desc' },
    })
    return { drafts: drafts.map(toDraft) }
  })

  app.post('/api/v1/submission/drafts', async (request, reply) => {
    const body = request.body as {
      doc_id?: string
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

    // #726: 按 docId 隔离投稿草稿 — 无 docId 时回退到"该状态最新一条"
    // (兼容旧前端/未关联文档的投稿面板)。
    const existing = body.doc_id
      ? await prisma.submissionDraft.findFirst({
          where: { userId: request.user!.userId, docId: body.doc_id },
          orderBy: { updatedAt: 'desc' },
        })
      : await prisma.submissionDraft.findFirst({
          where: { userId: request.user!.userId, status: body.status || 'draft' },
          orderBy: { updatedAt: 'desc' },
        })
    const data = {
      userId: request.user!.userId,
      docId: body.doc_id ?? null,
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
      saved = await prisma.submissionDraft.update({ where: { id: existing.id }, data })
    } else {
      saved = await prisma.submissionDraft.create({ data: { ...data, createdAt: now } })
    }
    return { draft: toDraft(saved), ok: true }
  })
}

function toDraft(d: any) {
  return {
    id: d.id,
    doc_id: d.docId ?? null,
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
