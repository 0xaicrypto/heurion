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
