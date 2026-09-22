import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import prisma from '../../src/common/prisma.js'
import { analyzeWithGeminiVision } from '../../src/modules/patients/dicom-scanner.js'

/**
 * #1104 — dicom-scanner 三项修复的回归锁:
 *  1. 共享 prisma 单例(此前每次调用 new PrismaClient + $disconnect — 引擎泄漏)
 *  2. 每次 Gemini vision 调用(PHI 出境)落 AuditLog(action=phi.vision_analysis)
 *  3. 调用失败不再 `return ''` 静默吞错 — 返回显式标记,log.warn 带错误
 */

const USER = `dicomaudit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const FILE_ID = 'ct.dcm'
let tmpDir: string
const dicomSource = path.resolve(import.meta.dirname, '../../sample-chest-ct.dcm')

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-audit-'))
  process.env.TWIN_BASE_DIR = tmpDir
  const uploads = path.join(tmpDir, USER, 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  fs.copyFileSync(dicomSource, path.join(uploads, FILE_ID))
  // UserSetting 有 user 外键 — 先建最小 User 行(createdAt/updatedAt 必填)
  const now = new Date().toISOString()
  await prisma.user.create({
    data: { id: USER, displayName: USER, createdAt: now, updatedAt: now },
  })
  // gemini_api_key 走 DB 读取(dicom-scanner userSetting 原文比对)
  await prisma.userSetting.create({
    data: { userId: USER, key: 'gemini_api_key', value: 'test-gemini-key-0123456789', updatedAt: Math.floor(Date.now() / 1000) },
  })
})

afterAll(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.TWIN_BASE_DIR
  await prisma.userSetting.deleteMany({ where: { userId: USER } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { actor: USER, action: 'phi.vision_analysis' } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#1104 dicom-scanner PHI 审计 + 失败可见', () => {
  test('vision 调用成功 → 返回文本 + AuditLog outcome=ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '右肺上叶小结节,建议随访' }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    expect(result).toContain('右肺上叶小结节')

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
    expect(entry!.reason).toContain('gemini vision PHI outbound')
    expect(entry!.reason).toContain('outcome=ok')
  }, 30000)

  test('vision 调用失败 → 显式标记(非空串/非静默)+ log.warn + AuditLog 含错误类别', async () => {
    const warnSpy = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(warnSpy)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED gemini') }))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    // 不再是 '' — 调用方(quick-scan)按 ai_analysis 呈现,用户可见失败
    expect(result).not.toBe('')
    expect(result).toContain('影像分析失败')
    expect(result).toContain('ECONNREFUSED')
    expect(result).toContain('请重试或人工判读')

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
    expect(entry!.reason).toContain('outcome=error')
    expect(entry!.reason).toContain('Error')

    vi.restoreAllMocks()
  }, 30000)

  test('共享 prisma 单例:源码不再 per-call new PrismaClient(引擎泄漏回归锁)', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/modules/patients/dicom-scanner.ts'),
      'utf-8',
    )
    expect(src).not.toMatch(/new PrismaClient/)
    expect(src).toMatch(/from '\.\.\/\.\.\/common\/prisma\.js'/)
    // AuditLog 覆盖每次 vision 调用
    expect(src).toContain("'phi.vision_analysis'")
  })
})
