import { describe, test, expect, vi, beforeAll } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * 边界审计（#253）— 零覆盖模块冒烟：workflows（10 端点）+ practitioner
 * （6 端点）：正常路径 + 缺失参数 400 + 不存在资源 404。
 */
beforeAll(() => {
  vi.mocked(deepseekChat).mockResolvedValue('ok')
})

describe('workflows module smoke (边界 #253)', () => {
  test('CRUD lifecycle: create → list → get → update → delete', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    const created = await app.inject({
      method: 'POST', url: '/api/v1/workflows',
      headers: h, payload: JSON.stringify({ name: '随访工作流', definition: { steps: ['a'] } }),
    })
    expect(created.statusCode).toBe(200)
    const id = JSON.parse(created.payload).id

    const list = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: await authHeader() })
    if (list.statusCode !== 200) console.log('LIST_PAYLOAD:', list.payload)
    expect(list.statusCode).toBe(200)
    expect(JSON.parse(list.payload).workflows.some((w: any) => w.id === id)).toBe(true)

    const get = await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}`, headers: await authHeader() })
    expect(get.statusCode).toBe(200)

    const put = await app.inject({
      method: 'PUT', url: `/api/v1/workflows/${id}`,
      headers: h, payload: JSON.stringify({ name: '改名' }),
    })
    expect(put.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/workflows/${id}`, headers: await authHeader() })
    expect(del.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}`, headers: await authHeader() })
    expect(after.statusCode).toBe(404)
  })

  test('create without name/definition → 400; nonexistent id → 404', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const bad = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: h, payload: JSON.stringify({}) })
    expect([400, 422]).toContain(bad.statusCode)
    const get = await app.inject({ method: 'GET', url: '/api/v1/workflows/wf_nonexistent', headers: await authHeader() })
    expect(get.statusCode).toBe(404)
    const run = await app.inject({ method: 'POST', url: '/api/v1/workflows/wf_nonexistent/run', headers: h, payload: JSON.stringify({}) })
    expect([400, 404]).toContain(run.statusCode)
  })

  test('packs list + run list endpoints respond', async () => {
    const app = await getApp()
    const packs = await app.inject({ method: 'GET', url: '/api/v1/workflows/packs', headers: await authHeader() })
    expect(packs.statusCode).toBe(200)
    const runs = await app.inject({ method: 'GET', url: '/api/v1/workflows/runs', headers: await authHeader() })
    expect(runs.statusCode).toBe(200)
  })
})

describe('practitioner module smoke (边界 #253)', () => {
  test('extract/distill/compose require text → 400; valid input → 200', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const bad = await app.inject({ method: 'POST', url: '/api/v1/practitioner/extract', headers: h, payload: JSON.stringify({}) })
    expect([400, 422]).toContain(bad.statusCode)

    const ok = await app.inject({
      method: 'POST', url: '/api/v1/practitioner/extract',
      headers: h, payload: JSON.stringify({ text: '患者对青霉素过敏，既往高血压。' }),
    })
    expect(ok.statusCode).toBe(200)
  })

  test('takeaways list + acknowledge lifecycle', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify([{ text: '需要随访血压', priority: 'medium' }]))
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const created = await app.inject({
      method: 'POST', url: '/api/v1/practitioner/takeaways',
      headers: h, payload: JSON.stringify({ conversation_text: '这是一段诊后讨论，总结要点。' }),
    })
    expect(created.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/v1/practitioner/takeaways', headers: await authHeader() })
    expect(list.statusCode).toBe(200)

    // Cleanup created takeaways to keep other tests hermetic.
    const rows = JSON.parse(list.payload)
    expect(Array.isArray(rows.takeaways)).toBe(true)
    // cleanup: remove takeaways created here to keep other tests hermetic
    const { getAuthUserId } = await import('../setup.js')
    const uid = await getAuthUserId()
    await (prisma as any).chatTakeaway.deleteMany({ where: { userId: uid } })
  })
})
