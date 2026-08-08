import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #362: submission workflow — journal recommendation, templates, drafts.
 * Cover-letter generation requires a live LLM; the smoke path is guarded.
 */

describe('submission workflow (#362)', () => {
  beforeAll(async () => {
    await (prisma as any).submissionDraft.deleteMany({})
  })
  afterAll(async () => {
    await (prisma as any).submissionDraft.deleteMany({})
  })

  test('recommend-journals returns top journals for an NSCLC abstract', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submission/recommend-journals',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'EGFR-mutant non-small cell lung cancer treated with immune checkpoint inhibitors',
        abstract: 'Retrospective cohort of patients with EGFR mutation and NSCLC receiving immunotherapy; overall survival and progression-free survival analyzed.',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.journals.length).toBeGreaterThan(0)
    expect(body.journals.length).toBeLessThanOrEqual(5)
    const top = body.journals[0]
    expect(top.name).toBeTruthy()
    expect(top.impact_factor).toBeGreaterThan(0)
    expect(top.acceptance_rate).toBeGreaterThan(0)
    expect(top.review_weeks).toBeGreaterThan(0)
    expect(top.cas_zone).toBeTruthy()
    expect(top.reason).toBeTruthy()
    // lung-cancer-keyword journals should rank at or near the top
    const names = body.journals.map((j: any) => j.name)
    expect(names.join(' ').toLowerCase()).toMatch(/lung|thoracic/i)
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
