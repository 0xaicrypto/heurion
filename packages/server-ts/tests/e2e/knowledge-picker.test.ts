import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest'
import { mockAiProvider, intentAware } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import { deepseekChat, deepseekStream } from '../../src/common/llm.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

function buildMultipart(fields: Record<string, string>, file?: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`
  const chunks: Buffer[] = []

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
    )
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

const DOC_TEXT = 'Mitochondrial ATR confers radioresistance via a PGAM5-dephosphorylation pathway in hepatocellular carcinoma.'
const DOC_NAME = 'mitochondria-atr-paper.txt'

function parseEvents(payload: string): any[] {
  return payload
    .split('\n\n')
    .flatMap((block: string) =>
      block
        .split('\n')
        .filter((line: string) => line.startsWith('data: '))
        .map((line: string) => {
          try {
            return JSON.parse(line.slice('data: '.length))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
}

/**
 * #628 — 知识库选择器必须能列出用户上传的文件(document 节点),
 * 而不仅是合成文章(article)。合成文章需 ≥3 条 7 天内确认事实,
 * 普通用户上传的文件永远不该因此从选择器消失。
 */
describe('#628 选择器列出上传文件 + 注入文档内容', () => {
  beforeAll(async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('上传文件出现在 /knowledge/picker 中(kind=document)', async () => {
    const app = await getApp()
    const { body, contentType } = buildMultipart(
      {},
      { name: DOC_NAME, mime: 'text/plain', content: Buffer.from(DOC_TEXT) },
    )
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    expect(upload.statusCode).toBe(200)
    const { file_id } = JSON.parse(upload.payload)

    const picker = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/picker?q=ATR`,
      headers: await authHeader(),
    })
    expect(picker.statusCode).toBe(200)
    const { articles } = JSON.parse(picker.payload)
    const doc = articles.find((a: any) => a.kind === 'document' && a.id === file_id)
    expect(doc).toBeTruthy()
    expect(doc.title).toContain('atr')
  })

  test('chat 携带 picked_kb_ids → 文档原文注入 system 提示词', async () => {
    const app = await getApp()
    const { body, contentType } = buildMultipart(
      {},
      { name: DOC_NAME, mime: 'text/plain', content: Buffer.from(DOC_TEXT) },
    )
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    const { file_id } = JSON.parse(upload.payload)

    let captured: any[] = []
    vi.mocked(deepseekStream).mockImplementation(async function* (messages: any[]) {
      captured = messages
      yield '好的,已阅读该论文。'
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        text: '帮我润色一下这篇论文',
        session_id: 'picker_doc_inject',
        picked_kb_ids: [file_id],
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(parseEvents(res.payload).some((e: any) => e.type === 'final_answer_chunk')).toBe(true)

    // 注入片段必须含文档标题与原文内容(文件实际文本,而非仅文件名)。
    const systemPrompt = String(captured[0]?.content || '')
    expect(systemPrompt).toContain('用户选定知识库参考')
    expect(systemPrompt).toContain(DOC_NAME)
    expect(systemPrompt).toContain('PGAM5')
  })
})
