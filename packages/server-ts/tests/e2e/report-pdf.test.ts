import { describe, test, expect } from 'vitest'
import { getApp, authHeader, registerSecondUser } from '../setup.js'

/**
 * #中-10 — 报告 PDF 持久化回归：
 * - GET 未生成过 → 404（绝不再伪造空 findings 的「零发现」报告）；
 * - POST 生成 → GET 回放同一份 PDF（%PDF magic + application/pdf）；
 * - 跨用户 → 404（userId+hash 键天然 owner-scoped）。
 */
describe('report PDF persistence (#中-10)', () => {
  test('GET before POST → 404（不再现场伪造报告）', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/report/pdf/hash_never_generated',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })

  test('POST generates + persists; GET replays the same PDF', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const hash = `hash_report_${Date.now()}`

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/report/pdf',
      headers: h,
      payload: JSON.stringify({
        patient_hash: hash,
        clinical_info: '间歇性头痛三周，无神经系统阳性体征。',
        impression: '紧张型头痛可能',
        recommendation: '随访观察',
      }),
    })
    expect(post.statusCode).toBe(200)
    const meta = JSON.parse(post.payload)
    expect(meta.patient_hash).toBe(hash)
    expect(meta.bytes).toBeGreaterThan(100)

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/report/pdf/${hash}`,
      headers: await authHeader(),
    })
    expect(get.statusCode).toBe(200)
    expect(get.headers['content-type']).toContain('application/pdf')
    expect(get.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  test('cross-user: B cannot download A\'s report', async () => {
    const app = await getApp()
    const a = { ...await authHeader(), 'content-type': 'application/json' }
    const b = await registerSecondUser()
    const hash = `hash_report_iso_${Date.now()}`

    const post = await app.inject({
      method: 'POST', url: '/api/v1/report/pdf', headers: a,
      payload: JSON.stringify({ patient_hash: hash, impression: 'A 的报告' }),
    })
    expect(post.statusCode).toBe(200)

    const bGet = await app.inject({
      method: 'GET', url: `/api/v1/report/pdf/${hash}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bGet.statusCode).toBe(404)
  })
})
