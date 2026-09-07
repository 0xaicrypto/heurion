import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'
import { setUrlDownloadLookupForTest } from '../../src/lib/url-download.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

async function createDoc(app: any, body = '') {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { title: 'URL Import Test' },
  })
  const docId = JSON.parse(res.payload).id
  if (body) {
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body },
    })
  }
  return docId
}

/** 极小可解析 PDF(pdfkit 风格手写 — 提取器只依赖文本层)。 */
function makeTinyPdf(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 14 Tf 72 720 Td (${text}) Tj ET`)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

describe('#875 edit_document url 导入(检索→全文入库闭环)', () => {
  beforeEach(() => {
    // 受控下载与 OA 校验都走 fetch — 统一 mock;DNS 无外网 → 注入公网 IP
    vi.stubGlobal('fetch', vi.fn())
    setUrlDownloadLookupForTest(async () => [{ address: '93.184.216.34' }])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setUrlDownloadLookupForTest(null)
  })

  test('OA PDF 直链 → 入库(FileIndex+docReference)+ 正文导入', async () => {
    const app = await getApp()
    const docId = await createDoc(app)
    const pdf = makeTinyPdf('EGFR mutation and NSCLC treatment review content')
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockImplementation(async (input: any) => new Response(pdf, { status: 200 }))

    const tool = new EditDocumentTool({ userId: await getAuthUserId(), sessionId: `doc-${docId}` })
    const result = await tool.execute({
      url: 'https://oa.example.org/papers/egfr-review-v1.pdf',
      doi: '10.1000/fake-doi',
      summary: '导入 OA 全文',
    })
    expect(result.success).toBe(true)
    const out = JSON.parse(result.output as string)
    expect(out.body).toContain('EGFR mutation')

    // FileIndex + docReference 落库
    const fileRow = await (prisma as any).fileIndex.findFirst({ where: { name: 'egfr-review-v1.pdf' } })
    expect(fileRow).toBeTruthy()
    expect(fileRow.mime).toBe('application/pdf')
    const refRow = await (prisma as any).docReference.findFirst({ where: { docId, refType: 'pdf', snapshot: 'egfr-review-v1.pdf' } })
    expect(refRow).toBeTruthy()
  }, 30000)

  test('非 OA(付费墙 402) → 诚实报错且不落库', async () => {
    const app = await getApp()
    const docId = await createDoc(app)
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockImplementation(async () => new Response('payment required', { status: 402 }))

    const tool = new EditDocumentTool({ userId: 'user_test', sessionId: `doc-${docId}` })
    const result = await tool.execute({ url: 'https://paywalled.example.org/paper.pdf', summary: '尝试导入付费墙' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('付费墙')
    const refRow = await (prisma as any).docReference.findFirst({ where: { docId, refType: 'pdf' } })
    expect(refRow).toBeNull()
  }, 30000)

  test('非 PDF 内容 → not_pdf 拒绝', async () => {
    const app = await getApp()
    const docId = await createDoc(app)
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockImplementation(async () => new Response('<html>landing</html>', { status: 200 }))

    const tool = new EditDocumentTool({ userId: 'user_test', sessionId: `doc-${docId}` })
    const result = await tool.execute({ url: 'https://oa.example.org/landing-page' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('PDF')
  }, 30000)
})
