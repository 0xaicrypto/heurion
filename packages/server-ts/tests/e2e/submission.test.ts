import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #362: submission workflow — journal recommendation, templates, drafts.
 * Cover-letter generation requires a live LLM; the smoke path is guarded.
 */

describe('submission workflow (#362)', () => {
  beforeAll(async () => {
    // #852: e2e 保持封闭 — 关闭 OpenAlex/DOAJ 动态富化,全部回落 seed 快照。
    process.env.JOURNAL_DYNAMIC_DATA = 'off'
    await (prisma as any).submissionDraft.deleteMany({})
  })
  afterAll(async () => {
    delete process.env.JOURNAL_DYNAMIC_DATA
    await (prisma as any).submissionDraft.deleteMany({})
  })

  test('recommend-journals returns tiered recommendations (#848/#850)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submission/recommend-journals',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'EGFR-mutant non-small cell lung cancer treated with immune checkpoint inhibitors',
        abstract: 'Retrospective cohort of patients with EGFR mutation and NSCLC receiving immunotherapy; overall survival and progression-free survival analyzed.',
        article_type: 'real_world',
        priority: 'impact',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.engine).toBe('selection-v2')
    // 三档梯度:匹配档 2-3 本,每本带结构化 breakdown(D4)
    expect(body.tiers.match.length).toBeGreaterThanOrEqual(2)
    expect(body.tiers.match.length).toBeLessThanOrEqual(3)
    const top = body.tiers.match[0]
    expect(top.journal.name).toBeTruthy()
    expect(top.journal.metrics.impact_factor.value).toBeGreaterThan(0)
    expect(top.journal.metrics.acceptance_rate.value).toBeGreaterThan(0)
    expect(top.journal.metrics.review_weeks_median.value).toBeGreaterThan(0)
    expect(top.journal.metrics.cas_zone.value).toBeTruthy()
    expect(top.breakdown.length).toBeGreaterThan(0)
    expect(top.breakdown.some((b: any) => b.dimension === 'scope' && b.evidence)).toBe(true)
    // 肺癌关键词刊应出现在推荐档位中
    const ids = [...body.tiers.reach, ...body.tiers.match, ...body.tiers.safety].map((r: any) => r.journal.id)
    expect(ids.join(' ').toLowerCase()).toMatch(/lung|thoracic|jto/)
    // 预警刊不入档,红线区可见(D5)
    for (const id of ids) {
      const red = body.redline.find((j: any) => j.id === id)
      expect(red).toBeUndefined()
    }
    expect(body.redline.length).toBeGreaterThan(0)
    expect(body.redline[0].warnings[0].kind).toBe('cas_warning_list')
  })

  test('journals search + detail endpoints (#849)', async () => {
    const app = await getApp()
    const list = await app.inject({
      method: 'GET', url: '/api/v1/submission/journals?q=lancet',
      headers: await authHeader(),
    })
    expect(list.statusCode).toBe(200)
    const body = JSON.parse(list.payload)
    expect(body.total).toBeGreaterThan(190)
    expect(body.journals.length).toBeGreaterThan(0)

    const detail = await app.inject({
      method: 'GET', url: '/api/v1/submission/journals/bmc-cancer',
      headers: await authHeader(),
    })
    expect(detail.statusCode).toBe(200)
    const dj = JSON.parse(detail.payload).journal
    expect(dj.metrics.apc.value).toBeGreaterThan(0)
    expect(dj.logo.monogram).toBeTruthy()
  })

  test('precheck endpoint degrades gracefully (#851)', async () => {
    const app = await getApp()
    const h = { ...(await authHeader()), 'content-type': 'application/json' }
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submission/precheck',
      headers: h,
      payload: JSON.stringify({ journal_id: 'bmc-cancer', text: '# T\n\n## Abstract\n\nBackground short abstract. Methods and results.\n\nBody text with [1] citation.' }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    // 无 guideUrl 的刊 → 降级 + 人工核对项(不编造)
    expect(body.ok).toBe(false)
    expect(body.items.some((i: any) => i.ok === null)).toBe(true)
  })

  test('recommend-journals rejects empty title', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submission/recommend-journals',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '', abstract: '' }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('templates list and prefill work', async () => {
    const app = await getApp()
    const h = { ...(await authHeader()), 'content-type': 'application/json' }

    const list = await app.inject({
      method: 'GET', url: '/api/v1/submission/templates',
      headers: await authHeader(),
    })
    expect(list.statusCode).toBe(200)
    const templates = JSON.parse(list.payload).templates
    expect(templates.length).toBeGreaterThan(0)
    expect(templates[0].sections.length).toBeGreaterThan(0)

    const prefill = await app.inject({
      method: 'POST', url: '/api/v1/submission/templates/prefill',
      headers: h,
      payload: JSON.stringify({ template_id: templates[0].id, title: 'My Study', abstract: 'The abstract', authors: ['Dr A', 'Dr B'] }),
    })
    expect(prefill.statusCode).toBe(200)
    const body = JSON.parse(prefill.payload)
    expect(body.content).toContain('My Study')
    expect(body.content).toContain('Dr A')

    const missing = await app.inject({
      method: 'POST', url: '/api/v1/submission/templates/prefill',
      headers: h,
      payload: JSON.stringify({ template_id: 'nope', title: 'X' }),
    })
    expect(missing.statusCode).toBe(404)
  })

  test('draft save → read round trip', async () => {
    const app = await getApp()
    const h = { ...(await authHeader()), 'content-type': 'application/json' }

    const save = await app.inject({
      method: 'POST', url: '/api/v1/submission/drafts',
      headers: h,
      payload: JSON.stringify({
        article_title: 'My Retrospective Study',
        abstract: 'Methods and results here',
        authors: ['Dr A'],
        target_journal: 'JTO',
        cover_letter: 'Dear Editor, ...',
        template_id: 'jto-template',
      }),
    })
    expect(save.statusCode).toBe(200)
    const saved = JSON.parse(save.payload).draft
    expect(saved.article_title).toBe('My Retrospective Study')

    const list = await app.inject({
      method: 'GET', url: '/api/v1/submission/drafts',
      headers: await authHeader(),
    })
    const drafts = JSON.parse(list.payload).drafts
    expect(drafts.length).toBeGreaterThan(0)
    const latest = drafts[0]
    expect(latest.target_journal).toBe('JTO')
    expect(latest.authors).toContain('Dr A')

    // Updating keeps a single row (upsert semantics on latest draft).
    const update = await app.inject({
      method: 'POST', url: '/api/v1/submission/drafts',
      headers: h,
      payload: JSON.stringify({ article_title: 'My Retrospective Study v2' }),
    })
    expect(update.statusCode).toBe(200)
    const list2 = await app.inject({
      method: 'GET', url: '/api/v1/submission/drafts',
      headers: await authHeader(),
    })
    const drafts2 = JSON.parse(list2.payload).drafts
    expect(drafts2[0].article_title).toBe('My Retrospective Study v2')
    expect(drafts2.length).toBe(1)
  }, 30000)
})

  test('submission checklist + status tracking (#362 stage 2)', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    await app.inject({
      method: 'POST', url: '/api/v1/submission/drafts',
      headers: h,
      payload: JSON.stringify({
        article_title: 'EGFR-mutant NSCLC immunotherapy outcomes',
        abstract: 'A retrospective cohort of 87 patients with EGFR-mutant advanced non-small cell lung cancer treated with immune checkpoint inhibitors. Overall survival and progression-free survival were analyzed.',
        authors: ['Dr A', 'Dr B'],
        target_journal: 'Lung Cancer',
        cover_letter: 'Dear Editor, this manuscript has not been published previously. We declare no conflicts of interest. IRB approval was obtained.',
        template_id: 'lung-cancer-template',
      }),
    })

    const cl = await app.inject({ method: 'GET', url: '/api/v1/submission/checklist', headers: await authHeader() })
    expect(cl.statusCode).toBe(200)
    const checklist = JSON.parse(cl.payload)
    expect(checklist.total).toBe(9)
    expect(checklist.ready).toBe(true)
    expect(checklist.checks.find((c: any) => c.id === 'title').ok).toBe(true)
    expect(checklist.checks.find((c: any) => c.id === 'ethics').ok).toBe(true)

    const bad = await app.inject({ method: 'POST', url: '/api/v1/submission/status', headers: h, payload: JSON.stringify({ status: 'nope' }) })
    expect(bad.statusCode).toBe(400)

    const submitted = await app.inject({ method: 'POST', url: '/api/v1/submission/status', headers: h, payload: JSON.stringify({ status: 'submitted' }) })
    expect(submitted.statusCode).toBe(200)
    expect(JSON.parse(submitted.payload).draft.status).toBe('submitted')
  }, 30000)
