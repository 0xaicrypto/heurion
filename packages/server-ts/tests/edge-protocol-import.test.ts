import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('Research 协议导入与规则确认', () => {
  test('import protocol returns correct structure', async () => {
    const app = await getApp()
    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Protocol Test', short_code: 'PT001' },
    })
    const studyId = JSON.parse(study.payload).study_id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${studyId}/import-protocol`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { text: 'INCLUSION: Stage IIIB/IV NSCLC' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.imported).toBe(true)
    expect(body.content_length).toBeGreaterThan(0)
  })

  test('protocol rules listing returns array', async () => {
    const app = await getApp()
    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Rules Test', short_code: 'RT001' },
    })
    const studyId = JSON.parse(study.payload).study_id

    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}/protocol-rules`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.rules).toBeDefined()
    expect(body.status).toBeDefined()
  })
})

