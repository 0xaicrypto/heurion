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

  test('#fix 长文档 full_text 全量重写被拒绝(防输出截断/连接超时)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const longBody = ('这是一段很长的文档内容，用来撑大 token 数量，确保超过全量重写的保护阈值。'.repeat(100))
    const docId = await createDoc(app, longBody)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ full_text: '重写后的内容', summary: '重写' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('full_text')
    expect(result.error).toContain('old_text/new_text')

    // 文档未被破坏。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe(longBody)
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

  test('#fix range 模式:old_text 未找到 → 报错并给文档开头完整句片段帮助修正锚点', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '摘要部分。\n\n正文部分。')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '不存在的句子', new_text: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
    expect(result.error).toContain('摘要部分。')

    // 文档未被改动
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toBe('摘要部分。\n\n正文部分。')
  }, 30000)

  test('#fix probe 取完整标题行:复制报错里的片段重试必然命中', async () => {    const app = await getApp()
    const userId = await getAuthUserId()
    // 150+ 字符的长标题(超过旧 probe 的 120 字符窗口,硬切会断在单词中间)。
    const title = 'Impact of two years of treatment with Elexacaftor/Tezacaftor/Ivacaftor on longitudinal changes in structural lung disease in people with Cystic Fibrosis. 这是第二句。'
    const docId = await createDoc(app, `${title}\n\n## Abstract\n\n正文。`)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '不存在的句子', new_text: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
    // probe = 第一个非空行完整内容(标题整行),不截在单词中间。
    expect(result.error).toContain('structural lung disease in people with Cystic Fibrosis. 这是第二句。')
    // 文案引导:不从「文档结构」清单复制(带序号)。
    expect(result.error).toContain('不要从「文档结构」清单复制')

    // 模拟模型按报错提示复制 probe 重试 → 必然命中。
    const probe = (result.error.match(/"(.*)"$/) || [])[1] || ''
    expect(probe.length).toBeGreaterThan(50)
    const retry = await tool.execute({ old_text: probe, new_text: '新标题。' })
    expect(retry.success).toBe(true)
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('新标题。')
    expect(doc.body).not.toContain(title)
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

  test('#fix range 模式:old_text 换行/空格与正文不同(LLM 从参考材料复制)→ 归一化匹配成功且不留残留', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    // 模拟 PDF 导入后的正文:标题被 PDF 文本层拆成多行。
    const body = 'Impact of two years of treatment\nwith Elexacaftor/Tezacaftor/\nIvacaftor on longitudinal changes.\n\n## Abstract\nThis is the abstract.'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    // LLM 的 old_text 把换行折叠成空格(或从参考材料块复制)。
    const result = await tool.execute({
      old_text: 'Impact of two years of treatment with Elexacaftor/Tezacaftor/Ivacaftor on longitudinal changes.',
      new_text: 'Impact of two years of triple-combination therapy on structural lung disease.',
      summary: '润色标题',
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toBe('Impact of two years of triple-combination therapy on structural lung disease.\n\n## Abstract\nThis is the abstract.')
  }, 30000)

  test('#fix range 模式:old_text 含软连字符/连续空格 → 归一化匹配成功', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '## Results\nstructural lung diseas\u00ade was  reduced  by  40%.'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({
      old_text: 'structural lung disease was reduced by 40%.',
      new_text: 'structural lung disease fell by 40%.',
      summary: '润色结果句',
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toBe('## Results\nstructural lung disease fell by 40%.')
  }, 30000)

  test('#fix range 模式:归一化后多处匹配 → 报错要求唯一锚点', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '第一句重复。\n\n第二行 重复。'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '重复。', new_text: '改后。' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('多次')
  }, 30000)

  test('#fix range 模式:字符不一致(非空白差异)仍报"未找到"', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '正确原文。')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '错误原文。', new_text: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
  }, 30000)

  test('#fix range 模式:old_text 省略 ## 标题标记(LLM 从参考材料复制时去掉标记)仍能匹配', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const body = '## Abstract\n\n## Rationale\n\nProgressive structural lung disease is a key hallmark.\n\n## Objectives\n\nWe sought to establish improvements.'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({
      old_text: 'Abstract Rationale Progressive structural lung disease is a key hallmark. Objectives We sought to establish improvements.',
      new_text: '**Abstract**\n\n**Rationale** Progressive structural lung disease is a key hallmark. **Objectives** We sought to establish improvements.',
      summary: '润色摘要',
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toContain('**Abstract**')
    expect(parsed.body).toContain('**Objectives**')
  }, 30000)

  test('#fix range 模式:old_text 含少量字符差异(模型脑补修正拼写)→ 模糊匹配成功', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    // 模拟 PDF 提取出的 "BwtAand"(应为 "Bwt/A and"),模型复制时脑补修正。
    const body = 'Automated analysis showed a significant reduction in BwtAand Bwa/Boa at 12 months which were sustained to 24 months.'
    const docId = await createDoc(app, body)

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({
      old_text: 'Automated analysis showed a significant reduction in Bwt/A and Bwa/Boa at 12 months which were sustained to 24 months.',
      new_text: 'Automated analysis showed a significant reduction in Bwt/A and Bwa/Boa at 12 months, sustained to 24 months.',
      summary: '润色结果句',
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toContain('sustained to 24 months.')
    expect(parsed.body).not.toContain('BwtAand')
  }, 30000)

  test('#fix range 模式:old_text 忽略大小写差异', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, 'Elexacaftor/Tezacaftor/Ivacaftor')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: 'elexacaftor/tezacaftor/ivacaftor', new_text: 'ETI', summary: '缩写' })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toBe('ETI')
  }, 30000)

  test('#fix 正文为空且无参考材料时 range 编辑报错并指引先上传/full_text', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '论文摘要内容', new_text: '润色后的摘要' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('文档正文为空')
    expect(result.error).toContain('full_text')
  }, 30000)

  test('#fix 正文为空 + 唯一参考材料:range 编辑自动导入后再局部替换(用户上传 PDF 后直接说"润色"的场景)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    const boundary = `----autoiptest${Date.now()}`
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
    const result = await tool.execute({ old_text: '这是摘要内容。', new_text: '这是润色后的摘要。', summary: '润色摘要' })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.body).toContain('# 论文标题')
    expect(parsed.body).toContain('这是润色后的摘要。')
    expect(parsed.body).toContain('这是方法内容。')

    // 导入快照 + 编辑快照各一个。
    const snaps = await (prisma as any).docSnapshot.findMany({ where: { docId }, orderBy: { id: 'asc' } })
    expect(snaps.length).toBe(2)
    expect(snaps[0].label).toBe('AI import')
    expect(snaps[1].label).toBe('AI edit')
  }, 30000)

  test('#fix 正文为空 + 多个参考材料:range 编辑报错要求先 import_reference 明确导入', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = await createDoc(app, '')

    for (const [name, content] of [['a.txt', '材料 A 内容。'], ['b.txt', '材料 B 内容。']] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/docs/${docId}/references`,
        headers: { ...await authHeader(), 'content-type': 'application/json' },
        payload: JSON.stringify({ kind: 'note', content, label: name }),
      })
    }

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    const result = await tool.execute({ old_text: '材料 A 内容。', new_text: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('多个参考材料')
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

  test('#693 选中即引用:selection 注入上下文,模型 old_text 逐字命中 → doc_updated 闭环', async () => {
    const app = await getApp()
    const body = '# 摘要\n\n原始摘要内容一句话。\n\n# 方法\n\n研究方法内容。'
    const docId = await createDoc(app, body)
    const sessionId = `doc-${docId}`

    let contextSeen = ''
    let toolCallDone = false
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (!toolCallDone) {
        contextSeen = text
        toolCallDone = true
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'edit_document', arguments: { old_text: '原始摘要内容一句话。', new_text: '改进后的摘要内容一句话。', summary: '润色摘要' } })}</tool_call>`)
      }
      return Promise.resolve('已完成摘要段润色。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '润色这段', session_id: sessionId, selection: '原始摘要内容一句话。' }),
    })
    expect(res.statusCode).toBe(200)

    // 选中文本注入为独立上下文块(模型据此逐字复制 old_text)。
    expect(contextSeen).toContain('## 用户选中文本')
    expect(contextSeen).toContain('原始摘要内容一句话。')
    // 规则提示从选中文本复制。
    expect(contextSeen).toContain('必须从该选中文本逐字复制')

    // old_text 逐字命中 → body 更新 + doc_updated SSE 推送。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(doc.body).toContain('改进后的摘要内容一句话。')
    expect(doc.body).toContain('研究方法内容。')
    expect(res.payload).toContain('"type":"doc_updated"')
  }, 30000)

  test('#693 长文档:selection 优先定位焦点段,注入包含选中文本的完整段', async () => {
    const app = await getApp()
    // 默认 DOC_BODY_TOKENS=20000(约 30000 中文字符),构造超预算文档触发分段注入。
    // 每句带序号保证全文唯一(重复句会触发 edit_document 的"出现多次"检查)。
    const makeSection = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) => `${prefix}第${i + 1}句：这是详细内容，用于撑大 token 数量，确保文档超出上下文预算而走分段注入路径。该句包含足够的文字使得段落总长超过两万 token 的阈值，从而触发长文档的分段注入与焦点定位逻辑。`).join('\n')
    const longA = makeSection('第一段')
    const longB = makeSection('第二段')
    const body = `# 第一段\n\n${longA}\n\n# 第二段\n\n${longB}`
    const docId = await createDoc(app, body)
    const sessionId = `doc-${docId}`

    let contextSeen = ''
    let toolCallDone = false
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (!toolCallDone) {
        contextSeen = text
        toolCallDone = true
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'edit_document', arguments: { old_text: '第二段第100句：这是详细内容，用于撑大 token 数量', new_text: '第二段第100句：这是润色后的独特内容', summary: '润色第二段' } })}</tool_call>`)
      }
      return Promise.resolve('已完成第二段润色。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '润色这段', session_id: sessionId, selection: '第二段第100句：这是详细内容，用于撑大 token 数量' }),
    })
    expect(res.statusCode).toBe(200)

    // 走长文档分段注入路径,焦点段定位到包含选中文本的段(第 2 段)。
    expect(contextSeen).toContain('## 文档结构（共 2 段')
    expect(contextSeen).toContain('## 当前编辑段落（第 2/2 段')
    expect(contextSeen).toContain('## 用户选中文本')
    // JSON 序列化会转义换行 — 用无换行的单句断言。
    expect(contextSeen).toContain(longB.split('\n')[0])
    expect(contextSeen).toContain(longB.split('\n')[1])
    // 未选中部分(第一段)不注入。
    expect(contextSeen).not.toContain(longA.slice(0, 50))

    // 编辑命中并写回。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(doc.body).toContain('第二段第100句：这是润色后的独特内容')
    expect(res.payload).toContain('"type":"doc_updated"')
  }, 30000)

  test('#fix old_text 来自参考材料(正文与参考不同格式) → 报错指引 import_reference', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    // 正文是"PDF 版",参考材料是"DOCX 版" — 同一稿件不同格式,文本有差异。
    const docId = await createDoc(app, 'PDF 版标题:Impact of two years of treatment.\n\n## Abstract\n\nPDF 版摘要内容。')

    // 参考材料是"DOCX 版"文本(纯文本引用,模拟不同格式提取结果)。
    await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'note', content: 'DOCX 版标题:Impact of two years of treatment.\n\n## Abstract\n\nDOCX 版摘要内容。', label: 'McNally_Recover_Annals ATS_2026.docx' }),
    })

    const tool = new EditDocumentTool({ userId, sessionId: `doc-${docId}` })
    // 模型从参考材料复制的 old_text(DOCX 版文本)→ 与正文(PDF 版)不匹配。
    const result = await tool.execute({ old_text: 'DOCX 版摘要内容。', new_text: '润色后的摘要。' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
    // 命中参考材料检测 → 报错指引导入该参考材料。
    expect(result.error).toContain('与参考材料「McNally_Recover_Annals ATS_2026.docx」一致')
    expect(result.error).toContain('import_reference')

    // 模型按指引导入 DOCX 覆盖正文 → 再次编辑命中。
    const imported = await tool.execute({ import_reference: 'McNally_Recover_Annals ATS_2026.docx' })
    expect(imported.success).toBe(true)
    const retry = await tool.execute({ old_text: 'DOCX 版摘要内容。', new_text: '润色后的摘要。' })
    expect(retry.success).toBe(true)
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    expect(doc.body).toContain('润色后的摘要。')
  }, 30000)

  test('#fix 工具失败不返回硬编码错误:模型看到错误后修正锚点重试,正常回答', async () => {
    const app = await getApp()
    const docId = await createDoc(app, '# 摘要\n\n原始摘要内容。\n\n# 方法\n\n研究方法内容。')
    const sessionId = `doc-${docId}`

    let round = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      round++
      if (round === 1) {
        // 第一轮:锚点错误(不在文档中)→ 工具失败。
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'edit_document', arguments: { old_text: '不存在的句子', new_text: 'x' } })}</tool_call>`)
      }
      if (round === 2) {
        // 第二轮:模型看到 tool_result 的错误后修正锚点重试 → 成功。
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'edit_document', arguments: { old_text: '原始摘要内容。', new_text: '润色后的摘要内容。', summary: '润色' } })}</tool_call>`)
      }
      return Promise.resolve('已完成摘要段润色。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '润色一下', session_id: sessionId }),
    })
    expect(res.statusCode).toBe(200)
    // 最终回复是模型的正常回答,不再是硬编码英文错误(前言不搭后语)。
    expect(res.payload).toContain('已完成摘要段润色。')
    expect(res.payload).not.toContain('I tried to use a tool')
    // 修正后的编辑成功写回。
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    expect(doc.body).toContain('润色后的摘要内容。')
    expect(doc.body).not.toContain('原始摘要内容。')
  }, 30000)
})
