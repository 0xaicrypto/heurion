import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { signToken } from '../../src/common/jwt.js'

async function registerUser(app: any, prefix: string): Promise<{ token: string; userId: string }> {
  const username = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password: 'test123456', display_name: username }),
  })
  const body = JSON.parse(res.payload)
  expect(body.jwt_token).toBeTruthy()
  const payload = JSON.parse(Buffer.from(body.jwt_token.split('.')[1], 'base64').toString())
  return { token: body.jwt_token, userId: payload.userId }
}

// The shared test DB is populated by earlier test files, so the admin must be
// created directly rather than relying on "first registered user is admin".
async function createAdminToken(): Promise<string> {
  const now = new Date().toISOString()
  const admin = await (prisma as any).user.create({
    data: {
      id: `user_admin_${Date.now()}`,
      displayName: `Test Admin ${Math.random().toString(36).slice(2, 6)}`,
      role: 'admin',
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    },
  })
  return signToken({ userId: admin.id, role: 'admin', displayName: admin.displayName })
}

async function createPatient(app: any, initials = 'AP') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials, age: 40, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

async function createPendingEntry(app: any, hash: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/patients/${hash}/medical-records`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: {
      type: 'lab',
      title: 'Pending CBC',
      date: '2026-07-29T00:00:00.000Z',
      content: 'WBC 10.2',
      status: 'pending_review',
      createdBy: 'system',
    },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload)
}

describe('Approval & Audit', () => {
  test('creating pending_review entry creates an approval request', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    expect(list.statusCode).toBe(200)
    const requests = JSON.parse(list.payload).requests
    const req = requests.find((r: any) => r.targetId === entry.id)
    expect(req).toBeDefined()
    expect(req.targetType).toBe('MedicalRecordEntry')
    expect(req.status).toBe('pending')
  })

  test('confirming approval confirms the target and writes audit log', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)

    const updated = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${entry.id}`,
      headers: await authHeader(),
    })
    expect(JSON.parse(updated.payload).status).toBe('confirmed')

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?targetType=MedicalRecordEntry&targetId=${entry.id}`,
      headers: await authHeader(),
    })
    expect(audit.statusCode).toBe(200)
    const logs = JSON.parse(audit.payload).logs
    expect(logs.some((l: any) => l.action === 'approval.confirmed')).toBe(true)
  })

  test('rejecting approval with reason rejects the target and writes audit log', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/reject`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { reason: 'Incorrect patient' },
    })
    expect(reject.statusCode).toBe(200)

    const updated = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${entry.id}`,
      headers: await authHeader(),
    })
    const body = JSON.parse(updated.payload)
    expect(body.status).toBe('rejected')
    expect(body.rejectedReason).toBe('Incorrect patient')

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?targetType=MedicalRecordEntry&targetId=${entry.id}`,
      headers: await authHeader(),
    })
    const logs = JSON.parse(audit.payload).logs
    expect(logs.some((l: any) => l.action === 'approval.rejected')).toBe(true)
  })

  test('rejecting without a reason is allowed', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/reject`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {},
    })
    expect(reject.statusCode).toBe(200)
    expect(JSON.parse(reject.payload).status).toBe('rejected')
  })

  test('resolved approvals do not appear in pending list', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const listBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(listBefore.payload).requests.find((r: any) => r.targetId === entry.id)

    await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: await authHeader(),
    })

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    expect(JSON.parse(listAfter.payload).requests.some((r: any) => r.id === req.id)).toBe(false)
  })
})

describe('Approval permission isolation', () => {
  test('a non-admin user cannot see or act on another user\'s pending approval', async () => {
    const app = await getApp()

    // Owner (fresh user A) creates a patient + pending entry
    const owner = await registerUser(app, 'owner')
    const ownerHeaders = { authorization: `Bearer ${owner.token}` }
    const patient = await app.inject({
      method: 'POST',
      url: '/api/v1/dicom/patients/register-manual',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { initials: 'OA', age: 40, sex: 'M' },
    })
    const hash = JSON.parse(patient.payload).patient_hash
    const entry = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: {
        type: 'lab',
        title: 'Owner CBC',
        content: 'WBC 10.2',
        status: 'pending_review',
        createdBy: 'system',
      },
    })
    const entryId = JSON.parse(entry.payload).id

    // Non-admin stranger (user B)
    const stranger = await registerUser(app, 'stranger')
    const strangerHeaders = { authorization: `Bearer ${stranger.token}` }

    // B's pending list does not contain A's request
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: strangerHeaders,
    })
    const requests = JSON.parse(list.payload).requests
    expect(requests.some((r: any) => r.targetId === entryId)).toBe(false)

    // B cannot confirm A's approval
    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: ownerHeaders,
    })
    const ownerReq = JSON.parse(pending.payload).requests.find((r: any) => r.targetId === entryId)
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${ownerReq.id}/confirm`,
      headers: strangerHeaders,
    })
    expect(denied.statusCode).toBe(404)

    // B cannot reject A's approval either
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${ownerReq.id}/reject`,
      headers: { ...strangerHeaders, 'content-type': 'application/json' },
      payload: { reason: 'not mine' },
    })
    expect(rejected.statusCode).toBe(404)

    // B's audit query does not leak A's audit rows
    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: strangerHeaders,
    })
    const logs = JSON.parse(audit.payload).logs
    expect(logs.length).toBe(0)

    // A can still see their own approval as pending
    const stillPending = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: ownerHeaders,
    })
    expect(JSON.parse(stillPending.payload).requests.some((r: any) => r.id === ownerReq.id)).toBe(true)
  })

  test('admin inbox is self-scoped by default; cross-user read needs ?scope=all; writes stay owner-only (#794)', async () => {
    const app = await getApp()

    const owner = await registerUser(app, 'owner2')
    const ownerHeaders = { authorization: `Bearer ${owner.token}` }
    const patient = await app.inject({
      method: 'POST',
      url: '/api/v1/dicom/patients/register-manual',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { initials: 'OB', age: 35, sex: 'F' },
    })
    const hash = JSON.parse(patient.payload).patient_hash
    const entry = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: {
        type: 'lab',
        title: 'Owner CBC 2',
        content: 'WBC 11.2',
        status: 'pending_review',
        createdBy: 'system',
      },
    })
    const entryId = JSON.parse(entry.payload).id

    const adminToken = await createAdminToken()
    const adminHeaders = { authorization: `Bearer ${adminToken}` }

    // #794: admin default inbox does NOT contain other users' requests
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: adminHeaders,
    })
    expect(JSON.parse(list.payload).requests.some((r: any) => r.targetId === entryId)).toBe(false)

    // Explicit opt-in reveals it for supervision…
    const listAll = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending?scope=all',
      headers: adminHeaders,
    })
    const req = JSON.parse(listAll.payload).requests.find((r: any) => r.targetId === entryId)
    expect(req).toBeDefined()

    // …but writes remain owner-only: admin cannot confirm/reject it
    const deniedConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: adminHeaders,
    })
    expect(deniedConfirm.statusCode).toBe(404)

    const deniedReject = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/reject`,
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: { reason: 'supervision' },
    })
    expect(deniedReject.statusCode).toBe(404)

    // Non-admin passing ?scope=all gets nothing cross-user either
    const stranger = await registerUser(app, 'stranger2')
    const strangerAll = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending?scope=all',
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    expect(JSON.parse(strangerAll.payload).requests.some((r: any) => r.targetId === entryId)).toBe(false)

    // Owner still sees and can resolve their own request
    const ownerPending = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: ownerHeaders,
    })
    const ownerReq = JSON.parse(ownerPending.payload).requests.find((r: any) => r.targetId === entryId)
    expect(ownerReq).toBeDefined()
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${ownerReq.id}/confirm`,
      headers: ownerHeaders,
    })
    expect(confirmed.statusCode).toBe(200)

    const entryAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${entryId}`,
      headers: ownerHeaders,
    })
    expect(JSON.parse(entryAfter.payload).status).toBe('confirmed')
  })

  test('audit feed: actor filter cannot override self-scope; admin cross-user needs scope=all (#794)', async () => {
    const app = await getApp()
    const owner = await registerUser(app, 'auditowner')
    const ownerHeaders = { authorization: `Bearer ${owner.token}` }
    const patient = await app.inject({
      method: 'POST',
      url: '/api/v1/dicom/patients/register-manual',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { initials: 'OA2' },
    })
    const hash = JSON.parse(patient.payload).patient_hash
    const entry = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { type: 'lab', title: 'Audit CBC', content: 'WBC 9.9', status: 'pending_review', createdBy: 'system' },
    })
    const entryId = JSON.parse(entry.payload).id
    // Owner resolves their own request → audit row exists for owner
    const pending = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: ownerHeaders })
    const req = JSON.parse(pending.payload).requests.find((r: any) => r.targetId === entryId)
    await app.inject({ method: 'POST', url: `/api/v1/approvals/${req.id}/confirm`, headers: ownerHeaders })

    // Stranger tried the old ?actor= override hole → must stay empty
    const stranger = await registerUser(app, 'auditpeek')
    const peek = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?actor=${owner.userId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    expect(peek.statusCode).toBe(200)
    expect(JSON.parse(peek.payload).logs.some((l: any) => l.targetId === entryId)).toBe(false)

    // Owner sees their own row
    const own = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: ownerHeaders })
    expect(JSON.parse(own.payload).logs.some((l: any) => l.targetId === entryId)).toBe(true)

    // Admin default = own feed (nothing here); scope=all reveals it
    const adminToken = await createAdminToken()
    const adminDefault = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: { authorization: `Bearer ${adminToken}` } })
    expect(JSON.parse(adminDefault.payload).logs.some((l: any) => l.targetId === entryId)).toBe(false)

    const adminAll = await app.inject({ method: 'GET', url: '/api/v1/audit?scope=all', headers: { authorization: `Bearer ${adminToken}` } })
    expect(JSON.parse(adminAll.payload).logs.some((l: any) => l.targetId === entryId)).toBe(true)
  })
})

describe('13.4D pending auto-archival', () => {
  async function seedProposal(userId: string, kind: string, importance: number, daysAgo: number) {
    const now = new Date().toISOString()
    const created = new Date(Date.now() - daysAgo * 86400_000).toISOString()
    const row = await (prisma as any).memoryProposal.create({
      data: {
        userId, scopeType: 'global', kind, content: `proposal ${kind} ${importance}`, importance,
        confidence: 'medium', status: 'pending', createdAt: created,
      },
    })
    await (prisma as any).approvalRequest.create({
      data: {
        id: `apr_seed_${row.id}`,
        userId, targetType: 'MemoryProposal', targetId: row.id,
        status: 'pending', createdAt: now,
        payload: JSON.stringify({ id: row.id, kind, importance, content: `proposal ${kind} ${importance}`, createdAt: created, scopeType: 'global' }),
      },
    })
    return row.id
  }

  test('low-importance fact older than 7 days auto-archives and leaves the pending list', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const id = await seedProposal(userId, 'fact', 2, 8)

    const list = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: await authHeader() })
    const { requests } = JSON.parse(list.payload)
    expect(requests.some((r: any) => r.targetId === id)).toBe(false)

    const row = await (prisma as any).memoryProposal.findFirst({ where: { id } })
    expect(row.archivedAt).toBeTruthy()
  }, 30000)

  test('high-importance fact older than 7 days stays pending (pinned)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const id = await seedProposal(userId, 'fact', 5, 8)

    const list = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: await authHeader() })
    const { requests } = JSON.parse(list.payload)
    expect(requests.some((r: any) => r.targetId === id)).toBe(true)

    const row = await (prisma as any).memoryProposal.findFirst({ where: { id } })
    expect(row.archivedAt).toBeNull()
  }, 30000)

  test('episode_summary older than 7 days auto-archives', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const id = await seedProposal(userId, 'episode_summary', 3, 8)

    const list = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: await authHeader() })
    const { requests } = JSON.parse(list.payload)
    expect(requests.some((r: any) => r.targetId === id)).toBe(false)

    const row = await (prisma as any).memoryProposal.findFirst({ where: { id } })
    expect(row.archivedAt).toBeTruthy()
  }, 30000)

  test('fresh proposal is never archived', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const id = await seedProposal(userId, 'fact', 2, 1)

    const list = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: await authHeader() })
    const { requests } = JSON.parse(list.payload)
    expect(requests.some((r: any) => r.targetId === id)).toBe(true)
  }, 30000)
})

describe('episode_summary approval', () => {
  test('confirming an episode_summary succeeds without a graph write', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const now = new Date().toISOString()
    const row = await (prisma as any).memoryProposal.create({
      data: {
        userId, scopeType: 'global', kind: 'episode_summary',
        content: '会话摘要内容（已确认）', importance: 3,
        confidence: 'medium', status: 'pending', createdAt: now,
      },
    })
    await (prisma as any).approvalRequest.create({
      data: {
        id: `apr_sum_${row.id}`, userId, targetType: 'MemoryProposal', targetId: row.id,
        status: 'pending', createdAt: now,
        payload: JSON.stringify({ id: row.id, kind: 'episode_summary', importance: 3, content: '会话摘要内容（已确认）', createdAt: now, scopeType: 'global' }),
      },
    })

    const confirm = await app.inject({
      method: 'POST', url: `/api/v1/approvals/apr_sum_${row.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)
    expect(JSON.parse(confirm.payload).status).toBe('approved')

    const after = await (prisma as any).memoryProposal.findFirst({ where: { id: row.id } })
    expect(after.status).toBe('approved')
  }, 30000)
})
