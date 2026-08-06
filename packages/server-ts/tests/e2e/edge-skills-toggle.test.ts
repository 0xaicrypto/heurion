import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Skills 启停', () => {
  test('install → toggle off → toggle on', async () => {
    const app = await getApp()
    // Install
    await app.inject({
      method: 'POST', url: '/api/v1/skills/install',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { identifier: 'official/safety-monitor' },
    })

    // Toggle off
    const off = await app.inject({
      method: 'POST', url: '/api/v1/skills/Safety%20Monitor/toggle',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { enabled: false },
    })
    expect(off.statusCode).toBe(200)
    expect(JSON.parse(off.payload).enabled).toBe(false)

    // Verify in list
    const list = await app.inject({
      method: 'GET', url: '/api/v1/skills',
      headers: await authHeader(),
    })
    const skill = JSON.parse(list.payload).skills.find((s: any) => s.name === 'Safety Monitor')
    expect(skill).toBeTruthy()
    expect(skill.enabled).toBe(false)

    // Toggle on
    const on = await app.inject({
      method: 'POST', url: '/api/v1/skills/Safety%20Monitor/toggle',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { enabled: true },
    })
    expect(JSON.parse(on.payload).enabled).toBe(true)
  })
})

