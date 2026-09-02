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
// #789②: 纯构建器下沉 lib/asset-content。
import { InsertAssetTool } from '../../src/tools/insert-asset-tool.js'
import { buildMarkdownTable, buildDocumentContent, buildPresentationContent } from '../../src/lib/asset-content.js'
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

describe('#767 buildDocumentContent / buildPresentationContent', () => {
  const md = '# EGFR 研究\n\n引言正文。\n\n## 结果\n\nPFS 5.2 个月。\n\n- 要点一\n- 要点二\n\n## 讨论\n\n略。'

  test('docx：`#` → title，`##` → section，`-` → bullet，首个正文行归「概述」', () => {
    const doc = buildDocumentContent(md, 'fallback')
    expect(doc.title).toBe('EGFR 研究')
    expect(doc.sections[0]).toMatchObject({ heading: '概述', paragraphs: [{ type: 'paragraph', text: '引言正文。' }] })
    expect(doc.sections[1].heading).toBe('结果')
    expect(doc.sections[1].paragraphs).toContainEqual({ type: 'paragraph', text: '要点一', style: 'bullet' })
    expect(doc.sections[2].heading).toBe('讨论')
  })

  test('pptx：sections → slides', () => {
    const ppt = buildPresentationContent(md, 'fallback')
    expect(ppt.title).toBe('EGFR 研究')
    expect(ppt.slides.map((s) => s.title)).toEqual(['概述', '结果', '讨论'])
    expect(ppt.slides[1].content[0].text).toBe('PFS 5.2 个月。')
  })
})

describe('#767 insert_asset export 分支（fake execution plane）', () => {
  const BODY = '# EGFR 研究\n\n## 结果\n\n中位 PFS 5.2 个月。\n\n- PD-L1 ≥50% 获益\n- HR 0.48'

  function fakePlane(over: Record<string, any> = {}) {
    return {
      enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
      getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'out.docx' } })),
      fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake')),
      ...over,
    }
  }

  test('docx happy path：草稿→sections、渲染、落盘、卡片写回 + file 元数据', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, BODY)
    const plane = fakePlane()

    const tool = new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
    const result = await tool.execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(true)
    expect(plane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.generate_docx' }))
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.template_id).toBe('case_summary')
    expect(payload.data.title).toBe('EGFR 研究')
    expect(payload.data.sections.map((s: any) => s.heading)).toContain('结果')

    const { body: newBody, summary, file } = JSON.parse(result.output as string)
    expect(summary).toContain('已导出 Word')
    expect(file.fileName).toMatch(/^EGFR_研究\.docx$/)
    expect(file.url).toMatch(/^\/api\/v1\/files\/download\/export_[\w-]+_\d+\.docx\?token=/)
    expect(newBody.trimEnd().endsWith(`[下载 Word 版（${file.fileName}）](${file.url})`)).toBe(true)

    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    expect(fs.existsSync(path.join(dir, file.fileId))).toBe(true)
  }, 30000)

  test('pptx / pdf 使用对应契约 job type', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, BODY)
    const pptPlane = fakePlane()
    await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: pptPlane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx' })
    expect(pptPlane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.generate_pptx' }))
    const pdfPlane = fakePlane()
    await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: pdfPlane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pdf' })
    expect(pdfPlane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.convert_to_pdf' }))
  }, 30000)

  test('插件未安装 / 正文为空 / format 缺失 → 可读报错，不写卡片', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, BODY)
    const plane = fakePlane()

    const noPlugin = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => false })
      .execute({ asset_type: 'export', format: 'docx' })
    expect(noPlugin.success).toBe(false)
    expect(noPlugin.error).toContain('heurion/docx')

    const emptyDoc = await createDoc(app, '')
    const empty = await new InsertAssetTool({ userId, sessionId: `doc-${emptyDoc}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })
    expect(empty.success).toBe(false)
    expect(empty.error).toContain('正文为空')

    const badFormat = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export' })
    expect(badFormat.success).toBe(false)
    expect(badFormat.error).toContain('format')
    expect(plane.enqueue).not.toHaveBeenCalled()
  }, 30000)
})

describe('#774 export 空正文自动导入唯一参考材料', () => {
  const BODY = '# EGFR 研究\n\n## 结果\n\n中位 PFS 5.2 个月。'

  function fakePlane(over: Record<string, any> = {}) {
    return {
      enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
      getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'out.docx' } })),
      fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake')),
      ...over,
    }
  }

  async function addReference(app: any, docId: string, label: string, content: string) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'note', content, label }),
    })
  }

  test('正文为空 + 唯一参考材料 → 自动导入后继续导出，summary 注明', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')
    await addReference(app, docId, '论文.pdf', '# 论文标题\n\n## 摘要\n\n这是摘要内容。\n\n## 方法\n\n这是方法内容。')

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(true)
    const { body: newBody, summary } = JSON.parse(result.output as string)
    // summary 注明自动导入。
    expect(summary).toContain('已自动导入参考材料「论文.pdf」')
    // 导出内容来自导入后的正文。
    expect(newBody).toContain('[下载 Word 版')
    // 正文持久化为导入内容（后续导出不再依赖参考材料）。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('## 摘要')
    expect(doc.body).toContain('这是方法内容。')
    // 导入快照 + 导出卡片快照。
    const snaps = await (prisma as any).docSnapshot.findMany({ where: { docId }, orderBy: { id: 'asc' } })
    expect(snaps.map((s: any) => s.label)).toEqual(['AI import', 'AI insert'])
  }, 30000)

  test('正文为空 + 多个参考材料 → 报错列出 label，引导先 import_reference', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')
    await addReference(app, docId, 'a.txt', '材料 A 内容。')
    await addReference(app, docId, 'b.txt', '材料 B 内容。')

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('多个参考材料')
    expect(result.error).toContain('a.txt')
    expect(result.error).toContain('b.txt')
    expect(result.error).toContain('import_reference')
  }, 30000)

  test('正文为空 + 无参考材料 → 维持现报错', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('正文为空')
    expect(result.error).toContain('先撰写内容')
  }, 30000)

  test('正文非空时不受影响（回归）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, BODY)
    await addReference(app, docId, 'unused.txt', '不会被导入。')

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(true)
    const { summary } = JSON.parse(result.output as string)
    expect(summary).not.toContain('自动导入')
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).not.toContain('不会被导入')
  }, 30000)
})

describe('#772 insert_asset organize 编排导出（slides JSON 直供）', () => {
  function fakePlane(over: Record<string, any> = {}) {
    return {
      enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
      getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'out.pptx' } })),
      fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake-pptx')),
      ...over,
    }
  }

  const SLIDES = [
    { title: '研究背景', bullets: ['EGFR 突变 NSCLC 一线治疗', 'ICI 联合化疗成为标准'] },
    { title: '关键结果', bullets: ['中位 PFS 5.2 个月', 'HR 0.48 (95% CI 0.35-0.65)'] },
    { title: '结论', bullets: ['获益人群需生物标志物筛选'] },
  ]

  test('organize=true + slides 直供（空正文凭空）→ 契约 payload + 卡片 + knowledge 大纲', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')
    const plane = fakePlane()

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true, title: 'EGFR 研究汇报', subtitle: '2026 年度进展', slides: SLIDES })

    expect(result.success).toBe(true)
    expect(plane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.generate_pptx' }))
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.data.title).toBe('EGFR 研究汇报')
    expect(payload.data.subtitle).toBe('2026 年度进展')
    expect(payload.data.slides.map((s: any) => s.title)).toEqual(['研究背景', '关键结果', '结论'])
    expect(payload.data.slides[0].content[0]).toEqual({ type: 'paragraph', text: 'EGFR 突变 NSCLC 一线治疗', style: 'bullet' })

    const { body: newBody, summary, file, knowledge } = JSON.parse(result.output as string)
    expect(summary).toContain('已编排生成 PPT（3 页）')
    expect(newBody).toContain('[下载 PPT 版')
    expect(file.mimeType).toContain('presentationml.presentation')
    // knowledge = deck 大纲（草稿正文为空时是唯一的内容源）。
    expect(knowledge.title).toBe('EGFR 研究汇报')
    expect(knowledge.content).toContain('## 研究背景')
    expect(knowledge.content).toContain('中位 PFS 5.2 个月')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('[下载 PPT 版')
    // #773: 编排产物同帧落 Doc.deck + 'AI deck' 快照（画布可编辑、再导出源）。
    expect(JSON.parse(doc.deck).title).toBe('EGFR 研究汇报')
    expect(JSON.parse(doc.deck).slides.map((s: any) => s.title)).toEqual(['研究背景', '关键结果', '结论'])
    const deckSnap = await (prisma as any).docSnapshot.findFirst({ where: { docId }, orderBy: { id: 'desc' } })
    expect(deckSnap.label).toBe('AI deck')
  }, 30000)

  test('organize=true + 无 slides + 正文非空 → 返回正文摘要引导第二次调用', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '# 论文\n\n## 背景\n\n这是背景第一句。第二句。\n\n## 方法\n\n方法首句。')
    const plane = fakePlane()

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true })

    expect(result.success).toBe(false)
    expect(result.error).toContain('slides')
    expect(result.error).toContain('## 背景')
    expect(result.error).toContain('这是背景第一句')
    expect(plane.enqueue).not.toHaveBeenCalled()
  }, 30000)

  test('organize=true + 无 slides + 空正文 + 唯一参考 → 自动导入并返回摘要（两段协议第一段）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')
    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'note', content: '# 论文标题\n\n## 摘要\n\n摘要第一句。', label: '论文.pdf' }),
    })

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true })

    expect(result.success).toBe(false)
    expect(result.error).toContain('已自动导入参考材料「论文.pdf」')
    expect(result.error).toContain('## 摘要')
    // 导入已持久化 — 第二次调用（带 slides）不需要再导入。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('摘要第一句')
  }, 30000)

  test('bullets 中托管图片 markdown → 内嵌 base64 image block（#769 反向复用）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')
    // 造一张托管图（plot 命名习惯：<TWIN>/<user>/uploads/plot_x.png）。
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plot_km.png'), Buffer.from('fake-png-bytes'))

    const plane = fakePlane()
    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({
        asset_type: 'export', format: 'pptx', organize: true, title: 'Deck',
        slides: [
          { title: '生存曲线', bullets: ['图示如下', '![图 1](/api/v1/files/download/plot_km.png?token=x)', '结论要点'] },
        ],
      })

    expect(result.success).toBe(true)
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    const blocks = payload.data.slides[0].content
    expect(blocks[0]).toEqual({ type: 'paragraph', text: '图示如下', style: 'bullet' })
    expect(blocks[1].type).toBe('image')
    expect(Buffer.from(blocks[1].data, 'base64').toString()).toBe('fake-png-bytes')
    expect(blocks[1].caption).toBe('图 1')
    expect(blocks[2]).toEqual({ type: 'paragraph', text: '结论要点', style: 'bullet' })

    const { summary } = JSON.parse(result.output as string)
    expect(summary).not.toContain('未能嵌入')
  }, 30000)

  test('organize=true + 非 pptx 格式 / 图片文件缺失 → 可读报错', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正文')

    const notPptx = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: fakePlane(), isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx', organize: true, slides: [{ title: 'x', bullets: ['y'] }] })
    expect(notPptx.success).toBe(false)
    expect(notPptx.error).toContain('organize 仅支持')

    const plane = fakePlane()
    const missingImg = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({
        asset_type: 'export', format: 'pptx', organize: true, title: 'Deck',
        slides: [{ title: '页', bullets: ['![图](/api/v1/files/download/missing.png?token=x)'] }],
      })
    expect(missingImg.success).toBe(true)
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    // 图片缺失 → 跳过并注记（页面仍有占位段，不产生半截文件）。
    expect(payload.data.slides[0].content.some((b: any) => b.type === 'image')).toBe(false)
    const { summary } = JSON.parse(missingImg.output as string)
    expect(summary).toContain('1 张图片未能嵌入')
  }, 30000)

  test('#773 deck 已存在时 organize=true 无 slides → 以 Doc.deck 为内容源直出（不再重新编排）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '# 论文\n\n正文内容，不是 slides。')
    // 模拟 deck 视图手动编辑后的 Doc.deck（覆盖正文语义 — deck 是导出源）。
    const deck = {
      schemaVersion: 1,
      title: '编辑后的 Deck',
      slides: [{ title: '手动改过的页', content: [{ type: 'paragraph', text: 'deck 内容', style: 'bullet' }] }],
    }
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { deck },
    })

    const plane = fakePlane()
    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true })

    expect(result.success).toBe(true)
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.data.title).toBe('编辑后的 Deck')
    expect(payload.data.slides[0].title).toBe('手动改过的页')
    // 不进入 digest 两段协议（正文非空也不返回摘要引导）。
    expect(result.output).toBeTruthy()
  }, 30000)
})

describe('#769 导出时草稿内嵌图片转 image block', () => {
  function fakePlane(over: Record<string, any> = {}) {
    return {
      enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
      getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'out.bin' } })),
      fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake')),
      ...over,
    }
  }

  test('docx/pdf 导出：图片行 → 内嵌 base64 image block；文件缺失保留文本段', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plot_km.png'), Buffer.from('km-png-bytes'))

    const docId = await createDoc(app, '# 研究\n\n## 结果\n\n![图 1](/api/v1/files/download/plot_km.png?token=x)\n\n![缺图](/api/v1/files/download/none.png?token=x)\n\n正文。')
    const plane = fakePlane()
    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'docx' })

    expect(result.success).toBe(true)
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    const paras = payload.data.sections.find((s: any) => s.heading === '结果').paragraphs
    expect(paras[0].type).toBe('image')
    expect(Buffer.from(paras[0].data, 'base64').toString()).toBe('km-png-bytes')
    expect(paras[0].caption).toBe('图 1')
    // 缺图文件 → 保留原段落文本（不丢内容、不产生半截文件）。
    expect(paras[1].type).toBe('paragraph')
    expect(paras[1].text).toContain('none.png')
  }, 30000)

  test('pptx 导出：slides 内容同样携带 image block', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plot_pfs.png'), Buffer.from('pfs-png-bytes'))

    const docId = await createDoc(app, '# 研究\n\n## 结果\n\n![图 2](/api/v1/files/download/plot_pfs.png?token=x)')
    const plane = fakePlane()
    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx' })

    expect(result.success).toBe(true)
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.data.slides[0].content[0].type).toBe('image')
    expect(Buffer.from(payload.data.slides[0].content[0].data, 'base64').toString()).toBe('pfs-png-bytes')
  }, 30000)
})
