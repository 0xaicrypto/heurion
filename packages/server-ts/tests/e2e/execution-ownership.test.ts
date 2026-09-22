import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId, registerSecondUser } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #中-13 — 内部执行面归属校验回归。此前 GET /execution/jobs/:id 与
 * /execution/files/:fileId/download 只查登录态：任何登录用户拿到 id 即可
 * 读他人作业状态/下载产物。现在按 execution_job_owners 校验（缺记录
 * fail-closed 404），且 tenant.userId 不接受请求体伪造。
 */
describe('execution plane ownership (#中-13)', () => {
  async function enqueue(types: Record<string, string>, payload: unknown = {}) {
    const app = await getApp()
    return app.inject({
      method: 'POST',
      url: '/api/v1/execution/jobs',
      headers: { ...types, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
  }

  test('job status: owner 200, 他人/未知 404', async () => {
    const app = await getApp()
    const a = { ...await authHeader(), 'content-type': 'application/json' }
    const b = await registerSecondUser()
    const bHeaders = { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }

    const created = await enqueue(a, { type: 'sidecar.render_plot', payload: { series: [] } })
    expect(created.statusCode).toBe(200)
    const jobId = JSON.parse(created.payload).job_id
    expect(jobId).toBeTruthy()

    const aGet = await app.inject({ method: 'GET', url: `/api/v1/execution/jobs/${jobId}`, headers: a })
    expect(aGet.statusCode).toBe(200)

    const bGet = await app.inject({ method: 'GET', url: `/api/v1/execution/jobs/${jobId}`, headers: bHeaders })
    expect(bGet.statusCode).toBe(404)

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/execution/jobs/job_nonexistent', headers: a })
    expect(unknown.statusCode).toBe(404)
  })

  test('tenant.userId 不能被请求体伪造 — 归属始终是认证用户', async () => {
    const app = await getApp()
    const a = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = await getAuthUserId()

    const created = await enqueue(a, { type: 'sidecar.render_plot', tenant: { userId: 'user_spoofed', workspaceId: 'ws1' } })
    expect(created.statusCode).toBe(200)
    const jobId = JSON.parse(created.payload).job_id

    const row = await prisma.executionJobOwner.findUnique({ where: { jobId } })
    expect(row?.userId).toBe(userId)
    expect(row?.userId).not.toBe('user_spoofed')
  })

  test('file download: 他人 fileId 404，未登记 fileId fail-closed 404', async () => {
    const app = await getApp()
    const a = { ...await authHeader(), 'content-type': 'application/json' }
    const b = await registerSecondUser()
    const bHeaders = { authorization: `Bearer ${b.token}` }
    const userId = await getAuthUserId()

    const fileId = `file_owner_test_${Date.now()}`
    const jobId = `job_owner_test_${Date.now()}`
    await prisma.executionJobOwner.create({
      data: { jobId, userId, fileId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    })

    // B 知道 fileId 也拿不到（不是自己的记录）。
    const bGet = await app.inject({
      method: 'GET', url: `/api/v1/execution/files/${fileId}/download`, headers: bHeaders,
    })
    expect(bGet.statusCode).toBe(404)

    // 未登记 fileId → fail-closed 404（A 也不行）。
    const aUnknown = await app.inject({
      method: 'GET', url: `/api/v1/execution/files/file_unregistered/download`, headers: a,
    })
    expect(aUnknown.statusCode).toBe(404)
  })
})
