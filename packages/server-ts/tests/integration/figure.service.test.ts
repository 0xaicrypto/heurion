import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'

/**
 * #820 — figure.service 缓存与落盘编排。
 * 执行面 plane 以 vi.mock 注入(enqueue 立即完成 + fetchFile 回 SVG 字节);
 * prisma 走集成库(db push 含 figure_renders 表)。
 */

const mockState = vi.hoisted(() => ({ enqueues: [] as string[] }))

vi.mock('../../src/modules/execution/execution-plane.service.js', () => {
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"></svg>')
  let call = 0
  return {
    createExecutionPlaneService: () => ({
      enqueue: vi.fn(async (job: any) => {
        call += 1
        mockState.enqueues.push(`job_${call}`)
        return { job_id: `job_${call}`, status: 'pending' }
      }),
      getStatus: vi.fn(async (jobId: string) => ({
        job_id: jobId, status: 'completed',
        result: { file_id: `wf_${jobId}`, file_name: 'figure.svg', mime_type: 'image/svg+xml', width: 320, height: 240 },
      })),
      fetchFile: vi.fn(async () => svg),
    }),
  }
})

import { ensureFigure, figureSha256 } from '../../src/modules/figures/figure.service.js'

const INPUT = { kind: 'mermaid' as const, source: 'graph TD; A-->B;' }

describe('#820 ensureFigure', () => {
  beforeEach(async () => {
    const prisma = (await import('../../src/common/prisma.js')).default
    // FigureRender/FileIndex 有 user 外键 — 造真实用户行
    const now = new Date().toISOString()
    await prisma.user.upsert({
      where: { id: 'user_fig' },
      create: { id: 'user_fig', displayName: 'fig-test-user', createdAt: now, updatedAt: now },
      update: {},
    })
    await prisma.figureRender.deleteMany({ where: { userId: 'user_fig' } })
  })

  test('首次渲染:落盘 fig_ 前缀 + FileIndex + FigureRender 记录,cached=false', async () => {
    const result = await ensureFigure('user_fig', INPUT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.cached).toBe(false)
    expect(result.file.fileId).toMatch(/^fig_mermaid_[0-9a-f]{8}_\d+\.svg$/)
    expect(result.file.width).toBe(320)

    const prisma = (await import('../../src/common/prisma.js')).default
    const row = await prisma.figureRender.findFirst({ where: { userId: 'user_fig' } })
    expect(row).toBeTruthy()
    expect(row.svgFileId).toBe(result.file.fileId)
    expect(row.source).toBe(INPUT.source)
    const idx = await prisma.fileIndex.findUnique({ where: { id: result.file.fileId } })
    expect(idx?.mime).toBe('image/svg+xml')
  }, 30000)

  test('同源码二次请求 → 缓存命中 cached=true,不落新文件', async () => {
    const first = await ensureFigure('user_fig', INPUT)
    const second = await ensureFigure('user_fig', INPUT)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.file.cached).toBe(true)
      expect(second.file.fileId).toBe(first.file.fileId)
    }
  }, 30000)

  test('同源码不同 options → 新 sha256 新产物(force 重渲染同理,旧产物保留)', async () => {
    const a = await ensureFigure('user_fig', INPUT)
    const b = await ensureFigure('user_fig', { ...INPUT, theme: 'dark' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(figureSha256(INPUT)).not.toBe(figureSha256({ ...INPUT, theme: 'dark' }))
      expect(b.file.fileId).not.toBe(a.file.fileId)
    }
    const forced = await ensureFigure('user_fig', INPUT, { force: true })
    expect(forced.ok && forced.file.cached === false).toBe(true)
  }, 30000)

  test('#928 并发同 (userId, sha256) → in-flight 合并,只 enqueue 一次、同一产物', async () => {
    mockState.enqueues.length = 0
    const [a, b] = await Promise.all([ensureFigure('user_fig', INPUT), ensureFigure('user_fig', INPUT)])
    expect(a.ok && b.ok).toBe(true)
    // 修复前:两个并发请求各自走完整 miss 路径 → 双 enqueue + 双落盘。
    expect(mockState.enqueues).toHaveLength(1)
    if (a.ok && b.ok) {
      expect(b.file.fileId).toBe(a.file.fileId)
      expect(b.file.cached).toBe(false)
    }
  }, 30000)
})
