import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Calendar 订阅 URL', () => {
  test('subscribe-url returns HTTPS URL', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/calendar/subscribe-url',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.url).toContain('https://')
    expect(body.url).toContain('calendar/export.ics?token=')
    expect(body.instructions).toBeTruthy()
  })
})

