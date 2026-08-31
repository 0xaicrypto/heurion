import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import zlib from 'zlib'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

afterAll(async () => {
  // #777: 路由层的后台 pptx 解析任务（deck 落点）在测试结束后仍在收尾 —
  // 立即退出会与 prisma 引擎的 napi 句柄释放竞争（teardown panic → exit 134）。
  await new Promise((r) => setTimeout(r, 1500))
})

// ── 最小 pptx fixture（stored zip，与 unit/pptx-extractor.test.ts 同法）──
function crc32(buf: Buffer): number { return zlib.crc32(buf) }

function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    const nameBuf = Buffer.from(name, 'utf-8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(crc32(dataBuf), 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt32LE(crc32(dataBuf), 16)
    cen.writeUInt32LE(dataBuf.length, 20)
    cen.writeUInt32LE(dataBuf.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const cdStart = offset
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

const SLIDE_SHELL = (inner: string) => `<p:sld>${inner}</p:sld>`
const TITLE = (t: string) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`
const BODY = (p: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${p}</a:t></a:r></a:p></p:txBody></p:sp>`

function buildPptx(): Buffer {
  return buildZip([
    // nonce — 避免 sha256 去重命中前一次上传的文件（fileId/name 漂移）。
    { name: 'nonce.txt', data: `${Date.now()}-${Math.random()}` },
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/presentation.xml', data: '<p:presentation><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:presentation>' },
    { name: 'ppt/_rels/presentation.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>' },
    { name: 'ppt/slides/slide1.xml', data: SLIDE_SHELL(`${TITLE('研究背景')}${BODY('EGFR 突变 NSCLC')}`) },
    { name: 'ppt/slides/slide2.xml', data: SLIDE_SHELL(`${TITLE('结论')}${BODY('获益人群需筛选')}`) },
  ])
}

async function uploadFile(app: any, filename: string, bytes: Buffer): Promise<{ file_id: string; dedup?: boolean }> {
  const boundary = `----pptx${Date.now()}`
  const form = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/files/upload',
    headers: { ...await authHeader(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: form,
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload)
}

describe('#777 pptx 上传 → deck/文章双落点', () => {
  test('上传 pptx 挂为参考 → 后台解析写 Doc.deck；import_reference 导入 markdown', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    // 建空文档 + 上传 pptx。
    const docRes = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'PPT Import Test' },
    })
    const docId = JSON.parse(docRes.payload).id
    const up = await uploadFile(app, 'deck.pptx', buildPptx())

    // 挂为参考 — 响应不等待解析，返回 started。
    const ref = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'file', content: 'deck.pptx', label: 'deck.pptx' }),
    })
    expect(ref.statusCode).toBe(200)
    const refBody = JSON.parse(ref.payload)
    expect(refBody.pptx_parse).toEqual({ started: true })

    // 后台解析轮询（≤10s）— deck 出现且正文导入 markdown。
    const deadline = Date.now() + 10000
    let deck: any = null
    let body = ''
    while (Date.now() < deadline) {
      const doc = await app.inject({
        method: 'GET', url: `/api/v1/docs/${docId}`,
        headers: await authHeader(),
      })
      const d = JSON.parse(doc.payload)
      deck = d.deck
      body = d.body
      if (deck && body) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(deck).toBeTruthy()
    expect(deck.slides.map((s: any) => s.title)).toEqual(['研究背景', '结论'])
    expect(deck.slides[0].content[0]).toMatchObject({ text: 'EGFR 突变 NSCLC', style: 'bullet' })
    // 文章落点：## 分节 markdown（来自同一解析）。
    expect(body).toContain('## 研究背景')
    expect(body).toContain('获益人群需筛选')

    // 快照可追溯（'AI deck'）— 走 API 而非直连 prisma（避免引擎句柄
    // 与后台任务竞争导致的 teardown panic）。
    const snapsRes = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })
    const snaps = JSON.parse(snapsRes.payload).snapshots as Array<{ label?: string }>
    expect(snaps.some((s) => s.label === 'AI deck')).toBe(true)
  }, 30000)

  test('edit_document import_reference 可把 pptx 导入成文章（markdown 落点回归）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docRes = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'PPT Markdown Import' },
    })
    const docId = JSON.parse(docRes.payload).id
    await uploadFile(app, 'paper.pptx', buildPptx())
    await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'file', content: 'paper.pptx', label: 'paper.pptx' }),
    })

    const { EditDocumentTool } = await import('../../src/tools/edit-document-tool.js')
    const result = await new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
      .execute({ import_reference: 'paper.pptx' })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toContain('## 研究背景')
    expect(parsed.body).toContain('## 结论')
  }, 30000)
})
