import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Memory import with data', () => {
  test('import facts updates count', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/import',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {
        facts: [
          { category: 'preference', importance: 4, content: 'Prefers minimal sedation' },
          { category: 'fact', importance: 5, content: 'EGFR wild-type' },
        ],
        episodes: [{ sessionId: 'test', summary: 'Test session', turnCount: 1 }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.imported).toBeGreaterThan(0)
  })
})

