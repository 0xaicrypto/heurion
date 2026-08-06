import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Session 管理', () => {
  test('session lifecycle: create → list → delete', async () => {
    const app = await getApp()
    // Create
    const create = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Test Session' },
    })
    expect(create.statusCode).toBe(200)
    const sid = JSON.parse(create.payload).id
    expect(sid).toBeTruthy()

    // List
    const list = await app.inject({
      method: 'GET', url: '/api/v1/sessions',
      headers: await authHeader(),
    })
    const sessions = JSON.parse(list.payload).sessions
    expect(sessions.some((s: any) => s.id === sid)).toBe(true)

    // Delete
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/sessions/${sid}`,
      headers: await authHeader(),
    })
    expect(del.statusCode).toBe(200)
  })
})

