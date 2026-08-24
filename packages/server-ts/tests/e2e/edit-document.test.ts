import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'
import fs from 'fs'
import path from 'path'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

async function createDoc(app: any, body = '旧内容') {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { title: 'Edit Test' },
  })
  const docId = JSON.parse(res.payload).id
  // the create endpoint stores an empty body — set it via PUT
  await app.inject({
    method: 'PUT', url: `/api/v1/docs/${docId}`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { body },
  })
  return docId
}

describe('#171 edit_document tool', () => {
  test('#1 write-back persists body + creates a snapshot', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '第一版')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ full_text: '# 第二版\n\n更新内容', summary: '重写' })

    expect(result.success).toBe(true)
    const body = JSON.parse(result.output as string).body
    expect(body).toContain('# 第二版')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('# 第二版')
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { docId }, orderBy: { createdAt: 'desc' } })
    expect(snap.label).toBe('AI edit')
    expect(snap.body).toBe('第一版')
  }, 30000)

  test('non-doc session is rejected', async () => {
    const userId = await getAuthUserId()
    const tool = new EditDocumentTool({ userId, sessionId: 'global-x' })
    const result = await tool.execute({ full_text: 'x' })
    expect(result.success).toBe(false)
  }, 30000)

  test('#2 LLM tool loop: chat call edit_document → doc updated + doc_updated SSE', async () => {
    const app = await getApp()
    const docId = await createDoc(app, '原文')
    const sessionId = `doc-${docId}`

    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      if (calls === 1) {
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'edit_document', arguments: { full_text: '新文档内容', summary: '重写' } })}</tool_call>`)
      }
      return Promise.resolve('文档已更新。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '把文档重写一下', session_id: sessionId }),
    })
    expect(res.statusCode).toBe(200)

    // Document persisted
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(doc.body).toBe('新文档内容')

    // doc_updated SSE surfaced to the canvas
    expect(res.payload).toContain('"type":"doc_updated"')
    expect(res.payload).toContain('新文档内容')
  }, 30000)

  test('#fix 分步润色:range 模式 old_text/new_text 局部替换,其余内容不动', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '摘要部分。\n\n研究方法部分内容。\n\n结论部分。'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({
      old_text: '研究方法部分内容。',
      new_text: '改进后的研究方法部分内容。',
      summary: '润色方法部分',
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toBe('摘要部分。\n\n改进后的研究方法部分内容。\n\n结论部分。')
    expect(parsed.summary).toBe('润色方法部分')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe('摘要部分。\n\n改进后的研究方法部分内容。\n\n结论部分。')
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { docId }, orderBy: { createdAt: 'desc' } })
    expect(snap.body).toBe(body)
  }, 30000)

  test('#fix range 模式:old_text 未找到 → 报错并给文档开头片段帮助修正锚点', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '摘要部分。\n\n正文部分。')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '不存在的句子', new_text: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
    expect(result.error).toContain('摘要部分')

    // 文档未被改动
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe('摘要部分。\n\n正文部分。')
  }, 30000)

  test('#fix range 模式:old_text 多处匹配 → 报错要求唯一锚点', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '重复句。\n\n重复句。')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '重复句。', new_text: '改后句。' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('多次')
  }, 30000)

  test('#fix range 模式:old_text 与 new_text 相同 → 报错不产生空快照', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '内容。')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '内容。', new_text: '内容。' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('没有任何变化')
  }, 30000)

  test('#fix 正文为空时 range 编辑报错并指引改用 full_text(上传 PDF 后文档空白的场景)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '论文摘要内容', new_text: '润色后的摘要' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('文档正文为空')
    expect(result.error).toContain('import_reference')
  }, 30000)

  test('#fix import 模式:把上传的参考材料正文导入空文档(分步润色前置步骤)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    // 上传一个 txt 文件 + 挂为文档参考材料(模拟用户上传论文后"帮我润色")。
    const boundary = `----imptest${Date.now()}`
    const uploadForm = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('# 论文标题\n\n## 摘要\n\n这是摘要内容。\n\n## 方法\n\n这是方法内容。', 'utf-8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: uploadForm,
    })
    expect(upload.statusCode).toBe(200)
    const fileId = JSON.parse(upload.payload).file_id

    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'file', content: 'paper.txt', label: 'paper.txt' }),
    })

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ import_reference: 'paper.txt', summary: '导入论文' })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toContain('# 论文标题')
    expect(parsed.body).toContain('## 摘要')
    expect(parsed.body).toContain('这是方法内容。')
    expect(parsed.summary).toContain('paper.txt')

    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('## 方法')
  }, 30000)

  test('#fix import 模式:label 不存在时列出可用参考材料', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'note', content: '指南摘要文本', label: 'ESMO 指南' }),
    })

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ import_reference: '不存在的材料' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到参考材料')
    expect(result.error).toContain('ESMO 指南')
  }, 30000)

  test('#fix 导入图片托管:带内嵌图的 DOCX 导入后,图片落盘并在正文渲染为 markdown 图片', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    // 生成带内嵌 PNG 的 DOCX 并上传。
    const { Document, Packer, Paragraph, ImageRun } = await import('docx')
    const zlib = await import('zlib')
    const makePng = (w: number, h: number): Buffer => {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const chunk = (type: string, data: Buffer): Buffer => {
        const t = Buffer.from(type, 'ascii')
        const len = Buffer.alloc(4)
        len.writeUInt32BE(data.length)
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0)
        return Buffer.concat([len, t, data, crc])
      }
      const ihdr = Buffer.alloc(13)
      ihdr.writeUInt32BE(w, 0)
      ihdr.writeUInt32BE(h, 4)
      ihdr[8] = 8
      ihdr[9] = 2
      const scanlines = Buffer.alloc((w * 3 + 1) * h)
      for (let y = 0; y < h; y++) {
        scanlines[y * (w * 3 + 1)] = 0
        for (let x = 0; x < w; x++) {
          const off = y * (w * 3 + 1) + 1 + x * 3
          scanlines[off] = 200
          scanlines[off + 1] = 30
          scanlines[off + 2] = 60
        }
      }
      return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
    }
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: 'results section' }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: makePng(50, 50), transformation: { width: 50, height: 50 } })] }),
          new Paragraph({ text: 'text after image' }),
        ],
      }],
    })
    const docxBuf = await Packer.toBuffer(doc)

    const boundary = `----imgimport${Date.now()}`
    const uploadForm = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fig.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`),
      docxBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: uploadForm,
    })
    expect(upload.statusCode).toBe(200)
    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'file', content: 'fig.docx', label: 'fig.docx' }),
    })

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ import_reference: 'fig.docx' })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    // 正文保留文本 + 图片渲染为托管 markdown。
    expect(parsed.body).toContain('results section')
    expect(parsed.body).toContain('text after image')
    expect(parsed.body).not.toContain('data:image')
    const imgMatch = parsed.body.match(/!\[图 1\]\(\/api\/v1\/files\/download\/(img_[^?]+\.png)\?token=([^)]+)\)/)
    expect(imgMatch).toBeTruthy()
    // 图片文件已落盘,且带 token 的下载接口可渲染(无鉴权头)。
    const imgFileId = imgMatch![1]
    expect(fs.existsSync(path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', imgFileId))).toBe(true)
    const imgRes = await app.inject({
      method: 'GET',
      url: `/api/v1/files/download/${imgFileId}?token=${imgMatch![2]}`,
    })
    expect(imgRes.statusCode).toBe(200)
    expect(imgRes.headers['content-type']).toBe('image/png')
  }, 60000)
})
