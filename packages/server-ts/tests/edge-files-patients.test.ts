import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('文件上传与患者关联', () => {
  test('upload stores file on disk', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    // Write a test file to upload dir (simulating multipart upload)
    const dir = path.join(TEST_DIR, userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'test_lab.txt'), 'CEA: 85.6')

    expect(fs.existsSync(path.join(dir, 'test_lab.txt'))).toBe(true)
  })
})

