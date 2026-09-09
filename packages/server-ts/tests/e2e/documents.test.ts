import { describe, test, expect, vi, beforeAll } from 'vitest'
import crypto from 'crypto'
import mammoth from 'mammoth'
import { mockAiProvider } from '../helpers/ai-mock.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekStream } from '../../src/common/llm.js'
import { getApp, authHeader } from '../setup.js'

beforeAll(() => {
  vi.mocked(deepseekStream).mockImplementation(async function* () {
    yield 'Polished clinical text.'
  })
})

describe('Documents', () => {
  test('create document with title', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Clinical Note' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeTruthy()
    expect(body.title).toBe('Clinical Note')
    expect(body.body).toBe('')
    expect(body.created_at).toBeTruthy()
  })

  test('create document without title defaults to Untitled', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).title).toBeTruthy()
  })

  test('list documents', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/docs',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.docs).toBeDefined()
    expect(Array.isArray(body.docs)).toBe(true)
  })

  test('update document body and verify', async () => {
    const app = await getApp()
    // Create
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Editable' },
    })
    const docId = JSON.parse(create.payload).id

    // Update
    const update = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Updated', body: '# Findings\nNo abnormalities detected.' },
    })
    expect(update.statusCode).toBe(200)
    const body = JSON.parse(update.payload)
    expect(body.title).toBe('Updated')
    expect(body.body).toContain('Findings')

    // Verify GET returns updated content
    const get = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(JSON.parse(get.payload).body).toContain('Findings')
  })

  test('phi scan detects SSN and names', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'PHI Test' },
    })
    const docId = JSON.parse(create.payload).id

    // Add content with PHI
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: 'Patient John Smith. MRN: 123-45-6789' },
    })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/phi-scan`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const findings = JSON.parse(res.payload).findings
    expect(findings.some((f: any) => f.kind === 'SSN')).toBe(true)
    expect(findings.some((f: any) => f.kind === 'Name')).toBe(true)
    expect(findings.every((f: any) => typeof f.suggestion === 'string' && f.suggestion.length > 0)).toBe(true)
  })

  test('save creates a snapshot when body changes', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Snapshot Test' },
    })
    const docId = JSON.parse(create.payload).id

    // First update
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: 'First draft content.' },
    })

    const res = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const snapshots = JSON.parse(res.payload).snapshots
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    // #598: 返回结构为 snapshot_id/body_preview(原 body 已调整)
    expect(snapshots[0].snapshot_id).toBeTruthy()
    expect(snapshots[0].body_preview).toBe('')
  })

  // #882: 并发保存保护(僵尸 tab)— base_sha 指纹不匹配 → 409,不静默覆盖。
  test('#882 base_sha 匹配 → 正常保存', async () => {
    const app = await getApp()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Conflict OK' },
    })).payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '版本一内容' },
    })
    const sha = crypto.createHash('sha1').update('版本一内容').digest('hex')
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '版本二内容', base_sha: sha },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).body).toBe('版本二内容')
  })

  test('#882 base_sha 不匹配(僵尸 tab)→ 409 stale_base,服务端内容不被覆盖', async () => {
    const app = await getApp()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Conflict Stale' },
    })).payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '另一窗口写入的最新内容' },
    })
    const staleSha = crypto.createHash('sha1').update('旧窗口内存里的过期正文').digest('hex')
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '旧窗口的过期编辑', base_sha: staleSha },
    })
    expect(res.statusCode).toBe(409)
    const errBody = JSON.parse(res.payload)
    expect(errBody.code).toBe('stale_base')
    const get = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}`, headers: await authHeader() })
    expect(JSON.parse(get.payload).body).toBe('另一窗口写入的最新内容')
  })

  test('#882 force 跳过检查(冲突横幅「保留我的版本」)', async () => {
    const app = await getApp()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Conflict Force' },
    })).payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '服务端当前内容' },
    })
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '用户选择保留的版本', base_sha: 'wrong', force: true },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).body).toBe('用户选择保留的版本')
  })

  // #907(服务端)/#870: 气泡 apply 端点的 base_sha 守卫 — 与 PUT #882 同
  // 语义同算法（sha1 指纹）：匹配正常落库，不匹配 409 且不写快照不覆盖。
  test('#907 气泡 apply base_sha 匹配 → 200 且快照落库', async () => {
    const app = await getApp()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Apply Sha OK' },
    })).payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '服务端正文' },
    })
    const sha = crypto.createHash('sha1').update('服务端正文').digest('hex')
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/snapshots`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '气泡替换后的正文', base_sha: sha },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).ok).toBe(true)
    const get = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}`, headers: await authHeader() })
    expect(JSON.parse(get.payload).body).toBe('气泡替换后的正文')
  })

  test('#907 气泡 apply base_sha 不匹配 → 409，服务端内容与快照数不变', async () => {
    const app = await getApp()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Apply Sha Stale' },
    })).payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '另一会话刚写入的最新正文' },
    })
    const snapsBefore = JSON.parse((await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })).payload).snapshots.length
    const staleSha = crypto.createHash('sha1').update('客户端内存里的过期正文').digest('hex')
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/snapshots`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: '基于过期正文的气泡替换', base_sha: staleSha },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.payload).error).toBe('stale_base')
    const get = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}`, headers: await authHeader() })
    expect(JSON.parse(get.payload).body).toBe('另一会话刚写入的最新正文')
    const snapsAfter = JSON.parse((await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })).payload).snapshots.length
    expect(snapsAfter).toBe(snapsBefore)
  })

  test('non-existent document returns 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/docs/nonexistent_doc',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })

  test('doc chat endpoint is deprecated (410, §15.4)', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Chat Test', body: 'Test content' },
    })
    const docId = JSON.parse(create.payload).id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/chat`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ message: 'Summarize this doc' }),
    })
    expect(res.statusCode).toBe(410)
    expect(JSON.parse(res.payload).message).toContain('agent/chat')
  })

  test('doc polish endpoint responds with SSE', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Polish Test', body: 'Need polish' },
    })
    const docId = JSON.parse(create.payload).id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/polish`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ selection: 'Need polish' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload.startsWith('data: ')).toBe(true)
  })

  test('export docx returns binary docx', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Export Test', body: 'Export me' },
    })
    const docId = JSON.parse(create.payload).id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/export`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(Buffer.from(res.payload).length).toBeGreaterThan(0)
  })

  test('export pdf returns a real PDF (magic header)', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'PDF Test' },
    })
    const docId = JSON.parse(create.payload).id
    // body 经 update 写入(create 只建标题)。
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'PDF Test', body: '# 标题\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |\n\n**bold** text' }),
    })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/export?format=pdf`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    const buf = res.rawPayload as Buffer
    // PDF magic: %PDF-1.x
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(100)
  })

  test('export docx renders markdown table as a real table, not raw pipes', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Table Test' },
    })
    const docId = JSON.parse(create.payload).id
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'Table Test',
        body: '| 药物 | 剂量 |\n| --- | --- |\n| 阿昔替尼 | 5mg |',
      }),
    })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/export?format=docx`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const buf = res.rawPayload as Buffer
    // docx zip magic: PK
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    // unzip via mammoth — table cells must be real table text, raw markdown
    // pipes must NOT leak into the document body (#fix: 之前原样导出)。
    const { value } = await mammoth.extractRawText({ buffer: buf })
    expect(value).toContain('阿昔替尼')
    expect(value).not.toContain('| --- |')
    expect(value).not.toContain('药物 | 剂量')
  })

  test('add and list references', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Ref Test' },
    })
    const docId = JSON.parse(create.payload).id

    const add = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'guideline', content: 'NCCN', label: 'NSCLC' }),
    })
    expect(add.statusCode).toBe(200)
    const refId = JSON.parse(add.payload).reference_id
    expect(refId).toBeTruthy()

    const list = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/references`,
      headers: await authHeader(),
    })
    expect(list.statusCode).toBe(200)
    const refs = JSON.parse(list.payload).references
    expect(refs.some((r: any) => r.reference_id === refId && r.content === 'NCCN')).toBe(true)
  })

  test('#930 references registration is idempotent (duplicate pick does not create a second row)', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Ref Dedup', body: 'has body' },
    })
    const docId = JSON.parse(create.payload).id

    const first = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'guideline', content: 'WHO guideline text', label: 'WHO' }),
    })
    expect(first.statusCode).toBe(200)
    const firstBody = JSON.parse(first.payload)
    expect(firstBody.created).toBe(true)

    // 重复点选同一 content → 幂等命中,不新建行。
    const second = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'guideline', content: 'WHO guideline text', label: 'WHO' }),
    })
    expect(second.statusCode).toBe(200)
    const secondBody = JSON.parse(second.payload)
    expect(secondBody.created).toBe(false)
    expect(secondBody.reference_id).toBe(firstBody.reference_id)

    // 不同 content 正常新建。
    const third = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/references`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'guideline', content: 'Other text', label: 'Other' }),
    })
    expect(JSON.parse(third.payload).created).toBe(true)

    const list = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/references`,
      headers: await authHeader(),
    })
    const refs = JSON.parse(list.payload).references
    expect(refs.filter((r: any) => r.content === 'WHO guideline text').length).toBe(1)
    expect(refs.length).toBe(2)
  })

  test('delete document removes it', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'To Delete' },
    })
    const docId = JSON.parse(create.payload).id

    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(del.statusCode).toBe(200)

    const get = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(get.statusCode).toBe(404)
  })
})

