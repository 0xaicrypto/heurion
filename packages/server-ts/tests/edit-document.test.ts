import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { EditDocumentTool } from '../src/tools/edit-document-tool.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../src/common/llm.js'

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
})
