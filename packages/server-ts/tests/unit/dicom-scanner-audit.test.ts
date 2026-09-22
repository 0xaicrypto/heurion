import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import prisma from '../../src/common/prisma.js'
import { analyzeWithGeminiVision } from '../../src/modules/patients/dicom-scanner.js'

/**
 * #1104 — dicom-scanner 三项修复的回归锁:
 *  1. 共享 prisma 单例(此前每次调用 new PrismaClient + $disconnect — 引擎泄漏)
 *  2. 每次 Gemini vision 调用(PHI 出境)落 AuditLog(action=phi.vision_analysis),
 *     outcome 全集: ok / api_key_missing / http_<status> / empty_response / error:<class>
 *  3. 失败不再 resolve 中文 marker 字符串 / return '' — 统一返回
 *     { ok:false, error } 结构化结果;调用方按 ok=false 走失败分支,失败文本
 *     绝不落入患者临床记录。
 */

const USER = `dicomaudit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const USER2 = `dicomaudit2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const FILE_ID = 'ct.dcm'
const FILE_ID2 = 'ct2.dcm'
let tmpDir: string
const dicomSource = path.resolve(import.meta.dirname, '../../sample-chest-ct.dcm')

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-audit-'))
  process.env.TWIN_BASE_DIR = tmpDir
  const now = new Date().toISOString()
  for (const [user, file] of [[USER, FILE_ID], [USER2, FILE_ID2]] as const) {
    const uploads = path.join(tmpDir, user, 'uploads')
    fs.mkdirSync(uploads, { recursive: true })
    fs.copyFileSync(dicomSource, path.join(uploads, file))
  }
  // UserSetting 有 user 外键 — 先建最小 User 行(createdAt/updatedAt 必填)
  await prisma.user.createMany({
    data: [
      { id: USER, displayName: USER, createdAt: now, updatedAt: now },
      { id: USER2, displayName: USER2, createdAt: now, updatedAt: now },
    ],
  })
  // gemini_api_key 走 DB 读取(dicom-scanner userSetting 原文比对)
  // USER2 故意不配 key — api_key_missing 路径回归锁用
  await prisma.userSetting.create({
    data: { userId: USER, key: 'gemini_api_key', value: 'test-gemini-key-0123456789', updatedAt: Math.floor(Date.now() / 1000) },
  })
})

afterAll(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.TWIN_BASE_DIR
  await prisma.userSetting.deleteMany({ where: { userId: USER } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { actor: USER, action: 'phi.vision_analysis' } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { actor: USER2, action: 'phi.vision_analysis' } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [USER, USER2] } } }).catch(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#1104 dicom-scanner PHI 审计 + 失败显式化(结构化结果)', () => {
  test('vision 调用成功 → { ok:true, text } + AuditLog outcome=ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '右肺上叶小结节,建议随访' }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain('右肺上叶小结节')

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID, reason: { contains: 'outcome=ok' } },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
    expect(entry!.reason).toContain('gemini vision PHI outbound')
  }, 30000)

  test('HTTP 500 → { ok:false, error 含 HTTP } + AuditLog outcome=http_500(不再 return 空串)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'internal error' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('HTTP')
      expect(result.error).toContain('500')
    }

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID, reason: { contains: 'outcome=http_500' } },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
  }, 30000)

  test('HTTP 200 空响应(candidates 为空)→ { ok:false } + AuditLog outcome=empty_response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ candidates: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('empty_response')

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID, reason: { contains: 'outcome=empty_response' } },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
  }, 30000)

  test('fetch 网络异常 → { ok:false, error 含原因 } + AuditLog outcome=error:<class>', async () => {
    const warnSpy = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(warnSpy)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED gemini') }))

    const result = await analyzeWithGeminiVision(USER, FILE_ID)
    // 不再是 resolve 中文 marker 串 — 调用方按 ok:false 走失败分支,不写临床记录
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('ECONNREFUSED')
      expect(result.error).not.toContain('影像分析失败')
    }

    const entry = await prisma.auditLog.findFirst({
      where: { actor: USER, action: 'phi.vision_analysis', targetId: FILE_ID, reason: { contains: 'outcome=error:' } },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry).toBeTruthy()
    expect(entry!.reason).toContain('error=')
    expect(entry!.reason).toContain('ECONNREFUSED')
    expect(entry!.reason).toContain('Error')

    vi.restoreAllMocks()
  }, 30000)

  test('未配置 API key → { ok:false } + AuditLog outcome=api_key_missing(分析没跑 ≠ 无发现)', async () => {
    const savedKey = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      const result = await analyzeWithGeminiVision(USER2, FILE_ID2)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('API key')
      expect((result as { text?: string }).text).toBeUndefined()

      const entry = await prisma.auditLog.findFirst({
        where: { actor: USER2, action: 'phi.vision_analysis', targetId: FILE_ID2, reason: { contains: 'outcome=api_key_missing' } },
        orderBy: { createdAt: 'desc' },
      })
      expect(entry).toBeTruthy()
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey
    }
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
    // 失败路径不再 resolve marker 字符串 / return ''
    expect(src).not.toContain('影像分析失败')
  })
})
