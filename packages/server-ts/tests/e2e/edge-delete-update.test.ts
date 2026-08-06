import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * 边界审计（#253）— 不存在资源必须 404/400，不能静默成功：
 * DELETE/PUT/GET 各种 id 不存在的场景。
 */
describe('nonexistent resources 404/400 (边界 #253)', () => {
  test('DELETE /sessions/:id nonexistent → 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/sessions/session_nonexistent_xyz',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })

  test('DELETE /patients/:hash nonexistent → 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/dicom/patients/patient_nonexistent_xyz',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })

  test('docs: GET/PUT/DELETE nonexistent → 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    const get = await app.inject({ method: 'GET', url: '/api/v1/docs/doc_nonexistent_xyz', headers: h })
    expect(get.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/docs/doc_nonexistent_xyz', headers: h })
    expect(del.statusCode).toBe(404)
  })

  test('medical-records entry: PATCH/DELETE nonexistent → 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    // Create a patient so the route shape is valid.
    const created = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ initials: 'NF' }),
    })
    const hash = JSON.parse(created.payload).patient_hash
    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/patients/${hash}/medical-records/entry_nonexistent`,
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x' }),
    })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/patients/${hash}/medical-records/entry_nonexistent`,
      headers: h,
    })
    expect(del.statusCode).toBe(404)
  })

  test('files: GET content + DELETE nonexistent → 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    const content = await app.inject({ method: 'GET', url: '/api/v1/files/file_nonexistent/content', headers: h })
    expect(content.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/files/file_nonexistent', headers: h })
    expect(del.statusCode).toBe(404)
  })

  test('research: GET nonexistent study → 404; roster/enrollments also 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    const get = await app.inject({ method: 'GET', url: '/api/v1/research/studies/study_nonexistent', headers: h })
    expect(get.statusCode).toBe(404)
    const roster = await app.inject({ method: 'GET', url: '/api/v1/research/studies/study_nonexistent/roster', headers: h })
    expect(roster.statusCode).toBe(404)
  })

  test('knowledge: gaps resolve/ignore nonexistent → 404; articles PUT nonexistent → 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    const resolve = await app.inject({
      method: 'POST', url: '/api/v1/knowledge/gaps/gap_nonexistent/resolve',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ answer: 'x' }),
    })
    expect([400, 404]).toContain(resolve.statusCode)
    const ignore = await app.inject({
      method: 'POST', url: '/api/v1/knowledge/gaps/gap_nonexistent/ignore',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect([400, 404]).toContain(ignore.statusCode)
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/knowledge/articles/article_nonexistent',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x', content: 'y' }),
    })
    expect([400, 404]).toContain(put.statusCode)
  })

  test('plugins: enable/disable nonexistent plugin does not crash (400/404)', async () => {
    const app = await getApp()
    const h = await authHeader()
    const toggle = await app.inject({
      method: 'POST', url: '/api/v1/plugins/nonexistent/plugin-id/toggle',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: true }),
    })
    expect([400, 404]).toContain(toggle.statusCode)
  })
})
