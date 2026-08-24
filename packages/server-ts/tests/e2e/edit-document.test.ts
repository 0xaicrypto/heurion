import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { EditDocumentTool } from '../../src/tools/edit-document-tool.js'

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
})
