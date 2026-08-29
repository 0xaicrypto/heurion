/**
 * #765 — insert_asset (P1: table) 工具级测试。
 *
 * 覆盖：锚点命中插入 / 无锚点追加文末 / 锚点多次命中报错 /
 * 非 doc 会话拒绝 / markdown 转义与 caption / 快照与持久化。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { InsertAssetTool, buildMarkdownTable } from '../../src/tools/insert-asset-tool.js'
import fs from 'fs'
import path from 'path'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

async function createDoc(app: any, body: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { title: 'Insert Asset Test' },
  })
  const docId = JSON.parse(res.payload).id
  await app.inject({
    method: 'PUT', url: `/api/v1/docs/${docId}`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { body },
  })
  return docId
}

const TABLE_ARGS = {
  asset_type: 'table',
  headers: ['变量', '化疗组', 'ICI 组'],
  rows: [
    ['中位年龄', '62', '64'],
    ['女性占比', '48%', '52%'],
  ],
  caption: 'Table 1. Baseline characteristics',
}

describe('#765 buildMarkdownTable', () => {
  test('生成合法 markdown 表格，转义竖线，短行补空', () => {
    const md = buildMarkdownTable(['a', 'b'], [['x|y', '1'], ['only-a']])
    const lines = md.split('\n')
    expect(lines[0]).toBe('| a | b |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| x\\|y | 1 |')
    expect(lines[3]).toBe('| only-a |  |')
  })
})

describe('#765 insert_asset 工具', () => {
  test('锚点命中 → 表格插入锚点之后 + 快照 + 持久化', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '## 结果\n\n主要终点 PFS 见下文。\n\n## 讨论\n\n略。'
    const docId = await createDoc(app, body)

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ ...TABLE_ARGS, anchor: '主要终点 PFS 见下文。', summary: '插入基线表' })

    expect(result.success).toBe(true)
    const { body: newBody, summary } = JSON.parse(result.output as string)
    expect(summary).toContain('插入基线表')
    const anchorIdx = newBody.indexOf('主要终点 PFS 见下文。')
    const tableIdx = newBody.indexOf('| 变量 |')
    expect(anchorIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(anchorIdx)
    expect(newBody).toContain('**Table 1. Baseline characteristics**')
    expect(newBody).toContain('| 中位年龄 | 62 | 64 |')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe(newBody)
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { docId }, orderBy: { createdAt: 'desc' } })
    expect(snap.label).toBe('AI insert')
    expect(snap.body).toBe(body)
  }, 30000)

  test('无锚点 → 追加文末', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '## 引言\n\n正文。')

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ ...TABLE_ARGS, caption: '' })

    expect(result.success).toBe(true)
    const { body: newBody } = JSON.parse(result.output as string)
    expect(newBody.startsWith('## 引言')).toBe(true)
    expect(newBody.trimEnd().endsWith('| 女性占比 | 48% | 52% |')).toBe(true)
  }, 30000)

  test('锚点多次命中 → 报错引导，文档不变', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '重复段落。\n\n中间内容。\n\n重复段落。'
    const docId = await createDoc(app, body)

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ ...TABLE_ARGS, anchor: '重复段落。' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('多次')
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe(body)
  }, 30000)

  test('锚点未命中 → 追加文末并在 summary 注明', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '## 引言\n\n正文。')

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ ...TABLE_ARGS, anchor: '不存在的锚点文本' })

    expect(result.success).toBe(true)
    const { body: newBody, summary } = JSON.parse(result.output as string)
    expect(summary).toContain('锚点未命中')
    expect(newBody).toContain('| 变量 |')
  }, 30000)

  test('非 doc 会话被拒绝', async () => {
    const userId = await getAuthUserId()
    const tool = new InsertAssetTool({ userId, sessionId: 'global-x' })
    const result = await tool.execute(TABLE_ARGS)
    expect(result.success).toBe(false)
  }, 30000)

  test('headers/rows 缺失被拒绝', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}` })
    expect((await tool.execute({ asset_type: 'table', headers: [], rows: [['a']] })).success).toBe(false)
    expect((await tool.execute({ asset_type: 'table', headers: ['a'], rows: [] })).success).toBe(false)
    expect((await tool.execute({ asset_type: 'plot' })).success).toBe(false)
  }, 30000)
})

describe('#766 insert_asset plot 分支（fake execution plane）', () => {
  const PLOT_ARGS = {
    asset_type: 'plot',
    plot_type: 'line',
    title: 'PFS by PD-L1',
    x_label: 'Months',
    y_label: 'PFS rate',
    series: [{ label: 'PD-L1 ≥50%', y: [1, 0.8, 0.6, 0.5] }],
    caption: 'Figure 1. PFS by PD-L1 expression',
    anchor: '主要终点 PFS 见下文。',
  }

  function fakePlane(over: Record<string, any> = {}) {
    return {
      enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
      getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'plot.png' } })),
      fetchFile: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      ...over,
    }
  }

  test('happy path：渲 PNG 落盘 + chart-token URL 插入锚点后', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '## 结果\n\n主要终点 PFS 见下文。'
    const docId = await createDoc(app, body)
    const plane = fakePlane()

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
    const result = await tool.execute(PLOT_ARGS)

    expect(result.success).toBe(true)
    expect(plane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.render_plot' }))
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.content_type).toBe('sidecar.render_plot')
    // x 缺省合成 1..n
    expect(payload.data.series[0].x).toEqual([1, 2, 3, 4])
    expect(plane.fetchFile).toHaveBeenCalledWith('f1')

    const { body: newBody, file } = JSON.parse(result.output as string)
    expect(file.url).toMatch(/^\/api\/v1\/files\/download\/plot_[\w-]+_\d+\.png\?token=/)
    const anchorIdx = newBody.indexOf('主要终点 PFS 见下文。')
    const imgIdx = newBody.indexOf(`![Figure 1. PFS by PD-L1 expression](${file.url})`)
    expect(anchorIdx).toBeGreaterThan(-1)
    expect(imgIdx).toBeGreaterThan(anchorIdx)

    // 落盘文件真实存在
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    expect(fs.existsSync(path.join(dir, file.fileId))).toBe(true)
  }, 30000)

  test('plot 插件未安装 → 可读报错，不 enqueue', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const plane = fakePlane()
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => false })
    const result = await tool.execute(PLOT_ARGS)
    expect(result.success).toBe(false)
    expect(result.error).toContain('heurion/plot')
    expect(plane.enqueue).not.toHaveBeenCalled()
  }, 30000)

  test('execution plane 缺失 → 可读报错', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, isPluginInstalled: async () => true })
    const result = await tool.execute(PLOT_ARGS)
    expect(result.success).toBe(false)
    expect(result.error).toContain('执行平面')
  }, 30000)

  test('job 失败 → 报错含原因', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const plane = fakePlane({ getStatus: async () => ({ job_id: 'j1', status: 'failed', error: 'Unknown job type' }) })
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
    const result = await tool.execute(PLOT_ARGS)
    expect(result.success).toBe(false)
    expect(result.error).toContain('渲染失败')
    expect(result.error).toContain('Unknown job type')
  }, 30000)

  test('fetchFile 为空 → 可读报错', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const plane = fakePlane({ fetchFile: async () => null })
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
    const result = await tool.execute(PLOT_ARGS)
    expect(result.success).toBe(false)
    expect(result.error).toContain('fetchFile')
  }, 30000)

  test('x/y 长度不一致 / 缺 title / 空 series → 报错', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')
    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
    const bad1 = await tool.execute({ ...PLOT_ARGS, series: [{ label: 'a', x: [1, 2], y: [1, 2, 3] }] })
    expect(bad1.success).toBe(false)
    expect(bad1.error).toContain('长度不一致')
    const bad2 = await tool.execute({ ...PLOT_ARGS, title: '' })
    expect(bad2.success).toBe(false)
    const bad3 = await tool.execute({ ...PLOT_ARGS, series: [] })
    expect(bad3.success).toBe(false)
  }, 30000)
})
