import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Agent State 详细信息', () => {
  test('state returns all required fields', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/state',
      headers: await authHeader(),
    })
    const body = JSON.parse(res.payload)
    expect(body.user_id).toBeTruthy()
    expect(body.memory_count).toBeGreaterThanOrEqual(0)
    expect(body.episode_count).toBeGreaterThanOrEqual(0)
    expect(body.skill_count).toBeGreaterThanOrEqual(0)
    expect(body.server_time).toBeTruthy()
  })
})

