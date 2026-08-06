import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId, registerSecondUser } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * 边界审计（#253）— HTTP 级跨用户越权矩阵：
 * A 用户创建资源后，B 用户访问/修改/删除必须被拒绝（404 或 403），
 * 且列表不得包含他人资源。
 */
describe('ownership isolation (边界 #253)', () => {
  test('sessions: user B cannot see/close/delete user A sessions', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    const created = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'A 的会话', scope: 'global' }),
    })
    const sid = JSON.parse(created.payload).id

    // B lists sessions → A's session absent
    const bList = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: { authorization: `Bearer ${b.token}` } })
    const bIds = JSON.parse(bList.payload).sessions.map((s: any) => s.id)
    expect(bIds).not.toContain(sid)

    // B closes A's session → not found (userId scoped)
    const bClose = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sid}/close`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect([404, 403]).toContain(bClose.statusCode)

    // B deletes A's session → must not succeed
    const bDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/sessions/${sid}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bDelete.statusCode).not.toBe(200)

    // A's session still exists
    const row = await prisma.session.findFirst({ where: { id: sid } })
    expect(row).not.toBeNull()
    await prisma.session.deleteMany({ where: { id: sid } })
  })

  test('patients: user B cannot read/delete user A patients', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    const created = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ initials: 'OA' }),
    })
    const hash = JSON.parse(created.payload).patient_hash

    const bDetail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect([404, 403]).toContain(bDetail.statusCode)

    const bDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/dicom/patients/${hash}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bDelete.statusCode).not.toBe(200)

    // B's full list does not contain A's patient
    const bFull = await app.inject({ method: 'GET', url: '/api/v1/dicom/patients/full', headers: { authorization: `Bearer ${b.token}` } })
    const patients = JSON.parse(bFull.payload)
    expect(Array.isArray(patients)).toBe(true)
    const hashes = patients.map((p: any) => p.patient_hash)
    expect(hashes).not.toContain(hash)
  })

  test('docs: user B cannot read/update/delete user A documents', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    const created = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'A 的文档' }),
    })
    const docId = JSON.parse(created.payload).id

    const bGet = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect([404, 403]).toContain(bGet.statusCode)

    const bDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/docs/${docId}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(bDelete.statusCode).not.toBe(200)

    const row = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(row).not.toBeNull()
    await (prisma as any).doc.deleteMany({ where: { id: docId } })
  })

  test('medical-records: user B cannot read user A records', async () => {
    const app = await getApp()
    const a = await authHeader()
    const b = await registerSecondUser()

    const created = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ initials: 'OA2' }),
    })
    const hash = JSON.parse(created.payload).patient_hash

    const rec = await app.inject({
      method: 'POST', url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...a, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'chief_complaint', title: 'A 病历', date: '2026-08-06', content: '敏感内容' }),
    })
    const recId = JSON.parse(rec.payload).id

    const bGet = await app.inject({
      method: 'GET', url: `/api/v1/patients/${hash}/medical-records/${recId}`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect([404, 403]).toContain(bGet.statusCode)
  })
})
