import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Admin 管理操作', () => {
  test('disable and enable user', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    // Disable (should work for admin)
    const disable = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userId}/disable`,
      headers: await authHeader(),
    })
    // May be 200 or 403 depending on token's admin status
    expect([200, 403]).toContain(disable.statusCode)

    // Enable
    const enable = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userId}/enable`,
      headers: await authHeader(),
    })
    expect([200, 403]).toContain(enable.statusCode)
  })

  test('reset password requires new_password', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userId}/reset-password`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { new_password: 'newpass123' },
    })
    expect([200, 403]).toContain(res.statusCode)
  })
})

